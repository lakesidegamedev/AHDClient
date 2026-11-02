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
 * The phone dock, in place of the floating AHD button the site pages used to
 * carry: the game's own tabs (Company, State, Nation, Actions, More) as the
 * game describes them at /api/mobile-dock, plus the status strip (see
 * NativeDock). Signed out, offline or against an older game it falls back to
 * Game, Briefing, Ask and More. One WebView still shows everything; a tab is a
 * page in it, a menu sheet, or the native Ask sheet, and the dock follows
 * whatever page the WebView is on, however the player got there.
 *
 * This class owns what the dock shows (the model, which tab, the unread badge,
 * the status figures and when they refresh) and what a tap does. NativeDock
 * only draws and animates.
 */
class NativeNav(private val activity: MainActivity, private val webView: WebView) : NativeDock.Listener {

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

    /** What the WebView is showing. Ask never is: it is a sheet. */
    enum class Page { LAUNCHER, BRIEFING, SITE }

    fun pageOf(url: String?): Page? {
      val uri = url?.let { Uri.parse(it) } ?: return null
      val host = uri.host ?: return null
      if (uri.scheme == "http" && host == "tauri.localhost") {
        // The launcher marks its Briefing screen with #briefing (App.tsx).
        return if (uri.fragment == "briefing" || uri.getQueryParameter("screen") == "briefing") Page.BRIEFING
        else Page.LAUNCHER
      }
      if (uri.scheme != "https" || host !in SITE_HOSTS.split('|')) return null
      return Page.SITE
    }

