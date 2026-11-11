package net.lakesidegames.ahdclient

import android.os.Bundle
import android.content.Intent
import android.content.res.Configuration
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.WebView
import android.graphics.Color
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var gameView: WebView? = null
  private val widgetHandler = Handler(Looper.getMainLooper())
  private var widgetNavigation: Runnable? = null
  private var nav: NativeNav? = null
  private var dockBack: OnBackPressedCallback? = null
  private var pendingDockPreview: String? = null
  private var permissionAnswer: ((Boolean) -> Unit)? = null
  private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    val answer = permissionAnswer
    permissionAnswer = null
    if (answer != null) CompanionSafety.run("notification permission result") { answer(granted) }
  }

  /** The system's notification prompt (Android 13 and later); [answer] gets the player's choice. */
  fun requestNotificationPermission(answer: (Boolean) -> Unit) {
    permissionAnswer = answer
    if (!CompanionSafety.run("notification permission request") { notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS) }) permissionAnswer = null
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    CompanionSafety.run("widget deep link") { openWidgetPage() }
  }

  // The values the dock was built for. The activity's own configuration is already the new one
  // when the callback runs, so the previous values are kept here.
  private var shownScale = 0f
  private var shownDensity = 0
  private var shownDirection = -1

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    val changed = shownScale != newConfig.fontScale || shownDensity != newConfig.densityDpi ||
      shownDirection != newConfig.layoutDirection
    shownScale = newConfig.fontScale
    shownDensity = newConfig.densityDpi
    shownDirection = newConfig.layoutDirection
    if (changed) CompanionSafety.run("dock rebuild") { nav?.rebuildDock() }
    CompanionSafety.run("dock window size") { nav?.windowChanged() }
  }

  override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
    if (event.action == android.view.KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
      val action = DockShortcuts.resolve(event.keyCode, event.isCtrlPressed, event.isAltPressed, event.isShiftPressed)
      var handled = false
      if (action != null) CompanionSafety.run("keyboard shortcut") { handled = nav?.shortcut(action) == true }
      if (handled) return true
    }
    return super.dispatchKeyEvent(event)
  }

  override fun onProvideKeyboardShortcuts(
    data: MutableList<android.view.KeyboardShortcutGroup>, menu: android.view.Menu?, deviceId: Int,
  ) {
    super.onProvideKeyboardShortcuts(data, menu, deviceId)
    CompanionSafety.run("keyboard shortcut help") {
      val ctrl = android.view.KeyEvent.META_CTRL_ON
      val items = ArrayList<android.view.KeyboardShortcutInfo>()
      for (index in 0 until DockShortcuts.TAB_COUNT) {
        items.add(android.view.KeyboardShortcutInfo(Texts.s(R.string.shortcut_tab, index + 1), android.view.KeyEvent.KEYCODE_1 + index, ctrl))
      }
      items.add(android.view.KeyboardShortcutInfo(Texts.s(R.string.shortcut_ask), android.view.KeyEvent.KEYCODE_K, ctrl))
      items.add(android.view.KeyboardShortcutInfo(Texts.s(R.string.shortcut_reload), android.view.KeyEvent.KEYCODE_R, ctrl))
      items.add(android.view.KeyboardShortcutInfo(Texts.s(R.string.shortcut_back), android.view.KeyEvent.KEYCODE_DPAD_LEFT, android.view.KeyEvent.META_ALT_ON))
      data.add(android.view.KeyboardShortcutGroup(Texts.s(R.string.shortcuts_group), items))
    }  }

  override fun onResume() {
    super.onResume()
    CompanionSafety.run("widget deep link") { openWidgetPage() }
    CompanionSafety.run("tab bar resume") { nav?.resume() }
    AppUpdate.checkIfDue(this)
    refreshWidgetsSafely()
  }

  override fun onPause() {
    CompanionSafety.run("tab bar pause") { nav?.pause() }
    refreshWidgetsSafely()
    super.onPause()
  }

  private fun refreshWidgetsSafely() {
    // Widgets are an optional companion. A missing provider or a device-level
    // JobScheduler failure must not prevent the main WebView from launching.
    CompanionSafety.run("widget render") {
      BriefingWidgets.render(this)
    }
    CompanionSafety.run("widget schedule") {
      BriefingWidgets.schedule(this)
    }
  }

  private fun openWidgetPage() {
    val uri = intent?.data ?: return
    if (isDiscordCallback(uri)) {
      loadWhenReady(uri.toString())
      return
    }
    if (uri.scheme == "https") {
      // A shared game link (verified App Link). Signed-out players stay on the launcher;
      // sign-in is never started from a link.
      intent.data = null
      val linked = AppLinks.pathFor(uri.scheme, uri.host, uri.encodedPath, uri.encodedQuery) ?: return
      if (BriefingWidgets.identity() == null) return
      loadWhenReady(BriefingWidgets.ORIGIN + linked)
      return
    }
    if (uri.scheme != "ahdclient") return
    if (uri.host == "ask") {
      // Design review only: the sheet with a canned chat and no network.
      openAskWhenReady(preview = uri.encodedQuery == "preview=1")
      return
    }
    if (uri.host == "widgets") {
      // Design review only: the widget picker samples. Same debug and CI gate as the dock preview.
      intent.data = null
      if (!(BuildConfig.DEBUG || BuildConfig.DOCK_PREVIEW)) return
      CompanionSafety.run("widget preview") { WidgetPreviewScreen.show(this) }
      return
    }
    if (uri.host == "dock") {
      // Design review only: the dock with canned figures and no network. Debug and CI
      // builds only; a store build ignores the link, so no page or app can fake a dock.
      intent.data = null
      if (!(BuildConfig.DEBUG || BuildConfig.DOCK_PREVIEW)) return
      pendingDockPreview = uri.getQueryParameter("preview")?.takeIf { it in setOf("collapsed", "expanded", "state", "more", "signedout", "launcher", "alerts", "reminder", "off") } ?: "collapsed"
      applyDockPreview()
      return
    }
    val path = CompanionSafety.get("widget deep link lookup", null as String?) {
      when (uri.host) {
        "inbox" -> "/notifications"
        "briefing" -> BriefingWidgets.page(this, uri.path?.removePrefix("/") ?: "")
        // Push alerts and widget rows: one page on the game site.
        "page" -> BriefingWidgets.gamePath((uri.encodedPath ?: "") + (uri.encodedQuery?.let { "?$it" } ?: ""))
        else -> null
      }
    } ?: return
    widgetNavigation?.let { widgetHandler.removeCallbacks(it) }
    // Wait for Tauri's initial local page so it cannot overwrite a cold-start
    // widget navigation. The retry is bounded and only loads our fixed origin.
    var remaining = 100
    val navigate = object : Runnable {
      override fun run() {
        CompanionSafety.run("widget deep link navigation") {
          val view = gameView
          if (view != null && !view.url.isNullOrBlank() && view.url != "about:blank") {
            intent.data = null
            view.loadUrl(BriefingWidgets.ORIGIN + path)
            widgetNavigation = null
          } else if (--remaining > 0) widgetHandler.postDelayed(this, 100)
        }
      }
    }
    widgetNavigation = navigate
    widgetHandler.post(navigate)
  }

  /** Shows a requested dock preview once the dock is on screen; until then the request waits. */
  private fun applyDockPreview() {
    val mode = pendingDockPreview ?: return
    val bar = nav ?: return
    if (bar.dock.parent == null) return
    pendingDockPreview = null
    CompanionSafety.run("dock preview") { bar.preview(mode) }
  }

  /** Back closes an open status sheet before it does anything else. */
  fun onDockExpanded(expanded: Boolean) {
    dockBack?.isEnabled = expanded
  }

  /**
   * The Discord sign-in callback, delivered by the verified App Link after the
   * player authorized in the Discord app. Loading it in our WebView finishes
   * sign-in here: the WebView holds the state cookie the login request set.
   */
  private fun isDiscordCallback(uri: android.net.Uri): Boolean =
    uri.scheme == "https" &&
      // The sandbox is in the Android app for supporters, with its own sign-in.
      (uri.host == "ahousedividedgame.com" || uri.host == "www.ahousedividedgame.com" ||
        uri.host == "sandbox.ahousedividedgame.com") &&
      uri.path == "/api/auth/discord/callback"

  private fun loadWhenReady(url: String) {
    widgetNavigation?.let { widgetHandler.removeCallbacks(it) }
    var remaining = 100
    val navigate = object : Runnable {
      override fun run() {
        CompanionSafety.run("Discord sign-in return") {
          val view = gameView
          if (view != null && !view.url.isNullOrBlank() && view.url != "about:blank") {
            intent.data = null
            view.loadUrl(url)
            widgetNavigation = null
          } else if (--remaining > 0) widgetHandler.postDelayed(this, 100)
        }
      }
    }
    widgetNavigation = navigate
    widgetHandler.post(navigate)
  }

  /**
   * `ahdclient://ask` opens the native Ask sheet. The page navigates to the
   * same link the site's Ask buttons use, so the app's navigation policy
   * presents it exactly as a tap would.
   */
  private fun openAskWhenReady(preview: Boolean = false) {
    widgetNavigation?.let { widgetHandler.removeCallbacks(it) }
    var remaining = 100
    val navigate = object : Runnable {
      override fun run() {
        CompanionSafety.run("Ask deep link") {
          val view = gameView
          if (view != null && !view.url.isNullOrBlank() && view.url != "about:blank") {
            intent.data = null
            if (preview) net.lakesidegames.briefing.NativeAskController.presentPreview()
            else view.evaluateJavascript("location.href='ahdclient://ask'", null)
            widgetNavigation = null
          } else if (--remaining > 0) widgetHandler.postDelayed(this, 100)
        }
      }
    }
    widgetNavigation = navigate
    widgetHandler.post(navigate)
  }

  override fun onDestroy() {
    CompanionSafety.run("widget navigation cleanup") {
      widgetNavigation?.let { widgetHandler.removeCallbacks(it) }
    }
    super.onDestroy()
  }
  override fun onCreate(savedInstanceState: Bundle?) {
    Texts.init(this)
    // Edge-to-edge is cosmetic. Some old vendor builds throw while applying
    // it, and that must not turn a launcher startup into an app crash.
    // The app is always dark, so both bars use the dark style whatever the
    // phone's theme: the default followed light mode and laid a pale scrim
    // behind the three-button navigation, under the game's dark status bar.
    CompanionSafety.run("edge-to-edge setup") {
      enableEdgeToEdge(
        statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      )
    }
    super.onCreate(savedInstanceState)
    resources.configuration.let { shownScale = it.fontScale; shownDensity = it.densityDpi; shownDirection = it.layoutDirection }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    gameView = webView
    CompanionSafety.run("mobile WebView setup") {
      openWidgetPage()
      // Appended, never replaced: the site keys ad slots, consent prompts and
      // the cookie banner off this marker while sign-in providers still see a
      // normal Android WebView.
      webView.settings.userAgentString =
        webView.settings.userAgentString + " AHDClient-Mobile/" + BuildConfig.VERSION_NAME
    }
    // The dock is optional chrome: if it cannot attach, the WebView still
    // fills the window above the system bars as before.
    CompanionSafety.run("tab bar setup") {
      nav = NativeNav(this, webView).also { bar ->
        // The game is told this build carries the dock (user agent marker) by
        // NativeNav.attach, once the dock is really on screen: if attach bails,
        // the page keeps its own status bar and menu.
        // Added after Tauri's own back handler, so it is asked first.
        dockBack = object : OnBackPressedCallback(false) {
          override fun handleOnBackPressed() { nav?.dock?.closeSheet() }
        }.also { onBackPressedDispatcher.addCallback(this, it) }
        webView.post {
          CompanionSafety.run("tab bar attach") { bar.attach(); bar.resume(); applyDockPreview() }
        }
      }
    }
    CompanionSafety.run("mobile WebView insets") {
      // Keep the page out from under the system bars, the tab bar and the
      // keyboard. Both the launcher and the site draw their own headers and
      // the site pins its character bar to the bottom, so nothing may sit
      // behind any of them. Margins, not padding: a WebView keeps drawing its
      // content under its own padding, which put the bottom bar under the
      // three-button navigation (ticket 1462). One listener lays out both the
      // WebView and the tab bar, so older Androids, which stop handing insets
      // to siblings once one view consumes them, still place the bar.
      ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
        val bars = insets.getInsets(
          WindowInsetsCompat.Type.systemBars() or
            WindowInsetsCompat.Type.displayCutout()
        )
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        val keyboard = ime.bottom > bars.bottom
        val tabs = nav?.let { bar ->
          CompanionSafety.get("dock layout", 0) { bar.layout(bars.left, bars.top, bars.right, bars.bottom, keyboard) }
        } ?: 0
        val bottom = when {
          keyboard -> ime.bottom
          tabs > 0 -> tabs
          else -> bars.bottom
        }
        (view.layoutParams as? ViewGroup.MarginLayoutParams)?.let { params ->
          if (params.leftMargin != bars.left || params.topMargin != bars.top ||
            params.rightMargin != bars.right || params.bottomMargin != bottom) {
            params.setMargins(bars.left, bars.top, bars.right, bottom)
            view.layoutParams = params
          }
          view.setPadding(0, 0, 0, 0)
        } ?: view.setPadding(bars.left, bars.top, bars.right, bottom)
        WindowInsetsCompat.CONSUMED
      }
      // The WebView can attach after the window dispatched its first insets.
      ViewCompat.requestApplyInsets(webView)
    }
  }

}
