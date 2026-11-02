package net.lakesidegames.ahdclient

import android.animation.ArgbEvaluator
import android.animation.ValueAnimator
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextUtils
import android.text.style.ForegroundColorSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.AccessibilityDelegateCompat
import androidx.core.view.ViewCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.dynamicanimation.animation.DynamicAnimation
import androidx.dynamicanimation.animation.FloatValueHolder
import androidx.dynamicanimation.animation.SpringAnimation
import androidx.dynamicanimation.animation.SpringForce
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The phone dock: one rounded surface that carries the game's tab row (from
 * the DockModel) and, above it, a slim status strip with the turn countdown,
 * funds and actions. Drag the dock up or tap the strip and a sheet grows out
 * of it with the full status; tap a menu tab (State, Nation, More) and the
 * same sheet grows with that menu instead. Tapping a row opens that game page
 * or runs an app action. Drawn with plain views and spring animations so it
 * needs no extra toolkit.
 *
 * The dock is a transparent overlay the size of the window. Touches outside
 * the surface fall through to the WebView. NativeNav owns what the dock
 * shows and does; the dock only draws, animates and reports taps through
 * [Listener].
 */
class NativeDock(context: Context, private val listener: Listener) : FrameLayout(context) {
  interface Listener {
    /** A page or app tab was tapped (menu tabs open their sheet here instead). [again] is true when it was already selected. */
    fun onTab(tab: DockTab, again: Boolean)

    /** A menu sheet row was tapped: a game page or an app action. */
    fun onOpenLink(link: DockLink)

    /** A status row asked to open a game page. */
    fun onOpenPath(path: String)

    /** The collapsed dock changed height (the strip came or went, or the font scale changed). */
    fun onCollapsedHeightChanged()

    /** The sheet opened or closed, by tap, drag or code. */
    fun onExpandedChanged(expanded: Boolean)

    /** The turn countdown ran out. Called at most once a minute while it stays overdue. */
    fun onTurnDue()
  }

  companion object {
    private const val SURFACE = 0xF214141C.toInt()
    private const val EDGE = 0x24FFFFFF
    private const val RED = 0xFFDC2626.toInt()
    private const val MUTED = 0xFFA1A1AA.toInt()
    private const val TEXT = 0xFFF4F4F5.toInt()
    private const val GAIN = 0xFF66D685.toInt()
    private const val LOSS = 0xFFFA706B.toInt()
    private const val INDICATOR = 0x33DC2626
    private const val MAX_WIDTH_DP = 600
    private const val TAB_HEIGHT_DP = 56
    private const val STRIP_HEIGHT_DP = 48
    private const val SHEET_SHARE = 0.8f
  }

  private val density = resources.displayMetrics.density
  private fun dp(value: Float) = (value * density + 0.5f).toInt()
  private fun dp(value: Int) = dp(value.toFloat())

  private val handler = Handler(Looper.getMainLooper())
  private val scrim = View(context)
  private val panel = Panel(context)
  private val sheet = SheetBox(context)
  private val strip = Strip(context)
  private val tabRow = TabRow(context)

  private var status: DockStatus? = null
  private var model: DockModel = DockModel.fallback(false)
  private var inboxUnread = 0

  /** The menu sheet that is (or was last) open, or null for the status sheet. */
  private var menuId: String? = null
  private var stripAllowed = false
  private var progress = 0f
  private var targetExpanded = false
  private var spring: SpringAnimation? = null
  private var running = false
  private var lastDueAt = 0L

  private var lastLeft = 0
  private var lastTop = 0
  private var lastRight = 0
  private var lastBottom = 0
  private var lastKeyboard = false
  private var reportedHeight = -1

  val expanded: Boolean get() = targetExpanded

  /** Animator duration scale 0 is the phone's "remove animations" switch. */
  private fun reducedMotion(): Boolean = try {
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
  } catch (_: Throwable) {
    false
  }

  init {
    clipChildren = false
    clipToPadding = false
    // MainActivity lays the dock and the WebView out from one set of insets.
    ViewCompat.setOnApplyWindowInsetsListener(this) { _, insets -> insets }
    scrim.setBackgroundColor(Color.BLACK)
    scrim.alpha = 0f
    scrim.visibility = View.GONE
    scrim.isClickable = true
    scrim.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    scrim.setOnClickListener { setExpanded(false) }
    addView(scrim, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))

