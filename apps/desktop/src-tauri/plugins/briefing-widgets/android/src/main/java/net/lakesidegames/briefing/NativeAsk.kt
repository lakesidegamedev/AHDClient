package net.lakesidegames.briefing

import android.app.Activity
import android.content.ComponentCallbacks
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import org.json.JSONObject
import java.util.Locale

internal const val NATIVE_ASK_ORIGIN = "https://ask.lakesidegames.net"
internal const val NATIVE_ASK_LOGIN = "$NATIVE_ASK_ORIGIN/auth/login?next=%2F"
internal const val NATIVE_GAME_ORIGIN = "https://ahousedividedgame.com"
internal const val NATIVE_SANDBOX_ORIGIN = "https://sandbox.ahousedividedgame.com"
internal const val NATIVE_AUTH_ORIGIN = "https://auth.ahousedividedgame.com"
internal const val NATIVE_UNIFIED_AUTH_ORIGIN = "https://auth.lakesidegames.net"
internal const val NATIVE_AHD_LOGIN = "$NATIVE_AUTH_ORIGIN/auth/ahd?return=https%3A%2F%2Fask.lakesidegames.net%2Fauth%2Fnative%2Fcallback"
internal const val NATIVE_ASK_MAX_REDIRECTS = 10

internal val nativeAskAllowedHosts = setOf(
  "ask.lakesidegames.net",
  "auth.ahousedividedgame.com",
  "auth.lakesidegames.net",
  "ahousedividedgame.com",
  "www.ahousedividedgame.com",
  "sandbox.ahousedividedgame.com"
)

private val nativeAskSessionName = Regex(
  "^(?:ask_session|__Host-ask_session|__Host-ask_login|auth-token(?:-[A-Za-z0-9-]+)?|(?:__Secure-)?(?:authjs|next-auth)\\.session-token(?:\\.[0-9]+)?)$"
)

private val nativeAskUnifiedCookieName = Regex("^__Host-lakeside_(?:login|session)$")

/**
 * The issuer's single sign-on cookies. Kept for auth.lakesidegames.net only,
 * so Ask's sign-in redirects reuse the game login instead of asking again.
 * iOS needed the same thing (2.3.16).
 */
private val nativeIssuerSsoCookieName = Regex("^KEYCLOAK_(?:IDENTITY|SESSION)(?:_LEGACY)?$")

internal object NativeAskCookies {
  fun snapshot(): Map<String, String> {
    val manager = CookieManager.getInstance()
    val ask = filtered(manager.getCookie(NATIVE_ASK_ORIGIN), includeUnified = true)
    val auth = filtered(manager.getCookie(NATIVE_AUTH_ORIGIN))
    val unifiedAuth = filtered(manager.getCookie(NATIVE_UNIFIED_AUTH_ORIGIN), includeUnified = true)
    val issuerSso = manager.getCookie("$NATIVE_UNIFIED_AUTH_ORIGIN/realms/accounts/").orEmpty().split(';')
      .map { it.trim() }.filter { nativeIssuerSsoCookieName.matches(it.substringBefore('=')) && it.contains('=') }
      .joinToString("; ")
    val game = filtered(manager.getCookie("$NATIVE_GAME_ORIGIN/api/client/account"))
    val sandbox = filtered(manager.getCookie("$NATIVE_SANDBOX_ORIGIN/api/client/account"))
    val wwwGame = filtered(manager.getCookie("https://www.ahousedividedgame.com/api/client/account"))
    return mapOf(
      // The unified session is host-only on auth.lakesidegames.net. Ask is
      // the only other host that receives it, so migrated accounts are
      // recognized without leaking the cookie to the legacy game broker.
      "ask.lakesidegames.net" to merge(ask, unifiedAuth, includeUnified = true),
      // A host-only game cookie is not returned for the auth subdomain. The
      // broker is an explicitly trusted first-party host, so give it the same
      // auth-token cookies the game WebView already holds.
      "auth.ahousedividedgame.com" to merge(auth, game, sandbox, wwwGame),
      "auth.lakesidegames.net" to listOf(unifiedAuth, issuerSso).filter { it.isNotBlank() }.joinToString("; "),
      "ahousedividedgame.com" to game,
      "www.ahousedividedgame.com" to wwwGame
    )
  }