    /** The first path segment ("state" for /state/NY), the unit the model refreshes on. */
    fun sectionOf(path: String?): String? = path?.trim('/')?.substringBefore('/')?.takeIf { it.isNotEmpty() }
  }

  val dock = NativeDock(activity, this)
  private val handler = Handler(Looper.getMainLooper())
  private var lastGameUrl: String? = null
  private var page: Page? = null
  private var tabId: String? = null
  private var onInbox = false
  private var section: String? = null
  private var inboxVisitedAt = 0L
  private var ticks = 0
  private var fetching = false
  private var lastFetchAt = 0L
  private var previewing = false

  /** The game's model (without the app section) for the signed-in account, or null for the fallback. */
  private var gameModel: DockModel? = null
  private var identity: String? = null
  private val follow = object : Runnable {
    override fun run() {
      CompanionSafety.run("dock follow") {
        // Every 10 seconds: a sign-in, sign-out or account switch changes the tabs.
        if (ticks % 20 == 0) checkAccount()
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
    CompanionSafety.run("dock model cache") { checkAccount() }
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
  fun layout(left: Int, top: Int, right: Int, bottom: Int, keyboard: Boolean): Int {
    if (dock.parent == null) return 0
    return dock.fit(left, top, right, bottom, keyboard)
  }

  /**
   * `ahdclient://dock?preview=collapsed|expanded|state|more|signedout|off`
   * shows the dock with the canned game model and canned figures, no network,
   * so a reviewer or CI can capture each state. A tab tap ends it.
   */
  fun preview(mode: String) {
    if (mode == "off") {
      previewing = false
      dock.closeSheet(animate = false)
      applyModel()
      showStatus()
      return
    }
    previewing = true
    dock.closeSheet(animate = false)
    if (mode == "signedout") {
      dock.setModel(DockModel.fallback(false))
      dock.setInboxBadge(0)
      dock.setStatus(null)
      dock.setStripAllowed(false)
      dock.showSelected("app-game", animate = false)
      return
    }
    val fixture = DockModel.fixture()
    dock.setModel(fixture)
    dock.setStatus(DockStatus.preview(System.currentTimeMillis()))
    dock.setInboxBadge(3)
    dock.setStripAllowed(true)
    dock.showSelected("state", animate = false)
    when (mode) {
      "expanded" -> dock.setExpanded(true, animate = false)
      "state" -> dock.openMenu("state", animate = false)
      "more" -> dock.openMenu("more", animate = false)
    }
  }

  // ---- NativeDock.Listener ---------------------------------------------------

  override fun onTab(tab: DockTab, again: Boolean) {
    endPreview()
    CompanionSafety.run("dock ${tab.label}") {
      val site = siteOrigin()
      when {
        tab.app == AppAction.BRIEFING -> if (!again) webView.loadUrl("$LAUNCHER?screen=briefing")
        tab.app == AppAction.ASK -> net.lakesidegames.briefing.NativeAskController.present()
        // Back to the page the player was last reading; tapping Game again goes to the site's home page.
        tab.id == "app-game" -> webView.loadUrl(if (again) "$site/" else lastGameUrl ?: "$site/")
        tab.href != null -> DockModel.safePath(tab.href)?.let { webView.loadUrl(site + it) }
      }
    }
  }

  override fun onOpenLink(link: DockLink) {
    endPreview()
    CompanionSafety.run("dock link ${link.id}") {
      val site = siteOrigin()
      when (link.app) {
        AppAction.BRIEFING -> webView.loadUrl("$LAUNCHER?screen=briefing")
        AppAction.INBOX -> webView.loadUrl("$site/notifications")
        AppAction.ASK -> net.lakesidegames.briefing.NativeAskController.present()
        AppAction.LAUNCHER -> webView.loadUrl(LAUNCHER)
        null -> DockModel.safePath(link.href)?.let { webView.loadUrl(site + it) }
      }
    }
  }

  override fun onOpenPath(path: String) {
    endPreview()
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

  private fun endPreview() {
    if (!previewing) return
    previewing = false
    applyModel()
  }

  // ---- pages -----------------------------------------------------------------

  /** The sandbox keeps its own pages while the player is in it. */
  private fun siteOrigin(): String {
    val host = webView.url?.let { Uri.parse(it).host }
    return if (host == "sandbox.ahousedividedgame.com") "https://$host" else BriefingWidgets.ORIGIN
  }

  /** The tab the page on screen belongs to, in the model now showing. */
  private fun tabFor(page: Page, path: String?): String? {
    val model = appliedModel
    val more = model.tabs.firstOrNull { it.sheet == "more" }?.id
    val briefing = model.tabs.firstOrNull { it.app == AppAction.BRIEFING }?.id
    return when (page) {
      Page.LAUNCHER -> more
      Page.BRIEFING -> briefing ?: more
      Page.SITE -> {
        val claimed = model.activeTab(path)
        // The Inbox moved into More; keep More lit there unless the game claims the page.
        if (path?.trimEnd('/') == "/notifications" && (claimed == null || claimed.id == "app-game")) more else claimed?.id
      }
    }
  }

  private fun followPage() {
    val url = webView.url
    val now = pageOf(url) ?: return
    val path = if (now == Page.SITE) Uri.parse(url).path else null
    if (now == Page.SITE) lastGameUrl = url
    val tab = tabFor(now, path)
    val inbox = now == Page.SITE && path?.trimEnd('/') == "/notifications"
    val moved = now != page || tab != tabId || inbox != onInbox
    if (!moved) return
    val leftInbox = onInbox && !inbox
    val returned = now == Page.SITE && page != null && page != Page.SITE
    val newSection = now == Page.SITE && sectionOf(path) != section
    page = now
    tabId = tab
    onInbox = inbox
    if (now == Page.SITE) section = sectionOf(path)
    // The player just read the inbox, or came back to the game: look again.
    if (leftInbox || returned) {
      handler.post { CompanionSafety.run("dock status fetch") { requestRefresh(force = true) } }
    } else if (newSection) {
      // A new part of the game can mean a different state or company in the tabs; throttled to once a minute.
      handler.post { CompanionSafety.run("dock section refresh") { requestRefresh(force = false) } }
    }
    if (inbox && !leftInbox) inboxVisitedAt = System.currentTimeMillis()
    if (!previewing) dock.showSelected(tab)
    showStatus()
  }

  // ---- the model ---------------------------------------------------------------

  private var appliedModel: DockModel = DockModel.fallback(false)
  private var checkedAccount = false

  /** A sign-in, sign-out or account switch: start from that account's cached model, or the fallback. */
  private fun checkAccount() {
    val now = BriefingWidgets.identity()
    if (checkedAccount && now == identity) return
    checkedAccount = true
    val changed = now != identity
    identity = now
    gameModel = if (now == null) null else DockModelStore.cached(activity.applicationContext)
    applyModel()
    // A different account (or first run) has not fetched yet: look now.
    if (changed && now != null) handler.post { CompanionSafety.run("dock account refresh") { requestRefresh(force = true) } }
  }

  private fun applyModel() {
    if (previewing) return
    val signedIn = BriefingWidgets.identity() != null
    val next = gameModel?.withApp(signedIn) ?: DockModel.fallback(signedIn)
    appliedModel = next
    dock.setModel(next)
    // The tab list can change under the page: pick the matching tab again.
    val url = webView.url
    val shown = pageOf(url)
    if (shown != null) {
      tabId = tabFor(shown, if (shown == Page.SITE) Uri.parse(url).path else null)
      dock.showSelected(tabId, animate = false)
    }
  }

  // ---- status ------------------------------------------------------------------

  /**
   * Fetch through the widgets' own request (same cookie, same cache), plus the
   * dock model, then redraw from the caches. Never on the UI thread, never
   * twice at once, and the timer never goes under a minute.
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
      var outcome: DockModelStore.Outcome? = null
      try {
        BriefingWidgets.refresh(context)
        outcome = DockModelStore.refresh(context)
      } finally {
        handler.post {
          fetching = false
          CompanionSafety.run("dock status show") {
            when (outcome) {
              DockModelStore.Outcome.UPDATED, DockModelStore.Outcome.UNCHANGED ->
                gameModel = DockModelStore.cached(context) ?: gameModel
              DockModelStore.Outcome.SIGNED_OUT, DockModelStore.Outcome.UNAVAILABLE -> gameModel = null
              // Offline or a server error keeps the last good model on screen.
              DockModelStore.Outcome.FAILED, null -> Unit
            }
            applyModel()
            showStatus()
          }
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
    dock.setStripAllowed(page == Page.SITE)
    // The Inbox badge on More: hidden on the Inbox itself and until a snapshot newer than the last visit arrives.
    val inbox = BriefingWidgets.inbox(activity)
    val unread = inbox?.first ?: 0
    val fresh = (inbox?.second ?: 0L) > inboxVisitedAt
    dock.setInboxBadge(if (unread > 0 && fresh && !onInbox) unread else 0)
  }
}
