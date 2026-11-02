package net.lakesidegames.ahdclient

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * The phone dock: Game, Briefing, Inbox, Ask and More, plus the status strip
 * (see NativeDock), in place of the floating AHD button the site pages used to
 * carry. One WebView still shows everything; each tab is a page in it (or the
 * native Ask sheet), and the dock follows whatever page the WebView is on,
 * however the player got there.
 *
 * This class owns what the dock shows (which tab, the unread badge, the
 * status figures and when they refresh) and what a tap does. NativeDock only
 * draws and animates.
 */
class NativeNav(private val activity: MainActivity, private val webView: WebView) : NativeDock.Listener {
  enum class Destination(val id: Int, val label: String, val icon: Int) {
    GAME(1, "Game", R.drawable.ic_nav_game),
    BRIEFING(2, "Briefing", R.drawable.ic_nav_briefing),
    INBOX(3, "Inbox", R.drawable.ic_nav_inbox),
    ASK(4, "Ask", R.drawable.ic_nav_ask),
    MORE(5, "More", R.drawable.ic_nav_more),
  }

  companion object {
    private const val LAUNCHER = "http://tauri.localhost/"
    private const val SITE_HOSTS = "ahousedividedgame.com|www.ahousedividedgame.com|sandbox.ahousedividedgame.com"

    /** The timer, in ms. Foreground, tab return and turn events ask sooner (see FORCED_GAP_MS). */
    private const val STATUS_INTERVAL_MS = 120_000L

    /** Quiet periods between status fetches: the timer never goes under a minute. */
    private const val STATUS_GAP_MS = 60_000L
    private const val FORCED_GAP_MS = 5_000L

    /** Gives the game a moment to finish writing a turn before the figures are read. */
    private const val TURN_SETTLE_MS = 1_500L

    /**
     * Forwards the game's `ahd:turn-complete` event to native code. Guarded so
     * running it twice on one page (document start, then at attach) adds one listener.
     */
    private const val TURN_BRIDGE =
      "(function(){if(window.__ahdDockBridge)return;window.__ahdDockBridge=1;" +
        "window.addEventListener('ahd:turn-complete',function(){try{ahdDock.postMessage('turn-complete')}catch(e){}});})();"

    /** Which tab a WebView address belongs to. Ask never is: it is a sheet. */
    fun destinationFor(url: String?): Destination? {
      val uri = url?.let { Uri.parse(it) } ?: return null
      val host = uri.host ?: return null
      if (uri.scheme == "http" && host == "tauri.localhost") {
        // The launcher marks its Briefing screen with #briefing (App.tsx).
        return if (uri.fragment == "briefing" || uri.getQueryParameter("screen") == "briefing") Destination.BRIEFING
        else Destination.MORE
      }
      if (uri.scheme != "https" || host !in SITE_HOSTS.split('|')) return null
      return if (uri.path?.trimEnd('/') == "/notifications") Destination.INBOX else Destination.GAME
    }
  }

  val dock = NativeDock(activity, this)
  private val handler = Handler(Looper.getMainLooper())
  private var lastGameUrl: String? = null
  private var current: Destination? = null
  private var inboxVisitedAt = 0L
  private var ticks = 0
  private var fetching = false
  private var lastFetchAt = 0L
  private var previewing = false
  private val follow = object : Runnable {
    override fun run() {
      CompanionSafety.run("dock follow") {
        followPage()
        if (ticks++ % 20 == 0) showStatus()
      }
      handler.postDelayed(this, 500)
    }
  }
  private val fetch = object : Runnable {
    override fun run() {
      CompanionSafety.run("dock status fetch") { requestRefresh(force = false) }
      handler.postDelayed(this, STATUS_INTERVAL_MS)
    }
  }