  private fun filtered(header: String?, includeUnified: Boolean = false): String = header.orEmpty().split(';')
    .map { it.trim() }
    .filter {
      val name = it.substringBefore('=')
      name.let(nativeAskSessionName::matches) || (includeUnified && name.let(nativeAskUnifiedCookieName::matches))
    }
    .distinctBy { it.substringBefore('=') }
    .joinToString("; ")

  private fun merge(vararg headers: String, includeUnified: Boolean = false): String {
    val merged = linkedMapOf<String, String>()
    headers.forEach { header ->
      header.split(';').map { it.trim() }.forEach { pair ->
        val name = pair.substringBefore('=')
        val allowed = nativeAskSessionName.matches(name)
          || (includeUnified && name == "__Host-lakeside_session")
        if (pair.contains('=') && allowed) merged.putIfAbsent(name, pair)
      }
    }
    return merged.values.joinToString("; ")
  }
}

/**
 * App Store 5.1.2(i) and Play's AI disclosure: name the outside AI services
 * and get permission before an Ask server question reaches them. Same key and
 * signature as the iOS sheet and the webview panel, so a provider added on
 * the server asks again.
 */
internal object NativeAskConsent {
  private const val PREFS = "ahdclient.ask"
  private const val KEY = "ahdclient.ask.aiConsent"
  const val PRIVACY_URL = "https://ask.lakesidegames.net/privacy"

  /** Used only when the Ask server predates the aiProviders field. */
  val fallback get() = listOf(
    "Meta" to T.s(R.string.ask_provider_meta),
    "Ollama" to T.s(R.string.ask_provider_ollama),
    "DeepSeek" to T.s(R.string.ask_provider_deepseek),
    "Command Code" to T.s(R.string.ask_provider_command),
    "OpenRouter" to T.s(R.string.ask_provider_openrouter),
    "Google" to T.s(R.string.ask_provider_google),
  )

  fun recipients(profile: JSONObject): List<Pair<String, String>> {
    val list = profile.optJSONArray("aiProviders") ?: return fallback
    val out = mutableListOf<Pair<String, String>>()
    for (index in 0 until list.length()) {
      val item = list.optJSONObject(index) ?: continue
      val name = item.optString("name").trim()
      if (name.isNotEmpty()) out += name to item.optString("detail")
    }
    return out.ifEmpty { fallback }
  }

  fun signature(recipients: List<Pair<String, String>>): String =
    recipients.map { "${it.first}|${it.second}" }.sorted().joinToString("\n")

  fun granted(context: Context, recipients: List<Pair<String, String>>): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) == signature(recipients)

  fun grant(context: Context, recipients: List<Pair<String, String>>) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, signature(recipients)).apply()
  }

  fun withdraw(context: Context) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).apply()
  }
}

/**
 * Presents the native Ask sheet over the game WebView. The sheet is rebuilt
 * on demand; the session behind it lives for the whole process.
 */
object NativeAskController {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var activity: Activity? = null
  private var webView: WebView? = null
  private var sheet: AskSheet? = null
  private var sheetPreview = false
  private var photoPicker: ActivityResultLauncher<PickVisualMediaRequest>? = null
  private var configWatcher: ComponentCallbacks? = null

  fun attach(activity: Activity, webView: WebView) {
    this.activity = activity
    this.webView = webView
    T.init(activity); T.sync()
  }

  fun present() = show(preview = false)

  /**
   * `ahdclient://ask?preview=1`: the same sheet with a canned conversation
   * and no network, for design review screenshots.
   */
  fun presentPreview() = show(preview = true)

  private fun show(preview: Boolean) {
    mainHandler.post {
      NativeSafety.run("native Ask presentation") {
        T.sync()
        val host = activity ?: webView?.context?.findActivity() ?: return@run
        if (host.isFinishing) return@run
        val current = sheet
        if (current != null && current.dialog.isShowing) {
          // The preview link also reaches the app's generic deep link handler,
          // which asks for the live sheet; the preview stays put.
          if (sheetPreview == preview || sheetPreview) return@run
          current.dismiss()
        }
        val session = if (preview) AskStore.preview(host) else AskStore.live(host) { NativeAskCookies.snapshot() }
        val next = AskSheet(host, session, NativeAskHost)
        sheet = next
        sheetPreview = preview
        registerPhotoPicker(host)
        watchConfiguration(host)
        next.show()
      }
    }
  }

  // ---- AskSheetHost ------------------------------------------------------

