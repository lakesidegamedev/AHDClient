package net.lakesidegames.ahdclient

import android.os.Bundle
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.WebView
import android.graphics.Color
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var gameView: WebView? = null
  private val widgetHandler = Handler(Looper.getMainLooper())
  private var widgetNavigation: Runnable? = null

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    CompanionSafety.run("widget deep link") { openWidgetPage() }
  }

  override fun onResume() {
    super.onResume()
    CompanionSafety.run("widget deep link") { openWidgetPage() }
    refreshWidgetsSafely()
  }

  override fun onPause() {
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
    if (uri.scheme != "ahdclient") return
    if (uri.host == "ask") {
      // Design review only: the sheet with a canned chat and no network.
      openAskWhenReady(preview = uri.encodedQuery == "preview=1")
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
      // Keep the page out from under the system bars and the keyboard. Both the
      // launcher and the site draw their own headers and the site pins its
      // character bar to the bottom, so nothing may sit behind either bar.
      // Margins, not padding: a WebView keeps drawing its content under its
      // own padding, which put the bottom bar under the three-button
      // navigation (ticket 1462).
      ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
        val bars = insets.getInsets(
          WindowInsetsCompat.Type.systemBars() or
            WindowInsetsCompat.Type.displayCutout() or
            WindowInsetsCompat.Type.ime()
        )
        (view.layoutParams as? ViewGroup.MarginLayoutParams)?.let { params ->
          if (params.leftMargin != bars.left || params.topMargin != bars.top ||
            params.rightMargin != bars.right || params.bottomMargin != bars.bottom) {
            params.setMargins(bars.left, bars.top, bars.right, bars.bottom)
            view.layoutParams = params
          }
          view.setPadding(0, 0, 0, 0)
        } ?: view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
        WindowInsetsCompat.CONSUMED
      }
      // The WebView can attach after the window dispatched its first insets.
      ViewCompat.requestApplyInsets(webView)
    }
  }

}