  fun attach() {
    val content = activity.findViewById<FrameLayout>(android.R.id.content) ?: return
    if (dock.parent == null) {
      // A transparent overlay: only the dock surface takes touches.
      content.addView(dock, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT, Gravity.BOTTOM))
      // Silences the floating AHD button mobile.rs keeps as a fallback for a
      // bar that never attached. A WebView too old for document-start scripts
      // shows both, which still leaves every action reachable.
      val flag = "window.__ahdclientNativeTabs = true;"
      val supportsScripts = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
      if (supportsScripts) {
        // The launcher reads the flag too, to drop its own Briefing and Ask
        // buttons while the dock shows them.
        WebViewCompat.addDocumentStartJavaScript(
          webView, flag, SITE_HOSTS.split('|').map { "https://$it" }.toSet() + "http://tauri.localhost"
        )
      }
      webView.evaluateJavascript(flag, null)
      CompanionSafety.run("dock turn bridge") { installTurnBridge(supportsScripts) }
    }
    ViewCompat.requestApplyInsets(webView)
  }

  /**
   * The game page tells native code when a turn finished so the figures refresh
   * at once. A message listener, not a JavaScript interface: it answers only
   * to the game's own https pages.
   */
  private fun installTurnBridge(supportsScripts: Boolean) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
    val origins = SITE_HOSTS.split('|').map { "https://$it" }.toSet()
    WebViewCompat.addWebMessageListener(webView, "ahdDock", origins) { _, message, _, isMainFrame, _ ->
      if (isMainFrame && message.data == "turn-complete") {
        handler.postDelayed({ CompanionSafety.run("dock turn refresh") { requestRefresh(force = true) } }, TURN_SETTLE_MS)
      }
    }
    if (supportsScripts) WebViewCompat.addDocumentStartJavaScript(webView, TURN_BRIDGE, origins)
    webView.evaluateJavascript(TURN_BRIDGE, null)
  }

  fun resume() {
    handler.removeCallbacks(follow)
    handler.removeCallbacks(fetch)
    handler.post(follow)
    // Coming back to the app is a reason to look again, without waiting for the timer.
    handler.post { CompanionSafety.run("dock foreground refresh") { requestRefresh(force = true) } }
    handler.postDelayed(fetch, STATUS_INTERVAL_MS)
    dock.resume()
  }

  fun pause() {
    handler.removeCallbacks(follow)
    handler.removeCallbacks(fetch)
    dock.pause()
  }

  /** Called from the WebView's insets listener; returns the dock's collapsed height. */
  fun layout(left: Int, right: Int, bottom: Int, keyboard: Boolean): Int {
    if (dock.parent == null) return 0
    return dock.fit(left, right, bottom, keyboard)
  }

  /**
   * `ahdclient://dock?preview=collapsed|expanded|off` shows the dock with
   * canned figures and no network, so a reviewer or CI can capture both states.
   * A tab tap ends it.
   */
  fun preview(mode: String) {
    if (mode == "off") {
      previewing = false
      dock.setExpanded(false, animate = false)
      showStatus()
      return
    }
    previewing = true
    dock.setStatus(DockStatus.preview(System.currentTimeMillis()))
    dock.setInboxBadge(3)
    dock.setStripAllowed(true)
    dock.showSelected(Destination.GAME, animate = false)
    dock.setExpanded(mode == "expanded", animate = false)
  }

  // ---- NativeDock.Listener ---------------------------------------------------

  override fun onTab(tab: Destination, again: Boolean) {
    previewing = false
    CompanionSafety.run("dock ${tab.label}") { open(tab, again) }
  }

  override fun onOpenPath(path: String) {
    CompanionSafety.run("dock status link") {
      val safe = BriefingWidgets.gamePath(path) ?: return@run
      webView.loadUrl(siteOrigin() + safe)
    }
  }

  override fun onCollapsedHeightChanged() {
    ViewCompat.requestApplyInsets(webView)
  }

  override fun onExpandedChanged(expanded: Boolean) {
    activity.onDockExpanded(expanded)
  }

  override fun onTurnDue() {
    if (!previewing) requestRefresh(force = true)
  }

  // ---- pages -----------------------------------------------------------------

  private fun open(tab: Destination, again: Boolean) {
    val site = siteOrigin()
    when (tab) {
      // Back to the page the player was last reading; tapping Game again
      // goes to the site's home page.
      Destination.GAME -> webView.loadUrl(if (again) "$site/" else lastGameUrl ?: "$site/")
      Destination.BRIEFING -> if (!again) webView.loadUrl("$LAUNCHER?screen=briefing")
      Destination.INBOX -> webView.loadUrl("$site/notifications")
      Destination.ASK -> net.lakesidegames.briefing.NativeAskController.present()
      Destination.MORE -> if (!again || current != Destination.MORE) webView.loadUrl(LAUNCHER)
    }
  }

  /** The sandbox keeps its own Game and Inbox pages while the player is in it. */
  private fun siteOrigin(): String {
    val host = webView.url?.let { Uri.parse(it).host }
    return if (host == "sandbox.ahousedividedgame.com") "https://$host" else BriefingWidgets.ORIGIN
  }

  private fun followPage() {
    val url = webView.url
    val tab = destinationFor(url) ?: return
    if (tab == Destination.GAME) lastGameUrl = url
    if (tab == current) return
    // The player just read the inbox, or came back to the game: look again.
    if (current == Destination.INBOX || (tab == Destination.GAME && current != null)) {
      handler.post { CompanionSafety.run("dock status fetch") { requestRefresh(force = true) } }
    }
    if (tab == Destination.INBOX) inboxVisitedAt = System.currentTimeMillis()
    current = tab
    if (!previewing) dock.showSelected(tab)
    showStatus()
  }

  // ---- status ------------------------------------------------------------------

  /**
   * Fetch through the widgets' own request (same cookie, same cache), then
   * redraw from the cache. Never on the UI thread, never twice at once, and
   * the timer never goes under a minute.
   */
  private fun requestRefresh(force: Boolean) {
    if (previewing || fetching) return
    val now = android.os.SystemClock.elapsedRealtime()
    val gap = if (force) FORCED_GAP_MS else STATUS_GAP_MS
    if (lastFetchAt != 0L && now - lastFetchAt < gap) return
    fetching = true
    lastFetchAt = now
    val context = activity.applicationContext
    Thread {
      try {
        BriefingWidgets.refresh(context)
      } finally {
        handler.post {
          fetching = false
          CompanionSafety.run("dock status show") { showStatus() }
        }
      }
    }.start()
  }

  /** Redraws the dock from the last cached snapshot. Cheap; safe to call often. */
  private fun showStatus() {
    if (previewing) return
    val data = BriefingWidgets.snapshot(activity)
    val status = DockStatus.from(data)
    dock.setStatus(status)
    dock.setStripAllowed(current == Destination.GAME || current == Destination.INBOX)
    // The Inbox badge: hidden on the Inbox itself and until a snapshot newer
    // than the last visit arrives.
    val inbox = BriefingWidgets.inbox(activity)
    val unread = inbox?.first ?: 0
    val fresh = (inbox?.second ?: 0L) > inboxVisitedAt
    dock.setInboxBadge(if (unread > 0 && fresh && current != Destination.INBOX) unread else 0)
  }
}