  internal fun linkAccount() {
    NativeSafety.run("Ask account link") {
      sheet?.dismiss()
      mainHandler.post { NativeSafety.run("Ask account link load") { webView?.loadUrl("$NATIVE_GAME_ORIGIN/client/link") } }
    }
  }

  /**
   * Game links open in the app's WebView and close the sheet. Everything
   * else goes to the browser, posted so the tap returns before the system
   * switches apps.
   */
  internal fun openLink(url: String) {
    mainHandler.post {
      NativeSafety.run("Ask link") {
        val view = webView
        val target = resolveGameLink(url, view?.url)
        if (target != null && view != null) {
          sheet?.dismiss()
          view.loadUrl(target)
          return@run
        }
        val uri = Uri.parse(if (url.startsWith("/")) "$NATIVE_GAME_ORIGIN$url" else url)
        if (uri.scheme != "https" && uri.scheme != "http") return@run
        val host = activity ?: return@run
        host.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
      }
    }
  }

  internal fun pickPhoto(): Boolean = NativeSafety.get("Ask photo picker", false) {
    val picker = photoPicker ?: return@get false
    picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
    true
  }

  internal fun rebuild() {
    val wasPreview = sheetPreview
    sheet?.dismiss()
    if (wasPreview) presentPreview() else present()
  }

  internal fun dismissed(sheet: AskSheet) {
    if (this.sheet !== sheet) return
    this.sheet = null
    NativeSafety.run("Ask photo picker release") { photoPicker?.unregister() }
    photoPicker = null
    val watcher = configWatcher
    configWatcher = null
    if (watcher != null) NativeSafety.run("Ask config unwatch") { activity?.unregisterComponentCallbacks(watcher) }
  }

  // ---- Plumbing ----------------------------------------------------------

  /**
   * The Photo Picker result arrives through the activity's result registry.
   * Registered per sheet and released on dismiss, so the plugin needs no
   * hooks in MainActivity.
   */
  private fun registerPhotoPicker(host: Activity) {
    if (photoPicker != null) return
    val component = host as? ComponentActivity ?: return
    photoPicker = NativeSafety.get("Ask photo picker register", null as ActivityResultLauncher<PickVisualMediaRequest>?) {
      component.activityResultRegistry.register("ahdclient.ask.photo", ActivityResultContracts.PickVisualMedia()) { uri ->
        NativeSafety.run("Ask photo result") { sheet?.onPhotoPicked(uri) }
      }
    }
  }

  /** The activity handles rotation and dark mode itself, so the sheet follows along. */
  private fun watchConfiguration(host: Activity) {
    if (configWatcher != null) return
    val watcher = object : ComponentCallbacks {
      override fun onConfigurationChanged(newConfig: Configuration) {
        NativeSafety.run("Ask configuration") { sheet?.onConfigurationChanged(newConfig) }
      }
      @Deprecated("Deprecated in Java")
      override fun onLowMemory() {}
    }
    host.registerComponentCallbacks(watcher)
    configWatcher = watcher
  }
}

private val nativeGameHosts = setOf("ahousedividedgame.com", "www.ahousedividedgame.com", "sandbox.ahousedividedgame.com")

/** The in-app URL for a game link, or null when it belongs in the browser. */
internal fun resolveGameLink(url: String, currentPage: String?): String? {
  if (url.startsWith("/") && !url.startsWith("//")) {
    // Stay on the sandbox when the player is playing there.
    val onSandbox = runCatching { Uri.parse(currentPage).host == "sandbox.ahousedividedgame.com" }.getOrDefault(false)
    return (if (onSandbox) NATIVE_SANDBOX_ORIGIN else NATIVE_GAME_ORIGIN) + url
  }
  val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return null
  if (uri.scheme != "https") return null
  val host = uri.host?.lowercase(Locale.US) ?: return null
  return if (host in nativeGameHosts) url else null
}

private fun Context.findActivity(): Activity? {
  var current: Context = this
  while (current is ContextWrapper) {
    if (current is Activity) return current
    current = current.baseContext
  }
  return current as? Activity
}

/** The sheet's view of the controller, kept internal so the public API stays present/presentPreview. */
private object NativeAskHost : AskSheetHost {
  override fun linkAccount() = NativeAskController.linkAccount()
  override fun openLink(url: String) = NativeAskController.openLink(url)
  override fun pickPhoto(): Boolean = NativeAskController.pickPhoto()
  override fun rebuild() = NativeAskController.rebuild()
  override fun dismissed(sheet: AskSheet) = NativeAskController.dismissed(sheet)
}
