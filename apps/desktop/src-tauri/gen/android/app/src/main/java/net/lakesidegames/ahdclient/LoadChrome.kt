package net.lakesidegames.ahdclient

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * A thin layer over the game WebView: a 2 dp loading bar along the bottom edge of the page (just
 * above the dock) and a "Cannot reach the game" screen over the page when it fails to load. It
 * sits exactly where the WebView does and takes no touches except on the screen's own buttons.
 */
class LoadChrome(context: Context, private val webView: WebView, private val onBack: () -> Unit) : FrameLayout(context) {

  private val handler = Handler(Looper.getMainLooper())
  private val density = context.resources.displayMetrics.density
  private var failedUrl: String? = null
  private var loading = false
  /** True while the page being loaded is a game page, the only place the bar belongs. */
  var onGamePage = false

  private val gold = Color.parseColor("#C9A227")
  private val bar = object : View(context) {
    private val paint = Paint().apply { color = gold }
    override fun onDraw(canvas: Canvas) {
      canvas.drawRect(0f, 0f, LoadRules.barFill(webView.progress, width).toFloat(), height.toFloat(), paint)
    }
  }
  private val screen = LinearLayout(context)
  private val screenTexts = ArrayList<Pair<TextView, Int>>()

  private val poll = object : Runnable {
    override fun run() {
      refresh()
      if (loading) handler.postDelayed(this, 100)
    }
  }

  init {
    // Never in the way of the page or the dock beneath the screen's own buttons.
    isClickable = false
    visibility = GONE
    addView(bar, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (2 * density).toInt().coerceAtLeast(2), Gravity.BOTTOM))
    bar.visibility = GONE
    buildScreen(context)
    addView(screen, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    screen.visibility = GONE
  }

  private fun dp(v: Int) = (v * density).toInt()

  private fun buildScreen(context: Context) {
    screen.orientation = LinearLayout.VERTICAL
    screen.gravity = Gravity.CENTER
    screen.setBackgroundColor(Color.parseColor("#0F1016"))
    screen.isClickable = true
    screen.setPadding(dp(32), dp(32), dp(32), dp(32))
    val title = TextView(context).apply {
      text = Texts.s(LoadRules.TITLE)
      setTextColor(Color.parseColor("#F4F4F5"))
      textSize = 20f
      typeface = Typeface.DEFAULT_BOLD
      gravity = Gravity.CENTER
    }
    val detail = TextView(context).apply {
      text = Texts.s(LoadRules.DETAIL)
      setTextColor(Color.parseColor("#A1A1AA"))
      textSize = 15f
      gravity = Gravity.CENTER
      setPadding(0, dp(8), 0, dp(24))
    }
    val retry = Button(context).apply {
      text = Texts.s(LoadRules.RETRY)
      isAllCaps = false
      setTextColor(Color.parseColor("#14141C"))
      background = GradientDrawable().apply { setColor(gold); cornerRadius = dp(10).toFloat() }
      minimumWidth = dp(200)
      minimumHeight = dp(48)
      setOnClickListener { retryNow() }
    }
    val back = Button(context).apply {
      text = Texts.s(LoadRules.BACK)
      isAllCaps = false
      setTextColor(Color.parseColor("#E4E4E7"))
      background = null
      minimumHeight = dp(48)
      setOnClickListener { CompanionSafety.run("offline back to launcher") { hideError(); onBack() } }
    }
    screenTexts.addAll(listOf(title to LoadRules.TITLE, detail to LoadRules.DETAIL, retry to LoadRules.RETRY, back to LoadRules.BACK))
    screen.addView(title)
    screen.addView(detail)
    screen.addView(retry, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    screen.addView(back, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
  }

  /** Follows the WebView's own margins so the bar sits just above the dock and the screen fills the page area. */
  fun syncTo(view: View) {
    val source = view.layoutParams as? ViewGroup.MarginLayoutParams ?: return
    val mine = layoutParams as? ViewGroup.MarginLayoutParams ?: return
    if (mine.leftMargin != source.leftMargin || mine.topMargin != source.topMargin ||
      mine.rightMargin != source.rightMargin || mine.bottomMargin != source.bottomMargin) {
      mine.setMargins(source.leftMargin, source.topMargin, source.rightMargin, source.bottomMargin)
      layoutParams = mine
    }
  }

  private fun retryNow() {
    val url = failedUrl
    hideError()
    CompanionSafety.run("offline retry") {
      if (url != null && webView.url == url) webView.reload() else if (url != null) webView.loadUrl(url)
    }
  }

  fun showError(url: String?) {
    failedUrl = url
    stopLoading()
    Texts.syncFromCookie()
    for ((view, id) in screenTexts) view.text = Texts.s(id)
    screen.visibility = VISIBLE
    visibility = VISIBLE
  }

  fun hideError() {
    screen.visibility = GONE
    if (!loading) visibility = GONE
  }

  fun errorShown() = screen.visibility == VISIBLE

  fun startLoading() {
    loading = true
    hideError()
    handler.removeCallbacks(poll)
    handler.post(poll)
  }

  fun stopLoading() {
    loading = false
    handler.removeCallbacks(poll)
    bar.visibility = GONE
    if (!errorShown()) visibility = GONE
  }

  private fun refresh() {
    val show = LoadRules.barVisible(webView.progress, onGamePage, errorShown())
    if (show) {
      visibility = VISIBLE
      bar.visibility = VISIBLE
      bar.invalidate()
    } else if (webView.progress >= 100 || !onGamePage) {
      stopLoading()
    }
  }
}

/**
 * Wraps the client the WebView already has (wry's) and forwards its five overrides to it first,
 * unchanged, so the app's navigation policy, request handling and script injection behave as
 * before. It only adds: the loading bar, and the cannot-reach screen when the page itself fails
 * to load for a reason the player can act on.
 */
class LoadWatchingClient(private val inner: WebViewClient, private val chrome: LoadChrome) : WebViewClient() {
  /** The last address the inner client was asked to serve; its sign-in redirect case is a request for any other. */
  private var lastServed: String? = null

  override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
    lastServed = request.url.toString()
    return inner.shouldInterceptRequest(view, request)
  }

  override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
    inner.shouldOverrideUrlLoading(view, request)

  override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
    inner.onPageStarted(view, url, favicon)
    CompanionSafety.run("load bar start") {
      chrome.onGamePage = NativeNav.pageOf(url) == NativeNav.Companion.Page.SITE
      chrome.startLoading()
    }
  }

  override fun onPageFinished(view: WebView, url: String) {
    inner.onPageFinished(view, url)
    CompanionSafety.run("load bar finish") { chrome.stopLoading() }
  }

  override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
    inner.onReceivedError(view, request, error)
    CompanionSafety.run("cannot reach screen") {
      if (LoadRules.showsError(request.isForMainFrame, error.errorCode, request.url.toString(), lastServed)) {
        chrome.showError(request.url.toString())
      }
    }
  }
}
