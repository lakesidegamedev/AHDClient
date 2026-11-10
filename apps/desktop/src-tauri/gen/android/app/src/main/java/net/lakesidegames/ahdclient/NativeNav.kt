package net.lakesidegames.ahdclient

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
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
    private const val SANDBOX_HOST = "sandbox.ahousedividedgame.com"

    /** What the preview shows behind the dock in place of a game page: plain, dark and labelled. */
    private const val PREVIEW_PAGE =
      "<html><body style=\"margin:0;height:100vh;display:flex;align-items:center;justify-content:center;" +
        "background:#0f1016;color:#71717a;font:14px sans-serif\">Game page (screenshot preview)</body></html>"

    /** Tells the game this build draws its own status and menu dock, so the page hides both. Added once the dock is on screen. */
    const val NATIVE_MARKER = "AHDClientNativeStatus/1"

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

  var dock = NativeDock(activity, this)
    private set
  private val handler = Handler(Looper.getMainLooper())
  private var lastGameUrl: String? = null

  // A top level dock destination being loaded. Once it is showing, the history
  // before it is cleared so Back goes within the section, then leaves the app.
  private var pendingTopLevel: String? = null
  private var pendingTopLevelAt = 0L

  /** Loads a game page the dock treats as a top level destination (no new Back step). */
  private fun loadTopLevel(url: String) {
    pendingTopLevel = url
    pendingTopLevelAt = android.os.SystemClock.elapsedRealtime()
    webView.loadUrl(url)
  }
  private var page: Page? = null
  private var tabId: String? = null
  private var onInbox = false
  private var section: String? = null
  private var inboxVisitedAt = 0L
  private var ticks = 0
  private var previewing = false

  // What the dock knows, all in memory: disk and network are read on worker threads only.
  private var identity: String? = null
  private var checkedAccount = false
  private var locale: String? = null

  /** The country the page on screen is about (Nation follows it), or null for the home nation. */
  private var country: String? = null

  /** On a sign-in, registration or sign-out page. */
  private var authPage = false

  /** On the sandbox site: its pages are not the live account's, so the dock shows the fallback tabs. */
  private var sandbox = false

  /** The game's models (without the app section) for this account, by [DockKey.sub]. */
  private val models = HashMap<String, DockModel>()
  private var statusNow: DockStatus? = null
  private var inboxNow: Pair<Int, Long>? = null

  private var fetching: DockKey? = null
  private var refreshAgain = false
  private val lastFetch = HashMap<DockKey, Long>()
  private var statusFetchedAt = 0L
  private var appliedModel: DockModel = DockModel.fallback(false)

  private val follow = object : Runnable {
    override fun run() {
      CompanionSafety.run("dock follow") {
        // Every tick, and cheap (no disk): a sign-out, account switch or language change shows at once.
        checkAccount()
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
      // Only now that the dock is on screen does the page learn to hide its own status bar and menu.
      CompanionSafety.run("dock user agent marker") { markUserAgent() }
    }
    ViewCompat.requestApplyInsets(webView)
  }

  /**
   * Appends the native-dock marker to the WebView's user agent. A game page
   * that is already open was served without it, so it is reloaded once.
   */
  private fun markUserAgent() {
    val settings = webView.settings
    val agent = settings.userAgentString ?: ""
    if (agent.contains(NATIVE_MARKER)) return
    settings.userAgentString = "$agent $NATIVE_MARKER"
    if (pageOf(webView.url) == Page.SITE) webView.reload()
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
    CompanionSafety.run("dock model cache") {
      val first = !checkedAccount
      checkAccount()
      // Back in the app: read the saved models and figures once, off the UI thread (the first check already did).
      if (!first) identity?.let { loadCaches(it) }
    }
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
    CompanionSafety.run("last page save") { saveLastPage() }
  }

  /**
   * Remembers the live game page on screen for the next launch (the shared open-into-the-game
   * code restores it). Only for a signed-in player on a page worth returning to; a sign-in or
   * sign-out page, the sandbox or the launcher leave the saved page alone, and signing out
   * forgets it. The file is written off the UI thread.
   */
  private fun saveLastPage() {
    if (previewing) return
    val context = activity.applicationContext
    val account = BriefingWidgets.identity()
    if (account == null) {
      if (checkedAccount) Thread { LastGame.clear(context) }.start()
      return
    }
    val path = LastGame.pathToSave(webView.url) ?: return
    Thread { CompanionSafety.run("last page write") { LastGame.save(context, path, account) } }.start()
  }

  /**
   * The text size, display size or layout direction changed. The dock reads those once when it
   * is built, so build a new one with the same state; the page itself is left alone.
   */
  fun rebuildDock() {
    val content = activity.findViewById<FrameLayout>(android.R.id.content) ?: return
    val old = dock
    if (old.parent == null) return
    old.closeSheet(animate = false)
    old.pause()
    content.removeView(old)
    dock = NativeDock(activity, this)
    content.addView(dock, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT, Gravity.BOTTOM))
    dock.resume()
    applyModel()
    showStatus()
    if (!previewing) dock.showSelected(tabId, animate = false)
    ViewCompat.requestApplyInsets(webView)
  }

  /** Called from the WebView's insets listener; returns the dock's collapsed height. */
  fun layout(left: Int, top: Int, right: Int, bottom: Int, keyboard: Boolean): Int {
    if (dock.parent == null) return 0
    return dock.fit(left, top, right, bottom, keyboard)
  }

  /**
   * `ahdclient://dock?preview=collapsed|expanded|state|more|signedout|launcher|off`
   * shows the dock with the canned game model and canned figures, no network,
   * so a reviewer or CI can capture each state ("launcher" is the launcher
   * screen, where the status strip stays hidden). A tab tap ends it. Only
   * debug and CI builds accept the link (MainActivity); store builds ignore it.
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
    // Show the dock over the kind of page it belongs to: a game page (a small local placeholder, no
    // network), or the launcher.
    if (mode == "launcher" && page == Page.SITE) webView.loadUrl(LAUNCHER)
    else if (mode != "launcher" && page != Page.SITE) {
      val base = "${BriefingWidgets.ORIGIN}/preview"
      webView.loadDataWithBaseURL(base, PREVIEW_PAGE, "text/html", "UTF-8", base)
    }
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
    // The same rule the live dock applies: the strip belongs to game pages, not the launcher.
    dock.setStripAllowed(DockRouting.stripAllowed(onGamePage = mode != "launcher", signedIn = true, authPage = false, sandbox = false))
    dock.showSelected(if (mode == "launcher") "more" else "state", animate = false)
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
        tab.app == AppAction.BRIEFING -> if (!again) { pendingTopLevel = null; webView.loadUrl("$LAUNCHER?screen=briefing") }
        tab.app == AppAction.ASK -> net.lakesidegames.briefing.NativeAskController.present()
        // Back to the page the player was last reading; tapping Game again goes to the site's home page.
        tab.id == "app-game" -> loadTopLevel(if (again) "$site/" else lastGameUrl ?: "$site/")
        tab.href != null -> DockModel.safePath(tab.href)?.let { loadTopLevel(site + it) }
      }
    }
  }

  override fun onOpenLink(link: DockLink) {
    endPreview()
    CompanionSafety.run("dock link ${link.id}") {
      val site = siteOrigin()
      when {
        link.app == AppAction.BRIEFING -> { pendingTopLevel = null; webView.loadUrl("$LAUNCHER?screen=briefing") }
        link.app == AppAction.INBOX -> loadTopLevel("$site/notifications")
        link.app == AppAction.ASK -> net.lakesidegames.briefing.NativeAskController.present()
        link.app == AppAction.LAUNCHER -> { pendingTopLevel = null; webView.loadUrl(LAUNCHER) }
        // Wiki, Discord, Patreon, support mail: outside the game WebView, never loaded in it.
        link.external -> openExternal(link.href)
        else -> DockModel.safePath(link.href)?.let { loadTopLevel(site + it) }
      }
    }
  }

  /** Browser (or the mail app) for an allow-listed outside address; the check runs again here, at the last step. */
  private fun openExternal(href: String?) {
    val safe = DockModel.safeExternal(href) ?: return
    val uri = Uri.parse(safe)
    val intent = if (uri.scheme == "mailto") Intent(Intent.ACTION_SENDTO, uri)
    else Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
    try {
      activity.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
      // No browser or mail app on the phone: nothing to open.
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
    // An open sheet is modal for TalkBack: the page behind it is not reachable until it closes.
    webView.importantForAccessibility =
      if (expanded) View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS else View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
    activity.onDockExpanded(expanded)
  }

  override fun onTurnDue() {
    if (!previewing) requestRefresh(force = true)
  }

  private fun endPreview() {
    if (!previewing) return
    previewing = false
    applyModel()
    showStatus()
  }

  // ---- pages -----------------------------------------------------------------

  /** The sandbox keeps its own pages while the player is in it. */
  private fun siteOrigin(): String {
    val host = webView.url?.let { Uri.parse(it).host }
    return if (host == SANDBOX_HOST) "https://$host" else BriefingWidgets.ORIGIN
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

  /** Clears Back history the first tick the awaited top level page is showing, never earlier (it would clear the page being loaded). */
  private fun clearHistoryWhenReached(url: String?) {
    val target = pendingTopLevel ?: return
    if (DockRouting.reachedTopLevel(target, url)) {
      pendingTopLevel = null
      webView.clearHistory()
    } else if (android.os.SystemClock.elapsedRealtime() - pendingTopLevelAt > DockRouting.TOP_LEVEL_WAIT_MS) {
      pendingTopLevel = null
    }
  }

  private fun followPage() {
    val url = webView.url
    val now = pageOf(url) ?: return
    clearHistoryWhenReached(url)
    val uri = if (now == Page.SITE) Uri.parse(url) else null
    val path = uri?.path
    if (now == Page.SITE) lastGameUrl = url
    val nextSandbox = uri?.host == SANDBOX_HOST
    val nextAuth = now == Page.SITE && DockRouting.isAuthPath(path)
    val nextCountry = if (now == Page.SITE && !nextAuth) DockRouting.countryOf(path) else null
    val authChanged = nextAuth != authPage
    val sandboxChanged = nextSandbox != sandbox
    val countryChanged = nextCountry != country
    authPage = nextAuth
    sandbox = nextSandbox
    country = nextCountry
    // Signing in or out: the previous account's tabs are gone at once, and so is what was saved for it.
    if (authChanged && nextAuth) dropAccountModels()
    val tab = tabFor(now, path)
    val inbox = now == Page.SITE && path?.trimEnd('/') == "/notifications"
    val moved = now != page || tab != tabId || inbox != onInbox || authChanged || sandboxChanged || countryChanged
    if (!moved) return
    val leftInbox = onInbox && !inbox
    val returned = now == Page.SITE && page != null && page != Page.SITE
    val newSection = now == Page.SITE && sectionOf(path) != section
    page = now
    onInbox = inbox
    if (now == Page.SITE) section = sectionOf(path)
    if (authChanged || sandboxChanged || countryChanged) {
      // A different set of tabs may apply (fallback on sign-in pages and the sandbox, another country's Nation).
      applyModel()
    }
    tabId = tabFor(now, path)
    // The player just read the inbox, came back to the game, or finished signing in: look again.
    if (leftInbox || returned || (authChanged && !nextAuth)) {
      handler.post { CompanionSafety.run("dock status fetch") { requestRefresh(force = true) } }
    } else if (countryChanged) {
      // Nation follows the page; throttled per country.
      handler.post { CompanionSafety.run("dock country refresh") { requestRefresh(force = false) } }
    } else if (newSection) {
      // A new part of the game can mean a different state or company in the tabs; throttled to once a minute.
      handler.post { CompanionSafety.run("dock section refresh") { requestRefresh(force = false) } }
    }
    if (inbox && !leftInbox) inboxVisitedAt = System.currentTimeMillis()
    if (!previewing) dock.showSelected(tabId)
    showStatus()
  }

  // ---- the model ---------------------------------------------------------------

  /** What a dock request would be for right now, or null when signed out. */
  private fun currentKey(): DockKey? = identity?.let { DockKey(it, locale, country) }

  /**
   * The game's model for the page on screen. While another country's tabs are
   * still loading, the last model in the same language stays; a model in
   * another language never does.
   */
  private fun gameModelNow(): DockModel? {
    val key = currentKey() ?: return null
    models[key.sub]?.let { return it }
    return models[DockKey.sub(key.locale, null)]
      ?: models.entries.firstOrNull { it.key.startsWith("${key.locale ?: "-"}|") }?.value
  }

  /** The player is signed in, on the live game, and not on a sign-in page. */
  private fun accountLive() = identity != null && !authPage && !sandbox

  private fun dropAccountModels() {
    models.clear()
    val context = activity.applicationContext
    Thread { DockModelStore.clear(context) }.start()
  }

  /**
   * A sign-in, sign-out, account switch or language change: start from what is
   * cached for that account (read on a worker), or the fallback, and look
   * again. Only reads the cookies, so it is cheap enough for every tick.
   */
  private fun checkAccount() {
    val nowId = BriefingWidgets.identity()
    val nowLocale = if (nowId == null) null else DockModelStore.locale()
    val accountChanged = !checkedAccount || nowId != identity
    if (!accountChanged && nowLocale == locale) return
    checkedAccount = true
    identity = nowId
    locale = nowLocale
    if (accountChanged) {
      models.clear()
      statusNow = null
      inboxNow = null
      if (nowId == null) dropAccountModels() else loadCaches(nowId)
    }
    applyModel()
    showStatus()
    // A different account, or language, has not fetched yet: look now.
    if (nowId != null) handler.post { CompanionSafety.run("dock account refresh") { requestRefresh(force = true) } }
  }

  /** Reads the saved models and the last status snapshot off the UI thread, then shows them. */
  private fun loadCaches(forIdentity: String) {
    val context = activity.applicationContext
    Thread {
      val saved = DockModelStore.cachedAll(context, forIdentity)
      val snapshot = readSnapshot(context)
      handler.post {
        if (identity != forIdentity) return@post
        for ((key, model) in saved) models.putIfAbsent(key, model)
        if (snapshot != null) { statusNow = snapshot.first; inboxNow = snapshot.second }
        CompanionSafety.run("dock cache show") { applyModel(); showStatus() }
      }
    }.start()
  }

  /** The widgets' last status snapshot as dock figures plus the inbox count. Reads the file: worker threads only. */
  private fun readSnapshot(context: android.content.Context): Pair<DockStatus?, Pair<Int, Long>?>? =
    CompanionSafety.get("dock snapshot read", null as Pair<DockStatus?, Pair<Int, Long>?>?) {
      Pair(DockStatus.from(BriefingWidgets.snapshot(context)), BriefingWidgets.inbox(context))
    }

  private fun applyModel() {
    if (previewing) return
    val live = accountLive()
    val next = (if (live) gameModelNow() else null)?.withApp(live) ?: DockModel.fallback(live)
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
   * Fetch the dock model for the page on screen (and, at most once a minute,
   * the status figures through the widgets' own request), then redraw from
   * memory. Never on the UI thread, never twice at once, and a model is not
   * asked for again within a minute (5 seconds when something just happened).
   */
  private fun requestRefresh(force: Boolean) {
    if (previewing || sandbox || authPage) return
    val key = currentKey() ?: return
    val running = fetching
    if (running != null) {
      // A different country or language than the one in flight: go again when it lands.
      if (running != key) refreshAgain = true
      return
    }
    val now = SystemClock.elapsedRealtime()
    val gap = if (force) FORCED_GAP_MS else STATUS_GAP_MS
    val last = lastFetch[key]
    if (last != null && now - last < gap) return
    val statusDue = statusFetchedAt == 0L || now - statusFetchedAt >= gap
    fetching = key
    lastFetch[key] = now
    if (statusDue) statusFetchedAt = now
    val context = activity.applicationContext
    Thread {
      var fetched: DockModelStore.Fetched? = null
      var snapshot: Pair<DockStatus?, Pair<Int, Long>?>? = null
      try {
        if (statusDue) BriefingWidgets.refresh(context)
        fetched = DockModelStore.refresh(context, key)
        snapshot = readSnapshot(context)
      } finally {
        handler.post { CompanionSafety.run("dock status show") { refreshed(key, fetched, snapshot) } }
      }
    }.start()
  }

  private fun refreshed(key: DockKey, fetched: DockModelStore.Fetched?, snapshot: Pair<DockStatus?, Pair<Int, Long>?>?) {
    fetching = null
    // The player signed out or switched while the request was out: say nothing about the new session.
    if (identity == key.identity) {
      when (fetched?.outcome) {
        DockModelStore.Outcome.UPDATED, DockModelStore.Outcome.UNCHANGED -> fetched.model?.let { models[key.sub] = it }
        DockModelStore.Outcome.SIGNED_OUT, DockModelStore.Outcome.UNAVAILABLE -> models.clear()
        // Offline or a server error keeps the last good model on screen.
        DockModelStore.Outcome.FAILED, null -> Unit
      }
      if (snapshot != null) { statusNow = snapshot.first; inboxNow = snapshot.second }
      applyModel()
      showStatus()
    }
    if (refreshAgain) {
      refreshAgain = false
      requestRefresh(force = false)
    }
  }

  /** Redraws the dock from the figures held in memory. Cheap; safe to call often. */
  private fun showStatus() {
    if (previewing) return
    val signedIn = identity != null
    dock.setStatus(if (signedIn) statusNow else null)
    dock.setStripAllowed(DockRouting.stripAllowed(page == Page.SITE, signedIn, authPage, sandbox))
    // The Inbox badge on More: hidden on the Inbox itself and until a snapshot newer than the last visit arrives.
    val unread = inboxNow?.first ?: 0
    val fresh = (inboxNow?.second ?: 0L) > inboxVisitedAt
    dock.setInboxBadge(if (accountLive() && unread > 0 && fresh && !onInbox) unread else 0)
  }
}
