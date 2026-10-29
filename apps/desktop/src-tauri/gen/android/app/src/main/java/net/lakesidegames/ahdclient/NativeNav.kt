package net.lakesidegames.ahdclient

import android.content.res.ColorStateList
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.navigation.NavigationBarView

/**
 * The phone tab bar: Game, Briefing, Inbox, Ask and More, in place of the
 * floating AHD button the site pages used to carry. One WebView still shows
 * everything; each tab is a page in it (or the native Ask sheet), and the bar
 * follows whatever page the WebView is on, however the player got there.
 */
class NativeNav(private val activity: MainActivity, private val webView: WebView) {
  enum class Destination(val id: Int, val label: String, val icon: Int) {
    GAME(1, "Game", R.drawable.ic_nav_game),
    BRIEFING(2, "Briefing", R.drawable.ic_nav_briefing),
    INBOX(3, "Inbox", R.drawable.ic_nav_inbox),
    ASK(4, "Ask", R.drawable.ic_nav_ask),
    MORE(5, "More", R.drawable.ic_nav_more),
  }

  companion object {
    /** Material 3 navigation bar height, before the system navigation inset. */
    const val BAR_HEIGHT_DP = 80
    private const val LAUNCHER = "http://tauri.localhost/"
    private const val SITE_HOSTS = "ahousedividedgame.com|www.ahousedividedgame.com|sandbox.ahousedividedgame.com"

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

  val bar: BottomNavigationView
  private val handler = Handler(Looper.getMainLooper())
  private var syncing = false
  private var lastGameUrl: String? = null
  private var current: Destination? = null
  private var inboxVisitedAt = 0L
  private var ticks = 0
  private val follow = object : Runnable {
    override fun run() {
      CompanionSafety.run("tab bar follow") {
        followPage()
        if (ticks++ % 20 == 0) refreshBadge()
      }
      handler.postDelayed(this, 500)
    }
  }
  private val fetch = object : Runnable {
    override fun run() {
      CompanionSafety.run("tab bar inbox fetch") { fetchInbox() }
      handler.postDelayed(this, 180_000)
    }
  }

  init {
    // Material 3 styling on top of the app's MaterialComponents theme.
    val themed = ContextThemeWrapper(activity, com.google.android.material.R.style.Theme_Material3_Dark_NoActionBar)
    bar = BottomNavigationView(themed)
    bar.id = View.generateViewId()
    bar.labelVisibilityMode = NavigationBarView.LABEL_VISIBILITY_LABELED
    bar.setBackgroundColor(Color.parseColor("#14141C"))
    bar.elevation = 0f
    val states = arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf())
    val tint = ColorStateList(states, intArrayOf(Color.parseColor("#DC2626"), Color.parseColor("#A1A1AA")))
    bar.itemIconTintList = tint
    bar.itemTextColor = tint
    bar.itemActiveIndicatorColor = ColorStateList.valueOf(Color.parseColor("#33DC2626"))
    Destination.values().forEachIndexed { order, tab ->
      bar.menu.add(0, tab.id, order, tab.label).setIcon(tab.icon)
    }
    // MainActivity lays the bar and the WebView out from one set of insets.
    ViewCompat.setOnApplyWindowInsetsListener(bar) { _, insets -> insets }
    bar.setOnItemSelectedListener { item ->
      if (syncing) return@setOnItemSelectedListener true
      val tab = Destination.values().firstOrNull { it.id == item.itemId } ?: return@setOnItemSelectedListener false
      bar.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
      CompanionSafety.run("tab bar ${tab.label}") { open(tab, again = false) }
      // Ask is a sheet over the current page, so the selection stays put.
      tab != Destination.ASK
    }
    bar.setOnItemReselectedListener { item ->
      val tab = Destination.values().firstOrNull { it.id == item.itemId } ?: return@setOnItemReselectedListener
      CompanionSafety.run("tab bar ${tab.label} again") { open(tab, again = true) }
    }
  }

  fun attach() {
    val content = activity.findViewById<FrameLayout>(android.R.id.content) ?: return
    if (bar.parent == null) {
      content.addView(bar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
      // Silences the floating AHD button mobile.rs keeps as a fallback for a
      // bar that never attached. A WebView too old for document-start scripts
      // shows both, which still leaves every action reachable.
      val flag = "window.__ahdclientNativeTabs = true;"
      if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
        WebViewCompat.addDocumentStartJavaScript(webView, flag, SITE_HOSTS.split('|').map { "https://$it" }.toSet())
      }
      webView.evaluateJavascript(flag, null)
    }
    ViewCompat.requestApplyInsets(webView)
  }

  fun resume() {
    handler.removeCallbacks(follow)
    handler.removeCallbacks(fetch)
    handler.post(follow)
    handler.post(fetch)
  }

  fun pause() {
    handler.removeCallbacks(follow)
    handler.removeCallbacks(fetch)
  }

  /** Called from the WebView's insets listener; returns the bar's full height. */
  fun layout(left: Int, right: Int, bottom: Int, keyboard: Boolean): Int {
    if (bar.parent == null) return 0
    val height = (BAR_HEIGHT_DP * activity.resources.displayMetrics.density).toInt() + bottom
    // The keyboard covers the bar, as in other apps; the page gets the room.
    bar.visibility = if (keyboard) View.GONE else View.VISIBLE
    bar.setPadding(left, 0, right, bottom)
    val params = bar.layoutParams
    if (params != null && params.height != height) {
      params.height = height
      bar.layoutParams = params
    }
    return if (keyboard) 0 else height
  }

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
    if (current == Destination.INBOX) {
      // The player just read the inbox; ask the site for the new count.
      handler.post { CompanionSafety.run("tab bar inbox fetch") { fetchInbox() } }
    }
    if (tab == Destination.INBOX) inboxVisitedAt = System.currentTimeMillis()
    current = tab
    if (bar.selectedItemId != tab.id) {
      syncing = true
      try { bar.selectedItemId = tab.id } finally { syncing = false }
    }
    refreshBadge()
  }

  private fun fetchInbox() {
    val context = activity.applicationContext
    Thread {
      BriefingWidgets.refresh(context)
      handler.post { CompanionSafety.run("tab bar badge") { refreshBadge() } }
    }.start()
  }

  /**
   * Unread count from the same snapshot the briefing and widgets use. Hidden
   * on the Inbox itself and until a snapshot newer than the visit arrives.
   */
  private fun refreshBadge() {
    val inbox = BriefingWidgets.inbox(activity)
    val unread = inbox?.first ?: 0
    val fresh = (inbox?.second ?: 0L) > inboxVisitedAt
    if (unread > 0 && fresh && current != Destination.INBOX) {
      bar.getOrCreateBadge(Destination.INBOX.id).apply {
        number = unread
        backgroundColor = Color.parseColor("#DC2626")
        badgeTextColor = Color.WHITE
        isVisible = true
      }
    } else {
      bar.getBadge(Destination.INBOX.id)?.isVisible = false
    }
  }
}