    panel.orientation = LinearLayout.VERTICAL
    panel.addView(sheet, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    panel.addView(strip, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    panel.addView(tabRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    addView(panel, LayoutParams(dp(MAX_WIDTH_DP), LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL))
    strip.visibility = View.GONE
    sheet.visibility = View.GONE
    tabRow.setTabs(model.tabs)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    // Tall enough for every row on most phones, never up under the status bar.
    val window = MeasureSpec.getSize(heightMeasureSpec)
    sheet.maxHeight = min((window * SHEET_SHARE).toInt(), window - lastTop - max(reportedHeight, 0) - dp(12)).coerceAtLeast(0)
    super.onMeasure(widthMeasureSpec, heightMeasureSpec)
  }

  // ---- state from NativeNav ------------------------------------------------

  /** Called from the insets listener (the system bar insets). Returns the collapsed dock height, 0 while the keyboard is up. */
  fun fit(left: Int, top: Int, right: Int, bottom: Int, keyboard: Boolean): Int {
    lastLeft = left; lastTop = top; lastRight = right; lastBottom = bottom; lastKeyboard = keyboard
    // The keyboard covers the dock, as in other apps; the page gets the room.
    if (keyboard) {
      if (targetExpanded) setExpanded(false, animate = false)
      visibility = View.GONE
      return 0
    }
    visibility = View.VISIBLE
    panel.setPadding(left, 0, right, bottom)
    // The window's own width, which also holds in split screen; the display's until first layout.
    val available = if (width > 0) width else resources.displayMetrics.widthPixels
    val width = min(available, dp(MAX_WIDTH_DP))
    (panel.layoutParams as LayoutParams).let { if (it.width != width) { it.width = width; panel.layoutParams = it } }
    val inner = max(0, width - left - right)
    val exact = MeasureSpec.makeMeasureSpec(inner, MeasureSpec.EXACTLY)
    val free = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
    tabRow.measure(exact, free)
    var height = tabRow.measuredHeight
    if (strip.visibility == View.VISIBLE) {
      strip.measure(exact, free)
      height += strip.measuredHeight
    }
    reportedHeight = height + bottom
    return reportedHeight
  }

  /** The tab that matches the page on screen; null when none does. */
  fun showSelected(tabId: String?, animate: Boolean = true) = tabRow.select(tabId, animate && !reducedMotion())

  /** The tabs and menus the game described (or the app's fallback). Keeps the selection and an open sheet when it can. */
  fun setModel(next: DockModel) {
    if (sameModel(model, next)) return
    model = next
    tabRow.setTabs(next.tabs)
    tabRow.setBadge(inboxUnread)
    if (targetExpanded && menuId != null && next.sheets[menuId] == null) closeSheet(animate = false)
    else if (targetExpanded && menuId != null) bindSheet(animate = false)
  }

  private fun sameModel(a: DockModel, b: DockModel) = a.tabs == b.tabs && a.sheets == b.sheets

  /** Unread inbox items: a badge on the More tab and a count on the Inbox row. */
  fun setInboxBadge(count: Int) {
    if (count == inboxUnread) return
    inboxUnread = count
    tabRow.setBadge(count)
    if (menuId != null) bindSheet(animate = false)
  }

  /** The strip only shows on game pages; the launcher and Briefing have their own screens. */
  fun setStripAllowed(allowed: Boolean) {
    if (stripAllowed == allowed) return
    stripAllowed = allowed
    applyStripVisibility()
  }

  fun setStatus(next: DockStatus?) {
    val previous = status
    status = next
    strip.bind(next, previous != null && !reducedMotion())
    if (menuId == null) bindSheet(animate = previous != null && !reducedMotion())
    applyStripVisibility()
    updateTickText()
  }

  fun resume() {
    if (running) return
    running = true
    handler.post(ticker)
  }

  fun pause() {
    running = false
    handler.removeCallbacks(ticker)
  }

  /** Opens or closes the status sheet. */
  fun setExpanded(open: Boolean, animate: Boolean = true) {
    if (open) openSheet(null, animate) else closeSheet(animate)
  }

  fun openMenu(tabId: String, animate: Boolean = true) = openSheet(tabId, animate)

  /** Opens the menu sheet for a menu tab, or closes it when it is the one already open. */
  fun toggleMenu(tabId: String) {
    if (targetExpanded && menuId == tabId) closeSheet() else openSheet(tabId, animate = true)
  }

  fun closeSheet(animate: Boolean = true) {
    if (!targetExpanded && progress == 0f) return
    commitTarget(false)
    tabRow.setOpen(null)
    if (animate && !reducedMotion()) settle(0f, 0f) else {
      spring?.cancel()
      setProgress(0f)
    }
  }

  private fun openSheet(menu: String?, animate: Boolean) {
    val tab = model.tab(menu)
    if (menu != null && (tab?.sheet == null || model.sheets[tab.sheet] == null)) return
    if (menu == null && !(strip.visibility == View.VISIBLE && status?.hasStrip == true)) return
    val switching = targetExpanded && menuId != menu
    menuId = menu
    bindSheet(animate = false)
    if (!sheet.hasRows) { menuId = null; return }
    tabRow.setOpen(menu)
    if (switching && animate && !reducedMotion()) sheet.fadeIn()
    if (targetExpanded && !switching) return
    commitTarget(true)
    if (animate && !reducedMotion()) settle(1f, 0f) else {
      spring?.cancel()
      setProgress(1f)
    }
  }

  private fun commitTarget(value: Boolean) {
    if (targetExpanded == value) {
      strip.refreshState()
      return
    }
    targetExpanded = value
    strip.refreshState()
    listener.onExpandedChanged(value)
  }

  /** What the sheet shows now: the open menu, or the status figures. */
  private fun bindSheet(animate: Boolean) {
    val id = menuId
    val tab = model.tab(id)
    val menu = tab?.sheet?.let { model.sheets[it] }
    if (id != null && menu != null) {
      sheet.bindMenu(menu, tab.label, inboxUnread)
    } else {
      sheet.bindStatus(status, animate)
    }
  }

  private fun applyStripVisibility() {
    val show = stripAllowed && status?.hasStrip == true
    val wanted = if (show) View.VISIBLE else View.GONE
    if (strip.visibility != wanted) strip.visibility = wanted
    if (!show && targetExpanded && menuId == null) closeSheet(animate = false)
    // The page ends above the dock, so a new height needs a new layout pass.
    post {
      val before = reportedHeight
      fit(lastLeft, lastTop, lastRight, lastBottom, lastKeyboard)
      if (before >= 0 && before != reportedHeight) listener.onCollapsedHeightChanged()
    }
  }

  // ---- expand and collapse -------------------------------------------------

  private fun setProgress(value: Float) {
    progress = value.coerceIn(0f, 1f)
    sheet.reveal = progress
    scrim.alpha = progress * 0.5f
    val open = progress > 0f
    val wanted = if (open) View.VISIBLE else View.GONE
    if (scrim.visibility != wanted) scrim.visibility = wanted
    sheet.importantForAccessibility =
      if (open) View.IMPORTANT_FOR_ACCESSIBILITY_AUTO else View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    // Fully closed: the next drag up opens the status figures again.
    if (progress == 0f && !targetExpanded && menuId != null) {
      menuId = null
      bindSheet(animate = false)
    }
  }

  private fun settle(target: Float, velocity: Float) {
    spring?.cancel()
    val animation = SpringAnimation(FloatValueHolder(progress))
    animation.spring = SpringForce(target).setStiffness(520f).setDampingRatio(0.9f)
    animation.setStartVelocity(velocity)
    animation.setMinimumVisibleChange(DynamicAnimation.MIN_VISIBLE_CHANGE_SCALE)
    animation.addUpdateListener { _, value, _ -> setProgress(value) }
    animation.addEndListener { _, canceled, _, _ -> if (!canceled) { setProgress(target); if (spring === animation) spring = null } }
    spring = animation
    animation.start()
  }

  // ---- the live countdown --------------------------------------------------

  private val ticker = object : Runnable {
    override fun run() {
      if (!running) return
      CompanionSafety.run("dock countdown") { updateTickText() }
      handler.postDelayed(this, 1000)
    }
  }

  private fun updateTickText() {
    val current = status ?: return
    val now = System.currentTimeMillis()
    val remaining = current.nextTurnAt?.minus(now)
    strip.setCountdown(current, remaining)
    sheet.setCountdown(current, remaining)
    if (current.turnActive && remaining != null && remaining <= 0 && now - lastDueAt >= 60_000) {
      lastDueAt = now
      listener.onTurnDue()
    }
  }

  // ---- drawing the surface -------------------------------------------------

  private inner class Panel(context: Context) : LinearLayout(context) {
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = SURFACE }
    private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = EDGE; style = Paint.Style.STROKE; strokeWidth = dp(1).toFloat()
    }
    private val bounds = RectF()
    private val tracker: VelocityTracker = VelocityTracker.obtain()
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    private var baseY = 0f
    private var baseProgress = 0f
    private var startedInSheet = false
    private var dragging = false

    init {
      setWillNotDraw(false)
      clipChildren = false
    }

    override fun onDraw(canvas: Canvas) {
      val radius = dp(22).toFloat()
      // The bottom corners hang below the screen edge, so only the top shows.
      bounds.set(edge.strokeWidth / 2, edge.strokeWidth / 2, width - edge.strokeWidth / 2, height + radius)
      canvas.drawRoundRect(bounds, radius, radius, fill)
      canvas.drawRoundRect(bounds, radius, radius, edge)
    }

    /** Velocity in screen coordinates: the panel's own top moves with the finger, so local ones would read zero. */
    private fun track(ev: MotionEvent) {
      val screen = MotionEvent.obtain(ev)
      screen.setLocation(ev.rawX, ev.rawY)
      tracker.addMovement(screen)
      screen.recycle()
    }

    private fun canDrag(): Boolean = sheet.hasRows && (strip.visibility == View.VISIBLE || targetExpanded)

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
      if (!canDrag()) return false
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          tracker.clear()
          track(ev)
          downX = ev.rawX; downY = ev.rawY
          startedInSheet = sheet.height > 0 && ev.y < sheet.bottom
          dragging = false
        }
        MotionEvent.ACTION_MOVE -> {
          track(ev)
          val dy = ev.rawY - downY
          val dx = ev.rawX - downX
          if (!dragging && abs(dy) > slop && abs(dy) > abs(dx)) {
            // Inside the sheet only a downward pull from the top of its list
            // collapses it; anywhere else on the dock either direction drags.
            val allowed = if (startedInSheet) dy > 0 && !sheet.canScrollUp() else true
            if (allowed) {
              dragging = true
              spring?.cancel()
              baseY = ev.rawY
              baseProgress = progress
              parent?.requestDisallowInterceptTouchEvent(true)
              return true
            }
          }
        }
      }
      return false
    }

    override fun onTouchEvent(ev: MotionEvent): Boolean {
      if (!dragging) return super.onTouchEvent(ev)
      track(ev)
      when (ev.actionMasked) {
        MotionEvent.ACTION_MOVE -> {
          val travel = max(1, sheet.fullHeight)
          setProgress(baseProgress - (ev.rawY - baseY) / travel)
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          dragging = false
          tracker.computeCurrentVelocity(1000)
          // Progress per second: dragging up (negative y velocity) opens it.
          val velocity = -tracker.yVelocity / max(1, sheet.fullHeight)
          val open = if (ev.actionMasked == MotionEvent.ACTION_CANCEL) progress > 0.5f else progress + velocity * 0.12f > 0.5f
          commitTarget(open && sheet.hasRows)
          if (!targetExpanded) tabRow.setOpen(null)
          if (reducedMotion()) setProgress(if (targetExpanded) 1f else 0f)
          else settle(if (targetExpanded) 1f else 0f, velocity)
        }
      }
      return true
    }
  }

  // ---- the sheet -----------------------------------------------------------

  private data class RowSpec(
    val key: String,
    val label: String,
    val value: CharSequence,
    val spoken: String,
    /** A game page on the status sheet. */
    val path: String? = null,
    /** A menu row's target: a game page or an app action. */
    val link: DockLink? = null,
    val icon: PixelIcon? = null,
    /** Menu rows without an icon keep the icon's width free when other rows in the menu have one. */
    val indent: Boolean = false,
  ) {
    val opens: Boolean get() = path != null || link != null
  }

  /** One line of the sheet: a section heading or a row. */
  private sealed class Entry {
    class Heading(val key: String, val text: String) : Entry()
    class Row(val spec: RowSpec) : Entry()
  }

  /** Grows from zero to its content height as [reveal] goes 0..1, anchored to the strip below it. */
  private inner class SheetBox(context: Context) : FrameLayout(context) {
    var reveal = 0f
      set(value) {
        field = value
        getChildAt(0)?.alpha = min(1f, value * 1.6f)
        requestLayout()
      }
    var maxHeight = Int.MAX_VALUE
    var fullHeight = 0
      private set
    val hasRows: Boolean get() = rows.isNotEmpty()

    private val scroll = ScrollView(context)
    private val column = LinearLayout(context)
    private val caption = TextView(context)
    private val rows = LinkedHashMap<String, SheetRow>()
    private var turnRow: SheetRow? = null
    private var currentKeys: List<String> = emptyList()

    init {
      column.orientation = LinearLayout.VERTICAL
      column.setPadding(0, dp(14), 0, dp(4))
      caption.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
      caption.setTextColor(MUTED)
      caption.setPadding(dp(18), 0, dp(18), dp(6))
      caption.maxLines = 1
      caption.ellipsize = TextUtils.TruncateAt.END
      column.addView(caption)
      scroll.addView(column, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      scroll.isVerticalScrollBarEnabled = false
      scroll.overScrollMode = View.OVER_SCROLL_NEVER
      addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
      clipChildren = true
    }

    fun canScrollUp(): Boolean = scroll.canScrollVertically(-1)

    /** A short fade when one menu replaces another while the sheet stays open. */
    fun fadeIn() {
      column.animate().cancel()
      column.alpha = 0f
      column.animate().alpha(1f).setDuration(160).start()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
      val width = MeasureSpec.getSize(widthMeasureSpec)
      scroll.measure(
        MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
        MeasureSpec.makeMeasureSpec(maxHeight, MeasureSpec.AT_MOST),
      )
      fullHeight = scroll.measuredHeight
      setMeasuredDimension(width, (fullHeight * reveal).roundToInt())
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
      // Bottom aligned, so the rows slide up out of the strip as it opens.
      scroll.layout(0, (b - t) - scroll.measuredHeight, r - l, b - t)
    }

    fun bindStatus(next: DockStatus?, animate: Boolean) {
      val specs = if (next == null) emptyList() else statusSpecs(next)
      apply(next?.turnTitle.orEmpty(), null, specs.map { Entry.Row(it) }, animate)
    }

    fun bindMenu(menu: DockSheet, tabLabel: String, unread: Int) {
      val entries = ArrayList<Entry>()
      val anyIcon = menu.sections.any { section -> section.links.any { it.icon != null } }
      for (section in menu.sections) {
        if (section.title.isNotEmpty()) entries.add(Entry.Heading("section-${section.id}", section.title))
        for (link in section.links) {
          val badge = if (link.app == AppAction.INBOX && unread > 0) "$unread unread" else ""
          val spoken = if (badge.isNotEmpty()) "${link.label}, $badge" else link.label
          entries.add(Entry.Row(RowSpec("link-${section.id}-${link.id}", link.label, badge, spoken, link = link, icon = link.icon, indent = anyIcon)))
        }
      }
      apply(menu.title.ifEmpty { tabLabel }, menu.title.ifEmpty { tabLabel }, entries, animate = false)
    }

    private fun apply(title: String, paneTitle: String?, entries: List<Entry>, animate: Boolean) {
      val keys = entries.map { if (it is Entry.Row) it.spec.key else (it as Entry.Heading).key }
      caption.text = title
      caption.visibility = if (title.isEmpty()) View.GONE else View.VISIBLE
      ViewCompat.setAccessibilityPaneTitle(this, paneTitle ?: "Status details")
      if (keys != currentKeys) {
        for (index in column.childCount - 1 downTo 1) column.removeViewAt(index)
        rows.clear()
        turnRow = null
        for (entry in entries) {
          when (entry) {
            is Entry.Heading -> column.addView(heading(entry.text))
            is Entry.Row -> {
              val row = SheetRow(context)
              rows[entry.spec.key] = row
              if (entry.spec.key == "turn") turnRow = row
              column.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            }
          }
        }
        currentKeys = keys
        scroll.scrollTo(0, 0)
      }
      // The countdown row ticks by itself; everything else crossfades when a figure changes.
      for (entry in entries) {
        if (entry !is Entry.Row) continue
        rows[entry.spec.key]?.bind(entry.spec, animate && entry.spec.key != "turn") { spec ->
          closeSheet()
          if (spec.link != null) listener.onOpenLink(spec.link) else spec.path?.let { listener.onOpenPath(it) }
        }
      }
      // Collapsed, the sheet stays measured at zero height so a drag knows its travel.
      visibility = if (rows.isEmpty()) View.GONE else View.VISIBLE
      requestLayout()
    }

    private fun heading(text: String) = TextView(context).apply {
      this.text = text.uppercase()
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
      setTextColor(MUTED)
      letterSpacing = 0.08f
      setPadding(dp(18), dp(12), dp(18), dp(2))
      maxLines = 1
      ellipsize = TextUtils.TruncateAt.END
      ViewCompat.setAccessibilityHeading(this, true)
    }

    fun setCountdown(current: DockStatus, remaining: Long?) {
      val row = turnRow ?: return
      row.bindValue(turnValue(current, remaining), turnSpoken(current, remaining), animate = false)
    }

    private fun statusSpecs(s: DockStatus): List<RowSpec> {
      val out = ArrayList<RowSpec>()
      if (s.nextTurnAt != null || !s.turnActive) {
        val remaining = s.nextTurnAt?.minus(System.currentTimeMillis())
        out.add(RowSpec("turn", "Next turn", turnValue(s, remaining), turnSpoken(s, remaining)))
      }
      for ((key, metric) in listOf(
        "funds" to s.funds, "actions" to s.actions, "corp" to s.corpCash,
        "state" to s.stateInfluence, "national" to s.nationalInfluence,
      )) {
        if (metric != null) out.add(RowSpec(key, metric.label, metricText(metric), metric.spoken, path = metric.path))
      }
      val inbox = ArrayList<Pair<String, Int>>()
      if (s.notifications > 0) inbox.add("Notifications" to s.notifications)
      if (s.mail > 0) inbox.add("Mail" to s.mail)
      if (inbox.isEmpty()) {
        out.add(RowSpec("inbox", "Inbox", "All read", "Inbox, all read", path = "/notifications"))
      } else {
        for ((label, count) in inbox) {
          out.add(RowSpec("inbox-$label", label, "$count unread", "$label, $count unread", path = "/notifications"))
        }
      }
      return out
    }

    private fun turnValue(s: DockStatus, remaining: Long?): CharSequence {
      if (!s.turnActive) return "Paused"
      val at = s.nextTurnAt ?: return ""
      if (remaining == null || remaining <= 0) return "Running"
      val clock = android.text.format.DateFormat.getTimeFormat(context).format(java.util.Date(at))
      return "$clock · in ${DockFormat.countdown(remaining)}"
    }

    private fun turnSpoken(s: DockStatus, remaining: Long?): String {
      if (!s.turnActive) return "Next turn, turns are paused"
      if (remaining == null) return "Next turn"
      if (remaining <= 0) return "Next turn, running now"
      return "Next turn in ${DockFormat.spokenCountdown(remaining)}"
    }
  }

  private fun metricText(metric: DockMetric): CharSequence {
    val builder = SpannableStringBuilder(metric.value)
    if (metric.change != null) {
      val start = builder.length + 1
      builder.append(' ').append(metric.change)
      builder.setSpan(ForegroundColorSpan(if (metric.positive) GAIN else LOSS), start, builder.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    return builder
  }

  private fun ripple(): RippleDrawable =
    RippleDrawable(ColorStateList.valueOf(0x24FFFFFF), null, ColorDrawable(Color.WHITE))

  /** A label, a value that crossfades when it changes, and a chevron when the row opens a page. */
  private inner class SheetRow(context: Context) : LinearLayout(context) {
    private val icon = PixelIconView(context)
    private val label = TextView(context)
    private val value = FadeText(context, TEXT, 14f, bold = true)
    private val chevron = TextView(context)
    private var boundTarget: Any? = null

    init {
      orientation = HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      minimumHeight = dp(48)
      setPadding(dp(18), dp(4), dp(18), dp(4))
      label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
      label.setTextColor(MUTED)
      icon.setTint(MUTED)
      value.gravity = Gravity.END
      chevron.text = "›"
      chevron.setTextColor(MUTED)
      chevron.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
      addView(icon, LayoutParams(dp(20), dp(20)).also { it.marginEnd = dp(12) })
      icon.visibility = View.GONE
      if (resources.configuration.fontScale > 1.3f) {
        // Large text: the label sits above its figure so neither is squeezed.
        val stack = LinearLayout(context)
        stack.orientation = VERTICAL
        stack.addView(label)
        value.gravity = Gravity.START
        stack.addView(value)
        addView(stack, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
      } else {
        addView(label, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
        addView(value, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
      }
      addView(chevron, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).also { it.marginStart = dp(10) })
      ViewCompat.setAccessibilityDelegate(this, object : AccessibilityDelegateCompat() {
        override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfoCompat) {
          super.onInitializeAccessibilityNodeInfo(host, info)
          if (host.isClickable) info.className = android.widget.Button::class.java.name
        }
      })
    }

    fun bind(spec: RowSpec, animate: Boolean, open: (RowSpec) -> Unit) {
      label.text = spec.label
      // Menu rows are plain text on the primary color; status rows keep the muted label beside a bold figure.
      val menuRow = spec.link != null
      label.setTextColor(if (menuRow) TEXT else MUTED)
      value.setText(spec.value, animate)
      contentDescription = spec.spoken
      icon.setIcon(spec.icon)
      icon.visibility = if (spec.icon != null) View.VISIBLE else View.GONE
      // Rows without an icon line up with the ones that have one.
      label.setPadding(if (spec.indent && spec.icon == null) dp(32) else 0, 0, 0, 0)
      val target: Any? = spec.link ?: spec.path
      chevron.visibility = if (target == null) View.GONE else View.VISIBLE
      // Only touch the ripple when the target changes, so a refresh never cuts a press short.
      if (target != boundTarget || background == null && target != null) {
        boundTarget = target
        if (target == null) {
          isClickable = false
          background = null
          setOnClickListener(null)
        } else {
          background = ripple()
          setOnClickListener { open(spec) }
        }
      }
      isFocusable = true
    }

    fun bindValue(text: CharSequence, spoken: String, animate: Boolean) {
      value.setText(text, animate)
      contentDescription = spoken
    }
  }

  // ---- the strip -----------------------------------------------------------

  /**
   * Slim status line on top of the tab row. A tap or a drag opens the sheet.
   * The turn clock, funds and actions share one row; when the phone is narrow
   * or the font is large they wrap onto a second row instead of clipping.
   */
  private inner class Strip(context: Context) : ViewGroup(context) {
    private val grabber = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x40FFFFFF }
    private val turn = TextView(context)
    private val funds = FadeText(context, TEXT, 12f, bold = true)
    private val actions = FadeText(context, TEXT, 12f, bold = true)
    private val big = resources.configuration.fontScale > 1.2f

    private val gap = dp(12)
    private var rows: List<List<View>> = emptyList()

    init {
      setWillNotDraw(false)
      minimumHeight = dp(STRIP_HEIGHT_DP)
      setPadding(dp(18), dp(10), dp(18), dp(2))
      turn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
      turn.setTextColor(MUTED)
      turn.maxLines = if (big) 2 else 1
      turn.ellipsize = TextUtils.TruncateAt.END
      for (view in listOf(turn, funds, actions)) {
        addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      }
      background = ripple()
      isClickable = true
      isFocusable = true
      // One element for screen readers: the description carries the values.
      turn.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      funds.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      actions.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      setOnClickListener { if (targetExpanded && menuId == null) closeSheet() else openSheet(null, animate = true) }
      ViewCompat.setAccessibilityDelegate(this, object : AccessibilityDelegateCompat() {
        override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfoCompat) {
          super.onInitializeAccessibilityNodeInfo(host, info)
          info.className = android.widget.Button::class.java.name
          info.addAction(
            AccessibilityNodeInfoCompat.AccessibilityActionCompat(
              AccessibilityNodeInfo.ACTION_CLICK,
              if (targetExpanded && menuId == null) "Hide status details" else "Show status details",
            ),
          )
        }
      })
      refreshState()
    }

    fun refreshState() {
      ViewCompat.setStateDescription(this, if (targetExpanded && menuId == null) "Expanded" else "Collapsed")
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
      val width = MeasureSpec.getSize(widthMeasureSpec)
      val inner = max(0, width - paddingLeft - paddingRight)
      val shown = listOf<View>(turn, funds, actions).filter { it.visibility != View.GONE }
      val free = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
      for (view in shown) view.measure(MeasureSpec.makeMeasureSpec(inner, MeasureSpec.AT_MOST), free)
      // Fill a row until the next figure would not fit, then start another.
      val flowed = ArrayList<MutableList<View>>()
      var used = 0
      for (view in shown) {
        val need = view.measuredWidth + if (flowed.lastOrNull().isNullOrEmpty()) 0 else gap
        if (flowed.isEmpty() || used + need > inner) {
          flowed.add(mutableListOf(view)); used = view.measuredWidth
        } else {
          flowed.last().add(view); used += need
        }
      }
      rows = flowed
      var height = paddingTop + paddingBottom
      flowed.forEachIndexed { index, row -> height += row.maxOf { it.measuredHeight } + if (index > 0) dp(2) else 0 }
      setMeasuredDimension(width, max(height, suggestedMinimumHeight))
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
      val inner = (r - l) - paddingLeft - paddingRight
      val heights = rows.map { row -> row.maxOf { it.measuredHeight } }
      val content = heights.sum() + dp(2) * max(0, rows.size - 1)
      var y = paddingTop + max(0, ((b - t) - paddingTop - paddingBottom - content) / 2)
      rows.forEachIndexed { index, row ->
        val widths = row.sumOf { it.measuredWidth }
        // One figure sits in the middle; several spread edge to edge.
        val space = if (row.size > 1) (inner - widths) / (row.size - 1) else 0
        var x = paddingLeft + if (row.size == 1) (inner - widths) / 2 else 0
        for (view in row) {
          val top = y + (heights[index] - view.measuredHeight) / 2
          view.layout(x, top, x + view.measuredWidth, top + view.measuredHeight)
          x += view.measuredWidth + space
        }
        y += heights[index] + dp(2)
      }
    }

    override fun onDraw(canvas: Canvas) {
      super.onDraw(canvas)
      val half = dp(16).toFloat()
      val top = dp(6).toFloat()
      canvas.drawRoundRect(width / 2f - half, top, width / 2f + half, top + dp(4), dp(2).toFloat(), dp(2).toFloat(), grabber)
    }

    fun bind(next: DockStatus?, animate: Boolean) {
      funds.visibility = if (next?.funds == null) View.GONE else View.VISIBLE
      actions.visibility = if (next?.actions == null) View.GONE else View.VISIBLE
      requestLayout()
      next?.funds?.let { funds.setText(metricText(it), animate) }
      next?.actions?.let { actions.setText(it.value + " actions", animate) }
    }

    fun setCountdown(current: DockStatus, remaining: Long?) {
      val builder = SpannableStringBuilder()
      val label: String
      val time: String
      when {
        !current.turnActive -> { label = "Turns"; time = "paused" }
        remaining == null -> { label = ""; time = "" }
        remaining <= 0 -> { label = "Turn"; time = "running" }
        else -> { label = "Next turn"; time = DockFormat.countdown(remaining) }
      }
      builder.append(label)
      if (label.isNotEmpty() && time.isNotEmpty()) builder.append(' ')
      val start = builder.length
      builder.append(time)
      builder.setSpan(ForegroundColorSpan(TEXT), start, builder.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      turn.text = builder
      turn.visibility = if (builder.isEmpty()) View.GONE else View.VISIBLE
      // Spoken text changes by the minute, not the second.
      val spokenTime = when {
        !current.turnActive -> "Turns are paused"
        remaining == null -> ""
        remaining <= 0 -> "Turn running"
        else -> "Next turn in ${DockFormat.spokenCountdown(remaining)}"
      }
      val parts = listOf(spokenTime, current.funds?.spoken.orEmpty(), current.actions?.spoken.orEmpty()).filter { it.isNotEmpty() }
      val description = "Status. " + parts.joinToString(". ")
      if (contentDescription?.toString() != description) contentDescription = description
    }
  }

  /** Text that slides and fades to its new value instead of jumping. */
  private inner class FadeText(context: Context, color: Int, size: Float, bold: Boolean) : FrameLayout(context) {
    private val front = label(color, size, bold)
    private val back = label(color, size, bold)
    private var current: CharSequence = ""
    /** Where the text sits when this view is wider than it. */
    var gravity: Int = Gravity.START
      set(value) {
        field = value
        for (label in listOf(front, back)) {
          (label.layoutParams as LayoutParams).gravity = value
          label.requestLayout()
        }
      }

    init {
      addView(back, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
      addView(front, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
      back.alpha = 0f
    }

    private fun label(color: Int, size: Float, bold: Boolean) = TextView(context).apply {
      setTextColor(color)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
      maxLines = 1
      ellipsize = TextUtils.TruncateAt.END
      if (bold) typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }

    fun setText(text: CharSequence, animate: Boolean) {
      if (current.toString() == text.toString()) {
        // Same words; keep the spans (colors) current without any motion.
        front.text = text; current = text
        return
      }
      val first = current.isEmpty()
      current = text
      front.animate().cancel(); back.animate().cancel()
      if (!animate || first) {
        front.text = text; front.alpha = 1f; front.translationY = 0f
        back.alpha = 0f
        return
      }
      // The old value becomes the back label and floats up as the new one rises in.
      val rise = dp(7).toFloat()
      back.text = front.text
      back.alpha = 1f; back.translationY = 0f
      front.text = text
      front.alpha = 0f; front.translationY = rise
      back.animate().alpha(0f).translationY(-rise).setDuration(220).start()
      front.animate().alpha(1f).translationY(0f).setDuration(260).start()
    }
  }

  // ---- the tab row ---------------------------------------------------------

  private inner class TabRow(context: Context) : FrameLayout(context) {
    private val indicator = View(context)
    private val row = LinearLayout(context)
    private val tabs = LinkedHashMap<String, TabView>()
    private var shown: List<DockTab> = emptyList()
    private var selected: String? = null
    private var open: String? = null
    private var badge = 0
    private val move = SpringAnimation(indicator, DynamicAnimation.TRANSLATION_X, 0f).also {
      it.spring = SpringForce(0f).setStiffness(620f).setDampingRatio(0.74f)
    }

    init {
      minimumHeight = dp(TAB_HEIGHT_DP)
      indicator.background = GradientDrawable().apply { setColor(INDICATOR); cornerRadius = dp(16).toFloat() }
      indicator.alpha = 0f
      indicator.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      addView(indicator, LayoutParams(dp(64), dp(32)).also { it.topMargin = dp(5) })
      row.orientation = LinearLayout.HORIZONTAL
      addView(row, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    }

    /** Rebuilds the tabs when the game described different ones; the selection carries over by id. */
    fun setTabs(next: List<DockTab>) {
      if (next == shown) return
      shown = next
      row.removeAllViews()
      tabs.clear()
      for (tab in next) {
        val view = TabView(context, tab)
        tabs[tab.id] = view
        row.addView(view, LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
        view.setOnClickListener { tapped(tab, view) }
      }
      if (selected !in tabs) selected = null
      if (open !in tabs) open = null
      refreshVisual(animate = false)
      requestLayout()
    }

    private fun tapped(tab: DockTab, view: View) {
      val again = selected == tab.id
      // A light tick only when the tab actually changes.
      if (!again && open != tab.id) view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
      if (tab.sheet != null) {
        toggleMenu(tab.id)
        return
      }
      // Ask is a sheet over the current page, so the selection stays put.
      if (tab.app != AppAction.ASK) select(tab.id, !reducedMotion())
      if (targetExpanded) closeSheet()
      listener.onTab(tab, again)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
      super.onLayout(changed, l, t, r, b)
      if (changed) place(animate = false)
    }

    fun select(tab: String?, animate: Boolean) {
      if (tab == selected) return
      selected = tab
      refreshVisual(animate)
    }

    /** The menu tab whose sheet is open counts as selected while it is open. */
    fun setOpen(tab: String?) {
      if (tab == open) return
      open = tab
      refreshVisual(animate = !reducedMotion())
    }

    private fun refreshVisual(animate: Boolean) {
      val visual = open ?: selected
      for ((id, view) in tabs) view.setChecked(id == visual, animate)
      place(animate)
    }

    private fun place(animate: Boolean) {
      val tab = (open ?: selected)?.let { tabs[it] }
      if (tab == null || tab.width == 0) { indicator.alpha = 0f; return }
      val width = min(dp(64), max(dp(32), tab.width - dp(4)))
      if (indicator.layoutParams.width != width) { indicator.layoutParams.width = width; indicator.requestLayout() }
      val x = (row.left + tab.left + (tab.width - width) / 2).toFloat()
      val wasHidden = indicator.alpha == 0f
      indicator.alpha = 1f
      if (!animate || wasHidden) {
        move.cancel()
        indicator.translationX = x
      } else {
        move.animateToFinalPosition(x)
      }
    }

    fun setBadge(count: Int) {
      badge = count
      shown.firstOrNull { it.sheet == "more" }?.let { tabs[it.id]?.setBadge(count) }
    }
  }

  private inner class TabView(context: Context, private val tab: DockTab) : LinearLayout(context) {
    private val icon = PixelIconView(context)
    private val label = TextView(context)
    private val badge = TextView(context)
    private var checked = false
    private var count = 0
    private var tint = MUTED
    private var tintAnimator: ValueAnimator? = null
    private val springX = SpringAnimation(icon, DynamicAnimation.SCALE_X, 1f).also { it.spring = bounce() }
    private val springY = SpringAnimation(icon, DynamicAnimation.SCALE_Y, 1f).also { it.spring = bounce() }

    private fun bounce() = SpringForce(1f).setStiffness(520f).setDampingRatio(0.5f)

    init {
      orientation = VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      setPadding(0, dp(6), 0, dp(6))
      minimumHeight = dp(TAB_HEIGHT_DP)
      minimumWidth = dp(48)
      isClickable = true
      isFocusable = true
      background = ripple()

      val holder = FrameLayout(context)
      icon.setIcon(tab.icon)
      icon.setTint(MUTED)
      holder.addView(icon, FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER))
      badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f)
      badge.setTextColor(Color.WHITE)
      badge.gravity = Gravity.CENTER
      badge.minWidth = dp(16)
      badge.setPadding(dp(4), 0, dp(4), 0)
      badge.background = GradientDrawable().apply { setColor(RED); cornerRadius = dp(8).toFloat() }
      badge.visibility = View.GONE
      badge.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      holder.addView(badge, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(16), Gravity.TOP or Gravity.END))
      addView(holder, LayoutParams(dp(40), dp(24)))

      label.text = tab.label
      label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
      label.setTextColor(MUTED)
      label.maxLines = 1
      label.ellipsize = TextUtils.TruncateAt.END
      label.gravity = Gravity.CENTER
      label.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      addView(label, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).also { it.topMargin = dp(2) })
      describe()
      ViewCompat.setAccessibilityDelegate(this, object : AccessibilityDelegateCompat() {
        override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfoCompat) {
          super.onInitializeAccessibilityNodeInfo(host, info)
          info.roleDescription = "Tab"
          info.isSelected = checked
          if (tab.sheet != null) {
            info.addAction(
              AccessibilityNodeInfoCompat.AccessibilityActionCompat(
                AccessibilityNodeInfo.ACTION_CLICK,
                if (checked && targetExpanded && menuId == tab.id) "Close ${tab.label} menu" else "Open ${tab.label} menu",
              ),
            )
          }
        }
      })
    }

    fun setChecked(value: Boolean, animate: Boolean) {
      if (checked == value) return
      checked = value
      val to = if (value) RED else MUTED
      tintAnimator?.cancel()
      if (animate) {
        tintAnimator = ValueAnimator.ofObject(ArgbEvaluator(), tint, to).apply {
          duration = 180
          addUpdateListener { applyTint(it.animatedValue as Int) }
          start()
        }
        springX.animateToFinalPosition(if (value) 1.14f else 1f)
        springY.animateToFinalPosition(if (value) 1.14f else 1f)
      } else {
        applyTint(to)
        icon.scaleX = if (value) 1.14f else 1f
        icon.scaleY = icon.scaleX
      }
      ViewCompat.setStateDescription(this, if (value) "Selected" else null)
      isSelected = value
    }

    private fun applyTint(color: Int) {
      tint = color
      icon.setTint(color)
      label.setTextColor(color)
    }

    fun setBadge(value: Int) {
      if (value == count) return
      count = value
      badge.text = if (value > 99) "99+" else value.toString()
      badge.visibility = if (value > 0) View.VISIBLE else View.GONE
      describe()
    }

    private fun describe() {
      contentDescription = if (count > 0) "${tab.label}, $count unread" else tab.label
    }
  }
}
