package net.lakesidegames.briefing

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Canvas
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.text.Editable
import android.text.TextWatcher
import android.text.format.DateUtils
import android.view.Gravity
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.widget.NestedScrollView
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.bottomsheet.BottomSheetDragHandleView
import com.google.android.material.button.MaterialButton
import com.google.android.material.progressindicator.CircularProgressIndicator
import com.google.android.material.progressindicator.LinearProgressIndicator
import com.google.android.material.snackbar.BaseTransientBottomBar
import com.google.android.material.snackbar.Snackbar
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import java.util.Calendar

/** What the sheet asks of the app around it. */
internal interface AskSheetHost {
  fun linkAccount()
  fun openLink(url: String)
  fun pickPhoto(): Boolean
  fun rebuild()
  fun dismissed(sheet: AskSheet)
}

/** Starter questions for an empty chat. Tapping one fills the box. */
private fun askStarters() = listOf(
  T.s(R.string.ask_starter_missed),
  T.s(R.string.ask_starter_actions),
  T.s(R.string.ask_starter_turn),
)

/**
 * The Material 3 Ask sheet: a modal bottom sheet that goes full screen on
 * phones and stays a centered 640dp sheet on tablets and in landscape.
 * It only draws; AskSession owns the state and the network.
 */
internal class AskSheet(
  private val activity: Activity,
  private val session: AskSession,
  private val host: AskSheetHost
) : AskSessionListener {
  private val ui = AskUi.themed(activity)
  private val context: Context = ui.context
  val dialog = BottomSheetDialog(context)
  private val root = ui.vertical()
  private val dragHandle = BottomSheetDragHandleView(context)
  private val toolbar = MaterialToolbar(context)
  private val progress = LinearProgressIndicator(context)
  private val content = FrameLayout(context)
  private val chatScroll = NestedScrollView(context)
  private val thread = ui.vertical()
  private val historyRefresh = SwipeRefreshLayout(context)
  private val historyList = RecyclerView(context)
  private val historyEmpty = ui.vertical()
  private val historyPane = FrameLayout(context)
  private val stateScroll = NestedScrollView(context)
  private val statePane = ui.vertical()
  private val banner = ui.horizontal()
  private val bannerText = ui.text("", AskUi.Type.BODY_MEDIUM)
  private val composer = ui.vertical()
  private val attachmentStrip = HorizontalScrollView(context)
  private val attachmentRow = ui.horizontal()
  private val inputLayout = TextInputLayout(context, null, com.google.android.material.R.attr.textInputFilledStyle)
  private val input = TextInputEditText(inputLayout.context)
  private val attachButton = ui.iconButton(R.drawable.ask_ic_add_photo, T.s(R.string.ask_attach_photo)) { attach() }
  private val sendButton = MaterialButton(context, null, com.google.android.material.R.attr.materialIconButtonFilledStyle)
  private val hint = ui.text("", AskUi.Type.LABEL_MEDIUM, ui.onSurfaceVariant)
  private val historyAdapter = HistoryAdapter()
  private val messageViews = HashMap<Long, MessageViews>()
  private var renderedPhase: AskPhase? = null
  private var renderedStateKey = ""
  private var stickToBottom = true
  private var fullHeight = true
  private var bindingDraft = false
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private var systemTop = 0
  private val historyBack = object : OnBackPressedCallback(false) {
    override fun handleOnBackPressed() {
      NativeSafety.run("Ask back") {
        when {
          session.showingHistory -> { session.showingHistory = false; onChrome() }
          session.reviewingConsent -> { session.reviewingConsent = false; onChrome() }
        }
      }
    }
  }

  init {
    root.setBackgroundColor(ui.containerLow)
    buildToolbar()
    buildContent()
    buildBanner()
    buildComposer()
    root.addView(dragHandle, ui.matchWrap())
    root.addView(FrameLayout(context).apply {
      addView(toolbar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      addView(progress, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
    }, ui.matchWrap())
    root.addView(content, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    root.addView(banner, ui.matchWrap().apply { marginStart = ui.dp(16); marginEnd = ui.dp(16); bottomMargin = ui.dp(8) })
    root.addView(composer, ui.matchWrap())
    dialog.setContentView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    dialog.onBackPressedDispatcher.addCallback(historyBack)
    dialog.setOnShowListener { NativeSafety.run("Ask sheet shown") { applySize(); expand() } }
    dialog.setOnDismissListener {
      NativeSafety.run("Ask sheet dismissed") {
        session.detach(this)
        session.commitPendingDeletes()
        unregisterNetwork()
        host.dismissed(this)
      }
    }
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      NativeSafety.run("Ask insets") {
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        systemTop = bars.top
        view.setPadding(bars.left, topInset(), bars.right, Math.max(bars.bottom, ime.bottom))
        if (ime.bottom > 0 && stickToBottom) scrollToBottom(animate = false)
      }
      insets
    }
    // The sheet may sit below the status bar (older Android) or under it
    // (edge to edge): pad only for the part of the bar it actually covers.
    root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> root.post { updateTopInset() } }
    session.attach(this)
    bindDraft()
    onChrome()
    onThread()
    onHistory()
    onAttachments()
  }

  fun show() {
    dialog.show()
    registerNetwork()
    session.onSheetShown()
  }

  fun dismiss() {
    NativeSafety.run("Ask dismiss") { if (dialog.isShowing) dialog.dismiss() }
  }

  fun onConfigurationChanged(config: Configuration) {
    val night = (config.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    if (night != ui.night) {
      host.rebuild()
      return
    }
    root.post { NativeSafety.run("Ask resize") { applySize(); dialog.behavior.isDraggable = !fullHeight; ViewCompat.requestApplyInsets(root) } }
  }

  fun onPhotoPicked(uri: android.net.Uri?) {
    if (uri != null) session.attachPhoto(uri)
  }

  // ---- Layout ------------------------------------------------------------

  private fun updateTopInset() {
    NativeSafety.run("Ask top inset") {
      val wanted = topInset()
      if (root.paddingTop != wanted) root.setPadding(root.paddingLeft, wanted, root.paddingRight, root.paddingBottom)
    }
  }

  private fun topInset(): Int {
    if (!fullHeight || systemTop <= 0) return 0
    val location = IntArray(2)
    root.getLocationOnScreen(location)
    return Math.max(0, systemTop - location[1])
  }

  /** Full screen on compact windows, a 640dp sheet at 88% height elsewhere. */
  private fun applySize() {
    val config = activity.resources.configuration
    fullHeight = config.screenWidthDp < 600 || config.screenHeightDp < 600
    val sheet = dialog.findViewById<FrameLayout>(com.google.android.material.R.id.design_bottom_sheet) ?: return
    val metrics = activity.resources.displayMetrics
    sheet.layoutParams = sheet.layoutParams.apply {
      height = if (fullHeight) ViewGroup.LayoutParams.MATCH_PARENT else (metrics.heightPixels * 0.88f).toInt()
    }
    dialog.behavior.maxWidth = ui.dp(640)
    dragHandle.visibility = if (fullHeight) View.GONE else View.VISIBLE
    sheet.requestLayout()
  }

  private fun expand() {
    dialog.behavior.skipCollapsed = true
    dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
    // A full-screen sheet closes from its close button or Back, so scrolling
    // up through a long answer can never drag it away by accident.
    dialog.behavior.isDraggable = !fullHeight
    dialog.behavior.addBottomSheetCallback(object : BottomSheetBehavior.BottomSheetCallback() {
      override fun onStateChanged(bottomSheet: View, newState: Int) = updateTopInset()
      override fun onSlide(bottomSheet: View, slideOffset: Float) = updateTopInset()
    })
    dialog.window?.let { window ->
      @Suppress("DEPRECATION")
      window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or
        android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN)
      // Draw behind the system bars and pad the content instead.
      androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
      window.addFlags(android.view.WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS or
        android.view.WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN)
      window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
      if (Build.VERSION.SDK_INT >= 28) window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode = android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
      }
      @Suppress("DEPRECATION")
      window.statusBarColor = android.graphics.Color.TRANSPARENT
      @Suppress("DEPRECATION")
      window.navigationBarColor = android.graphics.Color.TRANSPARENT
      // The sheet content applies every inset itself. The dialog's own
      // containers and the behavior would otherwise pad it a second time.
      listOf(com.google.android.material.R.id.container, com.google.android.material.R.id.coordinator,
        com.google.android.material.R.id.design_bottom_sheet).forEach { id ->
        dialog.findViewById<View>(id)?.let { frame ->
          frame.fitsSystemWindows = false
          frame.setPadding(0, 0, 0, 0)
          ViewCompat.setOnApplyWindowInsetsListener(frame) { view, insets ->
            view.setPadding(0, 0, 0, 0)
            insets
          }
        }
      }
      androidx.core.view.WindowCompat.getInsetsController(window, window.decorView).apply {
        isAppearanceLightStatusBars = !ui.night
        isAppearanceLightNavigationBars = !ui.night
      }
    }
    ViewCompat.requestApplyInsets(root)
  }

  private fun buildToolbar() {
    toolbar.title = T.s(R.string.ask_title)
    toolbar.setTitleTextAppearance(context, ui.styleOf(AskUi.Type.TITLE_LARGE))
    toolbar.setSubtitleTextAppearance(context, ui.styleOf(AskUi.Type.BODY_SMALL))
    toolbar.setSubtitleTextColor(ui.onSurfaceVariant)
    toolbar.setTitleTextColor(ui.onSurface)
    toolbar.navigationIcon = ui.icon(R.drawable.ask_ic_close, ui.onSurfaceVariant)
    toolbar.navigationContentDescription = T.s(R.string.ask_close)
    toolbar.setNavigationOnClickListener {
      NativeSafety.run("Ask navigation") {
        when {
          session.showingHistory -> { session.showingHistory = false; onChrome() }
          session.reviewingConsent -> { session.reviewingConsent = false; onChrome() }
          else -> dismiss()
        }
      }
    }
    toolbar.overflowIcon = ui.icon(R.drawable.ask_ic_more, ui.onSurfaceVariant)
    val menu = toolbar.menu
    menu.add(Menu.NONE, MENU_NEW, 1, T.s(R.string.ask_menu_new)).apply {
      icon = ui.icon(R.drawable.ask_ic_add, ui.onSurfaceVariant)
      setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
    }
    menu.add(Menu.NONE, MENU_HISTORY, 2, T.s(R.string.ask_menu_history)).apply {
      icon = ui.icon(R.drawable.ask_ic_history, ui.onSurfaceVariant)
      setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
    }
    menu.add(Menu.NONE, MENU_SHARE, 3, T.s(R.string.ask_menu_share)).setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
    menu.add(Menu.NONE, MENU_REFRESH, 4, T.s(R.string.ask_menu_refresh)).setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
    menu.add(Menu.NONE, MENU_PROVIDERS, 5, T.s(R.string.ask_menu_providers)).setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
    toolbar.setOnMenuItemClickListener { item ->
      NativeSafety.run("Ask menu") {
        when (item.itemId) {
          MENU_NEW -> { session.newChat(); input.requestFocus() }
          MENU_HISTORY -> {
            session.showingHistory = true
            onChrome()
            session.loadHistory(silent = session.historyLoaded)
          }
          MENU_SHARE -> session.share()
          MENU_REFRESH -> if (session.showingHistory) session.loadHistory() else {
            session.refreshQuota()
            session.loadHistory(silent = true)
          }
          MENU_PROVIDERS -> { session.reviewingConsent = true; onChrome() }
        }
      }
      true
    }
    progress.isIndeterminate = true
    progress.setIndicatorColor(ui.accent)
    progress.trackColor = 0
    progress.trackThickness = ui.dp(3)
    progress.visibility = View.INVISIBLE
    progress.contentDescription = T.s(R.string.ask_loading)
  }

  private fun buildContent() {
    thread.setPadding(ui.dp(16), ui.dp(4), ui.dp(16), ui.dp(24))
    chatScroll.addView(thread, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    chatScroll.isFillViewport = true
    chatScroll.setBackgroundColor(ui.containerLow)
    chatScroll.overScrollMode = View.OVER_SCROLL_NEVER
    // A scroll container is not a control: no gray focus wash over the whole
    // thread when a keyboard or D-pad moves focus into it.
    if (Build.VERSION.SDK_INT >= 26) listOf<View>(chatScroll, stateScroll, historyList).forEach { it.defaultFocusHighlightEnabled = false }
    chatScroll.clipToPadding = false
    chatScroll.setOnScrollChangeListener(NestedScrollView.OnScrollChangeListener { view, _, scrollY, _, _ ->
      val child = view.getChildAt(0) ?: return@OnScrollChangeListener
      stickToBottom = child.height - (scrollY + view.height) < ui.dp(96)
    })
    content.addView(chatScroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

    historyList.layoutManager = LinearLayoutManager(context)
    historyList.adapter = historyAdapter
    historyList.clipToPadding = false
    historyList.setPadding(0, ui.dp(4), 0, ui.dp(24))
    ItemTouchHelper(SwipeToDelete()).attachToRecyclerView(historyList)
    historyRefresh.addView(historyList, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    historyRefresh.setColorSchemeColors(ui.accent)
    historyRefresh.setProgressBackgroundColorSchemeColor(ui.containerHigh)
    historyRefresh.setOnRefreshListener { NativeSafety.run("Ask history refresh") { session.loadHistory() } }
    historyPane.addView(historyRefresh, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    historyEmpty.gravity = Gravity.CENTER_HORIZONTAL
    historyEmpty.setPadding(ui.dp(32), ui.dp(48), ui.dp(32), ui.dp(32))
    historyPane.addView(historyEmpty, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    content.addView(historyPane, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

    statePane.setPadding(ui.dp(20), ui.dp(8), ui.dp(20), ui.dp(24))
    stateScroll.addView(statePane, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    stateScroll.isFillViewport = true
    content.addView(stateScroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  private fun buildBanner() {
    banner.background = ui.rounded(ui.secondaryContainer, 16f)
    banner.setPadding(ui.dp(16), ui.dp(12), ui.dp(16), ui.dp(12))
    bannerText.setTextColor(ui.onSecondaryContainer)
    banner.addView(bannerText, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    banner.visibility = View.GONE
    banner.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
  }

  private fun buildComposer() {
    composer.setPadding(ui.dp(12), ui.dp(4), ui.dp(12), ui.dp(8))
    attachmentStrip.isHorizontalScrollBarEnabled = false
    attachmentStrip.addView(attachmentRow)
    attachmentStrip.visibility = View.GONE
    composer.addView(attachmentStrip, ui.matchWrap(bottom = 8).apply { marginStart = ui.dp(4) })

    val row = ui.horizontal()
    row.gravity = Gravity.BOTTOM
    row.addView(attachButton, LinearLayout.LayoutParams(ui.dp(48), ui.dp(56)))
    inputLayout.isHintEnabled = false
    inputLayout.boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_FILLED
    inputLayout.boxBackgroundColor = ui.containerHigh
    val radius = ui.dpf(28f)
    inputLayout.setBoxCornerRadii(radius, radius, radius, radius)
    inputLayout.boxStrokeWidth = 0
    inputLayout.boxStrokeWidthFocused = 0
    inputLayout.addView(input, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    input.hint = T.s(R.string.ask_input_hint)
    input.setHintTextColor(ui.onSurfaceVariant)
    input.setTextColor(ui.onSurface)
    input.textSize = 16f
    input.minHeight = ui.dp(56)
    input.maxLines = 5
    input.setPadding(ui.dp(18), ui.dp(16), ui.dp(16), ui.dp(16))
    input.imeOptions = EditorInfo.IME_ACTION_SEND or EditorInfo.IME_FLAG_NO_EXTRACT_UI
    input.setRawInputType(android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or
      android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE)
    input.contentDescription = T.s(R.string.ask_input_desc)
    input.setOnEditorActionListener { _, action, _ ->
      if (action == EditorInfo.IME_ACTION_SEND) { NativeSafety.run("Ask send key") { send() }; true } else false
    }
    row.addView(inputLayout, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
      marginStart = ui.dp(2); marginEnd = ui.dp(6)
    })
    sendButton.iconSize = ui.dp(22)
    sendButton.insetTop = 0
    sendButton.insetBottom = 0
    sendButton.minWidth = ui.dp(56)
    sendButton.minHeight = ui.dp(56)
    sendButton.minimumWidth = ui.dp(56)
    sendButton.minimumHeight = ui.dp(56)
    sendButton.iconPadding = 0
    sendButton.iconGravity = MaterialButton.ICON_GRAVITY_TEXT_START
    sendButton.setPadding(ui.dp(17), ui.dp(17), ui.dp(17), ui.dp(17))
    sendButton.setOnClickListener {
      NativeSafety.run("Ask send button") { if (session.sending) session.stop() else send() }
    }
    row.addView(sendButton, LinearLayout.LayoutParams(ui.dp(56), ui.dp(56)))
    composer.addView(row, ui.matchWrap())
    hint.setPadding(ui.dp(16), ui.dp(6), ui.dp(16), 0)
    hint.gravity = Gravity.CENTER_HORIZONTAL
    composer.addView(hint, ui.matchWrap())
  }

  private fun bindDraft() {
    bindingDraft = true
    input.setText(session.draft)
    input.setSelection(input.text?.length ?: 0)
    bindingDraft = false
    input.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) {
        NativeSafety.run("Ask draft") {
          if (bindingDraft) return@run
          session.draft = s?.toString().orEmpty()
          refreshSend()
        }
      }
    })
  }

  private fun send() {
    val question = input.text?.toString().orEmpty()
    if (!session.canSend(question)) {
      val length = question.trim().length
      when {
        session.uploading -> snack(T.s(R.string.ask_snack_wait_photo))
        length in 1..4 -> snack(T.s(R.string.ask_snack_longer))
        length > 500 -> snack(T.s(R.string.ask_snack_too_long))
      }
      return
    }
    stickToBottom = true
    session.send(question)
    bindingDraft = true
    input.setText(session.draft)
    bindingDraft = false
    refreshSend()
  }

  private fun attach() {
    if (!host.pickPhoto()) snack(T.s(R.string.ask_snack_no_photos))
  }

  // ---- Session callbacks ---------------------------------------------------

  override fun onChrome() {
    val phase = session.phase
    val ready = phase == AskPhase.READY && !session.reviewingConsent
    val history = ready && session.showingHistory
    historyBack.isEnabled = session.showingHistory || session.reviewingConsent

    toolbar.title = if (history) T.s(R.string.ask_history) else T.s(R.string.ask_title)
    toolbar.subtitle = when {
      history -> null
      phase == AskPhase.CHECKING -> T.s(R.string.ask_checking)
      phase == AskPhase.SIGNED_OUT -> T.s(R.string.ask_not_linked)
      session.profileName.isNotBlank() -> T.s(R.string.ask_signed_in_as, session.profileName)
      else -> null
    }
    val back = history || session.reviewingConsent
    toolbar.navigationIcon = ui.icon(if (back) R.drawable.ask_ic_back else R.drawable.ask_ic_close, ui.onSurfaceVariant)
    toolbar.navigationContentDescription = if (back) T.s(R.string.ask_back_to_chat) else T.s(R.string.ask_close)
    toolbar.menu.findItem(MENU_NEW)?.isVisible = ready && (history || session.messages.isNotEmpty())
    toolbar.menu.findItem(MENU_HISTORY)?.isVisible = ready && !history
    toolbar.menu.findItem(MENU_SHARE)?.isVisible = ready && !history
    toolbar.menu.findItem(MENU_SHARE)?.isEnabled = session.conversationID.isNotBlank() && !session.sending
    toolbar.menu.findItem(MENU_REFRESH)?.isVisible = ready
    toolbar.menu.findItem(MENU_PROVIDERS)?.isVisible = session.consented && ready

    progress.visibility = if (session.checking || session.loadingConversation) View.VISIBLE else View.INVISIBLE

    chatScroll.visibility = if (ready && !history) View.VISIBLE else View.GONE
    historyPane.visibility = if (history) View.VISIBLE else View.GONE
    stateScroll.visibility = if (!ready) View.VISIBLE else View.GONE
    composer.visibility = if (ready && !history) View.VISIBLE else View.GONE
    if (!ready) renderState()
    else renderedStateKey = ""
    if (ready && !history && session.messages.isEmpty()) renderEmptyOrLoading()

    val usage = session.usage
    val bannerCopy = when {
      !ready || history -> null
      !session.online() -> T.s(R.string.ask_offline_ready)
      usage?.outOfQuestions == true -> if (usage.resetAt > 0)
        T.s(R.string.ask_banner_used_reset, askResetIn(usage.resetAt)) else T.s(R.string.ask_banner_used)
      else -> null
    }
    banner.visibility = if (bannerCopy == null) View.GONE else View.VISIBLE
    bannerText.text = bannerCopy.orEmpty()

    hint.text = hintCopy()
    hint.visibility = if (hint.text.isNullOrBlank()) View.GONE else View.VISIBLE
    attachButton.isEnabled = !session.sending
    refreshSend()
  }

  private fun hintCopy(): String {
    val usage = session.usage ?: return ""
    if (usage.limit <= 0) return ""
    val parts = mutableListOf<String>()
    parts += T.s(R.string.ask_questions_left, askCount(usage.remaining), askCount(usage.limit))
    val left = session.followupsLeft
    if (session.conversationID.isNotBlank() && left != null) parts += if (left > 0) T.n(R.plurals.ask_followups_left, left, left) else T.s(R.string.ask_no_followups)
    else if (usage.resetAt > 0 && usage.remaining <= 3) parts += T.s(R.string.ask_resets_in, askResetIn(usage.resetAt))
    return parts.joinToString(" · ")
  }

  private fun refreshSend() {
    val sending = session.sending
    val question = input.text?.toString().orEmpty()
    val ready = session.canSend(question)
    sendButton.icon = ui.icon(if (sending) R.drawable.ask_ic_stop else R.drawable.ask_ic_send, ui.onAccent)
    sendButton.contentDescription = if (sending) T.s(R.string.ask_stop_answer) else T.s(R.string.ask_send_question)
    TooltipCompatSafe.set(sendButton, if (sending) T.s(R.string.ask_tip_stop) else T.s(R.string.ask_tip_send))
    sendButton.isEnabled = sending || ready
    sendButton.backgroundTintList = ColorStateList.valueOf(when {
      sending -> ui.onSurfaceVariant
      ready -> ui.accent
      else -> ui.withAlpha(ui.onSurface, 0.12f)
    })
    sendButton.iconTint = ColorStateList.valueOf(when {
      sending -> ui.surface
      ready -> ui.onAccent
      else -> ui.withAlpha(ui.onSurface, 0.38f)
    })
    input.isEnabled = session.phase == AskPhase.READY
  }

  override fun onThread() {
    if (session.messages.isNotEmpty() && appendIfNew()) { onChrome(); return }
    thread.removeAllViews()
    thread.tag = null
    messageViews.clear()
    if (session.messages.isEmpty()) {
      renderEmptyOrLoading()
      onChrome()
      return
    }
    session.messages.forEachIndexed { index, message ->
      val views = MessageViews(message)
      messageViews[message.localId] = views
      thread.addView(views.root, ui.matchWrap(top = if (index == 0) 8 else 28))
      views.bind()
    }
    refreshFollowups()
    stickToBottom = true
    scrollToBottom(animate = false)
    onChrome()
  }

  override fun onMessage(message: AskMessage) {
    val views = messageViews[message.localId]
    if (views == null) {
      if (session.messages.contains(message)) onThread()
      return
    }
    views.bind()
    refreshFollowups()
    if (stickToBottom) scrollToBottom(animate = message.state != AskMessageState.STREAMING)
  }

  /** The thread grew a new question: animate it in rather than redrawing everything. */
  private fun appendIfNew(): Boolean {
    val last = session.messages.lastOrNull() ?: return false
    if (messageViews.containsKey(last.localId) || messageViews.size != session.messages.size - 1) return false
    if (session.messages.dropLast(1).any { !messageViews.containsKey(it.localId) }) return false
    if (messageViews.isEmpty()) { thread.removeAllViews(); thread.tag = null }
    val views = MessageViews(last)
    messageViews[last.localId] = views
    thread.addView(views.root, ui.matchWrap(top = if (session.messages.size == 1) 8 else 28))
    views.bind()
    ui.arrive(views.root)
    refreshFollowups()
    scrollToBottom(animate = true)
    return true
  }

  override fun onHistory() {
    historyRefresh.isRefreshing = session.historyLoading && session.historyLoaded
    historyAdapter.submit(session.history)
    historyEmpty.removeAllViews()
    val empty = session.history.isEmpty()
    historyEmpty.visibility = if (empty) View.VISIBLE else View.GONE
    if (!empty) return
    when {
      session.historyLoading && !session.historyLoaded -> {
        historyEmpty.gravity = Gravity.START
        historyEmpty.setPadding(ui.dp(16), ui.dp(12), ui.dp(16), 0)
        repeat(5) { historyEmpty.addView(skeletonRow(), ui.matchWrap(bottom = 12)) }
      }
      session.historyError.isNotBlank() -> {
        historyEmpty.gravity = Gravity.CENTER_HORIZONTAL
        historyEmpty.setPadding(ui.dp(32), ui.dp(48), ui.dp(32), ui.dp(32))
        historyEmpty.addView(ui.badge(R.drawable.ask_ic_history))
        historyEmpty.addView(centered(T.s(R.string.ask_history_failed), AskUi.Type.TITLE_MEDIUM, ui.onSurface), ui.matchWrap(top = 16))
        historyEmpty.addView(centered(session.historyError, AskUi.Type.BODY_MEDIUM, ui.onSurfaceVariant), ui.matchWrap(top = 6))
        historyEmpty.addView(ui.outlinedButton(T.s(R.string.ask_try_again)) { session.loadHistory() }, ui.wrap(top = 16))
      }
      else -> {
        historyEmpty.gravity = Gravity.CENTER_HORIZONTAL
        historyEmpty.setPadding(ui.dp(32), ui.dp(48), ui.dp(32), ui.dp(32))
        historyEmpty.addView(ui.badge(R.drawable.ask_ic_history))
        historyEmpty.addView(centered(T.s(R.string.ask_no_chats), AskUi.Type.TITLE_MEDIUM, ui.onSurface), ui.matchWrap(top = 16))
        historyEmpty.addView(centered(T.s(R.string.ask_no_chats_body),
          AskUi.Type.BODY_MEDIUM, ui.onSurfaceVariant), ui.matchWrap(top = 6))
      }
    }
  }

  override fun onAttachments() {
    attachmentRow.removeAllViews()
    attachmentStrip.visibility = if (session.attachments.isEmpty()) View.GONE else View.VISIBLE
    session.attachments.forEach { attachment ->
      val frame = FrameLayout(context)
      val image = ImageView(context).apply {
        scaleType = ImageView.ScaleType.CENTER_CROP
        background = ui.rounded(ui.containerHighest, 12f)
        clipToOutline = true
        attachment.thumbnail?.let(::setImageBitmap)
        contentDescription = when {
          attachment.error != null -> T.s(R.string.ask_photo_failed)
          attachment.uploading -> T.s(R.string.ask_photo_uploading)
          else -> T.s(R.string.ask_photo_attached)
        }
        alpha = if (attachment.error != null) 0.4f else 1f
      }
      frame.addView(image, FrameLayout.LayoutParams(ui.dp(64), ui.dp(64)).apply { topMargin = ui.dp(6); marginEnd = ui.dp(6) })
      if (attachment.uploading) {
        frame.addView(CircularProgressIndicator(context).apply {
          isIndeterminate = true
          indicatorSize = ui.dp(22)
          trackThickness = ui.dp(2)
          setIndicatorColor(ui.accent)
        }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply {
          topMargin = ui.dp(6); marginEnd = ui.dp(6)
        })
      }
      val remove = MaterialButton(context, null, com.google.android.material.R.attr.materialIconButtonFilledStyle).apply {
        icon = ui.icon(R.drawable.ask_ic_close, ui.surface)
        iconSize = ui.dp(14)
        iconPadding = 0
        insetTop = 0
        insetBottom = 0
        minWidth = ui.dp(24); minHeight = ui.dp(24); minimumWidth = ui.dp(24); minimumHeight = ui.dp(24)
        setPadding(ui.dp(5), ui.dp(5), ui.dp(5), ui.dp(5))
        backgroundTintList = ColorStateList.valueOf(ui.onSurfaceVariant)
        contentDescription = T.s(R.string.ask_remove_photo)
        setOnClickListener { NativeSafety.run("Ask remove photo") { session.removeAttachment(attachment) } }
      }
      // 24dp visual, 48dp touch target via the expanded hit rect below.
      frame.addView(remove, FrameLayout.LayoutParams(ui.dp(24), ui.dp(24), Gravity.TOP or Gravity.END))
      frame.post {
        NativeSafety.run("Ask remove target") {
          val rect = android.graphics.Rect()
          remove.getHitRect(rect)
          rect.inset(-ui.dp(12), -ui.dp(12))
          frame.touchDelegate = android.view.TouchDelegate(rect, remove)
        }
      }
      attachmentRow.addView(frame, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        marginEnd = ui.dp(8)
      })
    }
    refreshSend()
  }

  override fun onSnack(text: String, action: String?, onAction: (() -> Unit)?) = snack(text, action, onAction)

  override fun onShareLink(url: String) {
    NativeSafety.run("Ask share sheet") {
      val title = session.history.firstOrNull { it.id == session.conversationID }?.title ?: "A House Divided"
      val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, T.s(R.string.ask_share_subject, title))
        putExtra(Intent.EXTRA_TEXT, url)
      }
      activity.startActivity(Intent.createChooser(send, T.s(R.string.ask_menu_share)))
    }
  }

  private fun snack(text: String, action: String? = null, onAction: (() -> Unit)? = null, onGone: ((Boolean) -> Unit)? = null) {
    NativeSafety.run("Ask snackbar") {
      val bar = Snackbar.make(root, text, if (action != null) Snackbar.LENGTH_LONG else Snackbar.LENGTH_SHORT)
      if (composer.visibility == View.VISIBLE && composer.isAttachedToWindow) bar.anchorView = composer
      if (action != null && onAction != null) bar.setAction(action) { NativeSafety.run("Ask snackbar action") { onAction() } }
      bar.setActionTextColor(ui.color(com.google.android.material.R.attr.colorPrimaryInverse, ui.link))
      if (onGone != null) bar.addCallback(object : BaseTransientBottomBar.BaseCallback<Snackbar>() {
        override fun onDismissed(transientBottomBar: Snackbar?, event: Int) {
          NativeSafety.run("Ask snackbar gone") { onGone(event == DISMISS_EVENT_ACTION) }
        }
      })
      bar.show()
    }
  }

  // ---- Panes ---------------------------------------------------------------

  private fun renderEmptyOrLoading() {
    if (session.messages.isNotEmpty()) return
    val key = if (session.loadingConversation) "loading" else "empty"
    if (thread.tag == key && thread.childCount > 0) return
    thread.tag = key
    thread.removeAllViews()
    if (session.loadingConversation) {
      thread.addView(skeletonMessage(), ui.matchWrap(top = 16))
      thread.addView(skeletonMessage(), ui.matchWrap(top = 32))
      return
    }
    val column = ui.vertical().apply { gravity = Gravity.CENTER_HORIZONTAL }
    column.addView(ui.badge(R.drawable.ask_ic_forum, 64))
    column.addView(centered(T.s(R.string.ask_intro_title), AskUi.Type.TITLE_LARGE, ui.onSurface).apply {
      ViewCompat.setAccessibilityHeading(this, true)
    }, ui.matchWrap(top = 16))
    column.addView(centered(T.s(R.string.ask_intro_body),
      AskUi.Type.BODY_MEDIUM, ui.onSurfaceVariant), ui.matchWrap(top = 8))
    column.addView(ui.text(T.s(R.string.ask_try_asking), AskUi.Type.LABEL_LARGE, ui.onSurfaceVariant), ui.matchWrap(top = 28, bottom = 8))
    askStarters().forEach { starter ->
      column.addView(suggestion(starter, R.drawable.ask_ic_arrow_outward) {
        input.setText(starter)
        input.setSelection(starter.length)
        input.requestFocus()
      }, ui.matchWrap(bottom = 8))
    }
    thread.addView(column, ui.matchWrap(top = 24))
    thread.tag = key
  }

  /** Signed out, unavailable, checking, or the consent screen. */
  private fun renderState() {
    val key = "${session.phase}|${session.reviewingConsent}|${session.checking}|${session.unavailableMessage}|${session.recipients.size}|${session.consented}"
    if (key == renderedStateKey) return
    renderedStateKey = key
    statePane.removeAllViews()
    when {
      session.reviewingConsent || session.phase == AskPhase.CONSENT -> consent(review = session.reviewingConsent && session.consented)
      session.phase == AskPhase.SIGNED_OUT -> linkCard()
      session.phase == AskPhase.UNAVAILABLE -> unavailable()
      else -> repeat(3) { statePane.addView(skeletonMessage(), ui.matchWrap(top = if (it == 0) 16 else 32)) }
    }
    renderedPhase = session.phase
  }

  private fun linkCard() {
    val column = ui.vertical().apply { gravity = Gravity.CENTER_HORIZONTAL }
    column.addView(ui.badge(R.drawable.ask_ic_link, 64))
    column.addView(centered(T.s(R.string.ask_link_title), AskUi.Type.TITLE_LARGE, ui.onSurface), ui.matchWrap(top = 16))
    column.addView(centered(T.s(R.string.ask_link_body), AskUi.Type.BODY_MEDIUM, ui.onSurfaceVariant), ui.matchWrap(top = 8))
    column.addView(ui.filledButton(T.s(R.string.ask_link_button)) { host.linkAccount() }, ui.matchWrap(top = 24))
    column.addView(ui.textButton(T.s(R.string.ask_link_done)) { session.connect() }, ui.matchWrap(top = 4))
    if (session.linkError.isNotBlank()) {
      column.addView(centered(session.linkError, AskUi.Type.BODY_SMALL, ui.error), ui.matchWrap(top = 8))
    }
    statePane.addView(column, ui.matchWrap(top = 32))
  }

  private fun unavailable() {
    val column = ui.vertical().apply { gravity = Gravity.CENTER_HORIZONTAL }
    column.addView(ui.badge(R.drawable.ask_ic_refresh, 64))
    column.addView(centered(T.s(R.string.ask_connect_failed), AskUi.Type.TITLE_LARGE, ui.onSurface), ui.matchWrap(top = 16))
    column.addView(centered(session.unavailableMessage, AskUi.Type.BODY_MEDIUM, ui.onSurfaceVariant), ui.matchWrap(top = 8))
    column.addView(ui.filledButton(if (session.checking) T.s(R.string.ask_trying_again) else T.s(R.string.ask_try_again)) { session.connect() }.apply {
      isEnabled = !session.checking
    }, ui.matchWrap(top = 24))
    statePane.addView(column, ui.matchWrap(top = 32))
  }

  /** The consent screen. Nothing reaches an outside service until Allow. */
  private fun consent(review: Boolean) {
    statePane.addView(ui.text(T.s(R.string.ask_consent_title), AskUi.Type.HEADLINE_SMALL, ui.onSurface).apply {
      ViewCompat.setAccessibilityHeading(this, true)
    }, ui.matchWrap(top = 8))
    statePane.addView(ui.text(
      T.s(R.string.ask_consent_body),
      AskUi.Type.BODY_MEDIUM, ui.onSurfaceVariant), ui.matchWrap(top = 12))
    val list = ui.vertical().apply {
      background = ui.rounded(ui.containerLow, 16f, ui.outlineVariant)
      setPadding(ui.dp(16), ui.dp(4), ui.dp(16), ui.dp(4))
    }
    session.recipients.forEachIndexed { index, (name, detail) ->
      if (index > 0) list.addView(View(context).apply { setBackgroundColor(ui.outlineVariant) },
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ui.dp(1)))
      val item = ui.vertical().apply { setPadding(0, ui.dp(12), 0, ui.dp(12)) }
      item.addView(ui.text(name, AskUi.Type.TITLE_SMALL, ui.onSurface))
      if (detail.isNotBlank()) item.addView(ui.text(detail, AskUi.Type.BODY_SMALL, ui.onSurfaceVariant), ui.matchWrap(top = 2))
      list.addView(item, ui.matchWrap())
    }
    statePane.addView(list, ui.matchWrap(top = 16))
    statePane.addView(ui.text(T.s(R.string.ask_consent_terms),
      AskUi.Type.BODY_SMALL, ui.onSurfaceVariant), ui.matchWrap(top = 12))
    statePane.addView(ui.textButton(T.s(R.string.ask_consent_privacy)) { host.openLink(NativeAskConsent.PRIVACY_URL) }.apply {
      gravity = Gravity.START or Gravity.CENTER_VERTICAL
      setPadding(0, paddingTop, 0, paddingBottom)
    }, ui.wrap(top = 2))
    if (review) {
      statePane.addView(ui.filledButton(T.s(R.string.ask_consent_keep)) { session.reviewingConsent = false; onChrome() }, ui.matchWrap(top = 16))
      statePane.addView(ui.outlinedButton(T.s(R.string.ask_consent_withdraw)) { session.withdrawConsent() }, ui.matchWrap(top = 8))
    } else {
      statePane.addView(ui.filledButton(T.s(R.string.ask_consent_allow)) { session.grantConsent() }, ui.matchWrap(top = 16))
      statePane.addView(centered(T.s(R.string.ask_consent_nothing), AskUi.Type.BODY_SMALL, ui.onSurfaceVariant), ui.matchWrap(top = 10))
    }
  }

  // ---- Pieces --------------------------------------------------------------

  private fun centered(value: String, appearance: Int, color: Int): TextView =
    ui.text(value, appearance, color).apply { gravity = Gravity.CENTER_HORIZONTAL }

  /** A full-width suggestion: wraps to two lines where a chip would cut the text off. */
  private fun suggestion(value: String, iconRes: Int, onTap: () -> Unit): View {
    val row = ui.horizontal().apply {
      background = android.graphics.drawable.RippleDrawable(ColorStateList.valueOf(ui.withAlpha(ui.onSurface, 0.12f)),
        ui.rounded(ui.surface, 12f, ui.outlineVariant), ui.rounded(ui.onSurface, 12f))
      setPadding(ui.dp(16), ui.dp(12), ui.dp(12), ui.dp(12))
      minimumHeight = ui.dp(48)
      isClickable = true
      isFocusable = true
      contentDescription = value
      setOnClickListener { NativeSafety.run("Ask suggestion") { onTap() } }
    }
    row.addView(ui.text(value, AskUi.Type.LABEL_LARGE, ui.onSurface).apply {
      maxLines = 3
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    row.addView(ui.iconView(iconRes, ui.onSurfaceVariant, 18), LinearLayout.LayoutParams(ui.dp(18), ui.dp(18)).apply { marginStart = ui.dp(12) })
    return row
  }

  private fun skeletonBar(width: Float, height: Int = 14): View = View(context).apply {
    background = ui.rounded(ui.containerHighest, 7f)
    layoutParams = LinearLayout.LayoutParams(0, ui.dp(height), width)
    pulse(this)
  }

  private fun skeletonLine(fraction: Float): View = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    weightSum = 1f
    addView(skeletonBar(fraction))
  }

  private fun skeletonMessage(): View = ui.vertical().apply {
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    addView(LinearLayout(context).apply {
      gravity = Gravity.END
      weightSum = 1f
      addView(View(context).apply {
        background = ui.rounded(ui.containerHigh, 20f)
        layoutParams = LinearLayout.LayoutParams(0, ui.dp(40), 0.6f)
        pulse(this)
      })
    }, ui.matchWrap())
    listOf(0.95f, 0.88f, 0.92f, 0.55f).forEachIndexed { index, fraction ->
      addView(skeletonLine(fraction), ui.matchWrap(top = if (index == 0) 20 else 10))
    }
  }

  private fun skeletonRow(): View = ui.horizontal().apply {
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    addView(View(context).apply { background = ui.circle(ui.containerHighest); pulse(this) }, LinearLayout.LayoutParams(ui.dp(40), ui.dp(40)))
    addView(ui.vertical().apply {
      addView(skeletonLine(0.8f), ui.matchWrap())
      addView(skeletonLine(0.4f), ui.matchWrap(top = 8))
    }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = ui.dp(16) })
  }

  /** Loading placeholders breathe instead of spinning. */
  private fun pulse(view: View) {
    android.animation.ObjectAnimator.ofFloat(view, View.ALPHA, 1f, 0.45f).apply {
      duration = 900
      repeatMode = android.animation.ValueAnimator.REVERSE
      repeatCount = android.animation.ValueAnimator.INFINITE
      startDelay = 0
      view.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(v: View) { NativeSafety.run("Ask pulse") { start() } }
        override fun onViewDetachedFromWindow(v: View) { NativeSafety.run("Ask pulse stop") { cancel() } }
      })
    }
  }

  private fun scrollToBottom(animate: Boolean) {
    chatScroll.post {
      NativeSafety.run("Ask scroll") {
        val child = chatScroll.getChildAt(0) ?: return@run
        val target = Math.max(0, child.height - chatScroll.height)
        if (animate) chatScroll.smoothScrollTo(0, target) else chatScroll.scrollTo(0, target)
      }
    }
  }

  private fun refreshFollowups() {
    val last = session.messages.lastOrNull()
    messageViews.values.forEach { it.showFollowups(it.message === last && !session.sending) }
  }

  private fun copy(message: AskMessage) {
    NativeSafety.run("Ask copy") {
      val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      clipboard.setPrimaryClip(ClipData.newPlainText(T.s(R.string.ask_clip_label), message.answer))
      // Android 13+ shows its own clipboard confirmation.
      if (Build.VERSION.SDK_INT < 33) snack(T.s(R.string.ask_answer_copied))
    }
  }

  // ---- One question and answer --------------------------------------------

  private inner class MessageViews(val message: AskMessage) {
    val root = ui.vertical()
    private val question = ui.text(message.question, AskUi.Type.BODY_LARGE, ui.onPrimaryContainer)
    private val photos = ui.horizontal()
    private val answer = ui.vertical()
    private val status = ui.horizontal()
    private val statusText = ui.text("", AskUi.Type.BODY_MEDIUM, ui.onSurfaceVariant)
    private val placeholder = ui.vertical()
    private val notice = ui.vertical()
    private val meta = ui.vertical()
    private val actions = ui.horizontal()
    private val followups = ui.vertical()
    private val copyButton = ui.iconButton(R.drawable.ask_ic_copy, T.s(R.string.ask_copy_answer)) { copy(message) }
    private val upButton = ui.iconButton(R.drawable.ask_ic_thumb_up, T.s(R.string.ask_helpful)) { session.feedback(message, "up") }
    private val downButton = ui.iconButton(R.drawable.ask_ic_thumb_down, T.s(R.string.ask_not_helpful)) { session.feedback(message, "down") }
    private val shareButton = ui.iconButton(R.drawable.ask_ic_share, T.s(R.string.ask_menu_share)) { session.share() }
    private var renderedText: String? = null
    private var renderedState: AskMessageState? = null
    private val markdown = AskMarkdownRenderer(ui, { host.openLink(it) }, ::mapInto)
    private var sourcesOpen = false

    init {
      val bubbleRow = LinearLayout(context).apply { gravity = Gravity.END }
      question.background = ui.rounded(ui.primaryContainer, 20f).apply {
        val r = ui.dpf(20f); val tail = ui.dpf(6f)
        cornerRadii = floatArrayOf(r, r, tail, tail, r, r, r, r)
      }
      question.setPadding(ui.dp(16), ui.dp(10), ui.dp(16), ui.dp(10))
      question.setTextIsSelectable(true)
      bubbleRow.addView(question, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        marginStart = ui.dp(48)
      })
      root.addView(bubbleRow, ui.matchWrap())
      if (message.attachmentUrls.isNotEmpty()) {
        photos.gravity = Gravity.END
        message.attachmentUrls.forEach { url ->
          val image = ImageView(context).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            background = ui.rounded(ui.containerHighest, 12f)
            clipToOutline = true
            contentDescription = T.s(R.string.ask_photo_attached)
          }
          photos.addView(image, LinearLayout.LayoutParams(ui.dp(72), ui.dp(72)).apply { marginStart = ui.dp(8) })
          session.loadUpload(url) { bitmap -> if (bitmap != null) image.setImageBitmap(bitmap) }
        }
        root.addView(photos, ui.matchWrap(top = 8))
      }
      status.addView(CircularProgressIndicator(context).apply {
        isIndeterminate = true
        indicatorSize = ui.dp(16)
        trackThickness = ui.dp(2)
        setIndicatorColor(ui.accent)
      })
      status.addView(statusText, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = ui.dp(10) })
      status.minimumHeight = ui.dp(32)
      statusText.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
      root.addView(answer, ui.matchWrap(top = 16))
      root.addView(placeholder, ui.matchWrap(top = 12))
      root.addView(status, ui.matchWrap(top = 8))
      root.addView(notice, ui.matchWrap(top = 12))
      root.addView(meta, ui.matchWrap(top = 12))
      actions.addView(copyButton)
      actions.addView(upButton)
      actions.addView(downButton)
      actions.addView(shareButton)
      root.addView(actions, ui.matchWrap(top = 2).apply { marginStart = -ui.dp(12) })
      root.addView(followups, ui.matchWrap(top = 8))
      listOf(0.92f, 0.84f, 0.6f).forEachIndexed { index, fraction ->
        placeholder.addView(skeletonLine(fraction), ui.matchWrap(top = if (index == 0) 0 else 10))
      }
    }

    fun bind() {
      val state = message.state
      val text = message.answer
      if (text != renderedText || state != renderedState) {
        val streaming = state == AskMessageState.STREAMING || state == AskMessageState.PENDING
        if (text.isNotBlank()) {
          if (text != renderedText) markdown.render(text, answer, streaming)
          answer.visibility = View.VISIBLE
        } else answer.visibility = View.GONE
        renderedText = text
      }
      placeholder.visibility = if (state == AskMessageState.PENDING && text.isBlank()) View.VISIBLE else View.GONE
      status.visibility = if (message.busy) View.VISIBLE else View.GONE
      statusText.text = statusCopy()
      renderNotice()
      if (state != renderedState || state == AskMessageState.DONE) renderMeta()
      val done = state == AskMessageState.DONE && text.isNotBlank()
      actions.visibility = if (done) View.VISIBLE else View.GONE
      val canRate = message.answerId > 0 || session.preview
      upButton.visibility = if (canRate) View.VISIBLE else View.GONE
      downButton.visibility = if (canRate) View.VISIBLE else View.GONE
      tint(upButton, message.feedback == "up", T.s(R.string.ask_helpful))
      tint(downButton, message.feedback == "down", T.s(R.string.ask_not_helpful))
      shareButton.visibility = if (session.conversationID.isNotBlank()) View.VISIBLE else View.GONE
      if (renderedState != null && renderedState != state && state == AskMessageState.DONE) ui.arrive(actions)
      renderedState = state
    }

    private fun tint(button: MaterialButton, selected: Boolean, label: String) {
      button.iconTint = ColorStateList.valueOf(if (selected) ui.accent else ui.onSurfaceVariant)
      button.contentDescription = if (selected) "$label, selected" else label
    }

    private fun statusCopy(): String {
      val base = message.status?.trimEnd('.', '…')?.ifBlank { null }
        ?: if (message.state == AskMessageState.STREAMING) T.s(R.string.ask_status_writing) else T.s(R.string.ask_status_thinking)
      val checks = if (message.checks > 0) " · ${message.checks} ${if (message.checks == 1) "check" else "checks"}" else ""
      return "$base$checks"
    }

    private fun renderNotice() {
      notice.removeAllViews()
      when (message.state) {
        AskMessageState.FAILED, AskMessageState.DROPPED -> {
          val card = ui.vertical().apply {
            background = ui.rounded(ui.errorContainer, 16f)
            setPadding(ui.dp(16), ui.dp(12), ui.dp(8), ui.dp(4))
          }
          card.addView(ui.text(message.error ?: T.s(R.string.ask_err_finish_short), AskUi.Type.BODY_MEDIUM, ui.onErrorContainer),
            ui.matchWrap().apply { marginEnd = ui.dp(8) })
          val retryable = message.state == AskMessageState.DROPPED ||
            (message.error?.contains("used", ignoreCase = true) != true && message === session.messages.lastOrNull())
          if (retryable && !session.preview) {
            card.addView(MaterialButton(context, null, com.google.android.material.R.attr.borderlessButtonStyle).apply {
              text = if (message.state == AskMessageState.DROPPED) T.s(R.string.ask_get_answer) else T.s(R.string.ask_try_again)
              setTextColor(ui.onErrorContainer)
              icon = ui.icon(R.drawable.ask_ic_refresh, ui.onErrorContainer)
              iconTint = ColorStateList.valueOf(ui.onErrorContainer)
              minHeight = ui.dp(48)
              setOnClickListener { NativeSafety.run("Ask retry") { session.retry(message) } }
            }, ui.wrap().apply { gravity = Gravity.END })
          } else card.setPadding(ui.dp(16), ui.dp(12), ui.dp(16), ui.dp(12))
          notice.addView(card, ui.matchWrap())
          notice.visibility = View.VISIBLE
        }
        AskMessageState.STOPPED -> {
          notice.addView(ui.text(if (message.answer.isBlank()) T.s(R.string.ask_stopped_early)
            else T.s(R.string.ask_stopped), AskUi.Type.BODY_SMALL, ui.onSurfaceVariant))
          notice.visibility = View.VISIBLE
        }
        else -> notice.visibility = View.GONE
      }
    }

    private fun renderMeta() {
      meta.removeAllViews()
      if (message.state != AskMessageState.DONE) { meta.visibility = View.GONE; return }
      if (message.vizBlocked) meta.addView(ui.text(T.s(R.string.ask_viz_blocked),
        AskUi.Type.BODY_SMALL, ui.onSurfaceVariant), ui.matchWrap(bottom = 6))
      message.reportUrl?.let { path ->
        meta.addView(ui.outlinedButton(T.s(R.string.ask_open_report)) {
          host.openLink(if (path.startsWith("/")) "$NATIVE_ASK_ORIGIN$path" else path)
        }.apply { icon = ui.icon(R.drawable.ask_ic_arrow_outward, ui.link); iconTint = ColorStateList.valueOf(ui.link) },
          ui.wrap(bottom = 6))
      }
      if (message.liveSources.isNotEmpty()) {
        meta.addView(ui.text(T.s(R.string.ask_live_data, message.liveSources.joinToString(", ")), AskUi.Type.BODY_SMALL, ui.onSurfaceVariant),
          ui.matchWrap(bottom = 4))
      }
      if (message.citations.isNotEmpty()) {
        val toggle = ui.text("", AskUi.Type.LABEL_LARGE, ui.link).apply {
          minHeight = ui.dp(40)
          gravity = Gravity.CENTER_VERTICAL
          isClickable = true
          isFocusable = true
        }
        val list = ui.vertical()
        fun refresh() {
          toggle.text = if (sourcesOpen) T.s(R.string.ask_sources_hide) else T.s(R.string.ask_sources_count, message.citations.size)
          toggle.contentDescription = if (sourcesOpen) T.s(R.string.ask_sources_hide) else T.s(R.string.ask_sources_show, message.citations.size)
          list.visibility = if (sourcesOpen) View.VISIBLE else View.GONE
        }
        message.citations.forEachIndexed { index, citation ->
          val row = ui.text("${index + 1}. ${citation.label}", AskUi.Type.BODY_SMALL,
            if (citation.url != null) ui.link else ui.onSurfaceVariant).apply {
            setPadding(0, ui.dp(6), 0, ui.dp(6))
            if (citation.url != null) {
              isClickable = true
              setOnClickListener { NativeSafety.run("Ask source") { host.openLink(citation.url) } }
            }
          }
          list.addView(row, ui.matchWrap())
        }
        toggle.setOnClickListener { NativeSafety.run("Ask sources") { sourcesOpen = !sourcesOpen; refresh() } }
        refresh()
        meta.addView(toggle, ui.wrap())
        meta.addView(list, ui.matchWrap())
      }
      if (message.model.isNotBlank()) {
        val label = if (message.cached) "${message.model} · saved answer" else message.model
        meta.addView(ui.text(label, AskUi.Type.LABEL_SMALL, ui.onSurfaceVariant).apply { alpha = 0.85f }, ui.matchWrap(top = 2))
      }
      meta.visibility = if (meta.childCount > 0) View.VISIBLE else View.GONE
    }

    fun showFollowups(show: Boolean) {
      val wanted = show && message.state == AskMessageState.DONE && message.followups.isNotEmpty()
      if (!wanted) { followups.visibility = View.GONE; followups.removeAllViews(); return }
      if (followups.childCount > 0) { followups.visibility = View.VISIBLE; return }
      followups.addView(ui.text(T.s(R.string.ask_follow_up), AskUi.Type.LABEL_LARGE, ui.onSurfaceVariant), ui.matchWrap(top = 4, bottom = 8))
      message.followups.forEach { text ->
        followups.addView(suggestion(text, R.drawable.ask_ic_send) {
          stickToBottom = true
          session.sendFollowup(text)
        }.apply { contentDescription = T.s(R.string.ask_follow_up_desc, text) }, ui.matchWrap(bottom = 8))
      }
      followups.visibility = View.VISIBLE
      ui.arrive(followups, 80)
    }
  }

  /** Maps arrive as SVG; a locked-down WebView draws them with no script and no network. */
  private fun mapInto(spec: String, frame: FrameLayout) {
    frame.background = ui.rounded(ui.containerHigh, 16f)
    frame.clipToOutline = true
    val title = NativeSafety.get("Ask map title", "") { org.json.JSONObject(spec).optString("title") }
    frame.contentDescription = if (title.isNotBlank()) T.s(R.string.ask_map_titled, title) else T.s(R.string.ask_map)
    val loading = ui.horizontal().apply {
      gravity = Gravity.CENTER
      addView(CircularProgressIndicator(context).apply {
        isIndeterminate = true; indicatorSize = ui.dp(18); trackThickness = ui.dp(2); setIndicatorColor(ui.accent)
      })
      addView(ui.text(T.s(R.string.ask_drawing_map), AskUi.Type.BODY_MEDIUM, ui.onSurfaceVariant),
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = ui.dp(12) })
    }
    frame.addView(loading, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    frame.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    frame.addOnLayoutChangeListener { view, left, _, right, _, oldLeft, _, oldRight, _ ->
      if (right - left != oldRight - oldLeft && right > left) NativeSafety.run("Ask map size") {
        val height = ((right - left) * 760f / 1200f).toInt()
        if (view.layoutParams.height != height) {
          view.layoutParams = view.layoutParams.apply { this.height = height }
        }
      }
    }
    session.renderMap(spec) { svg, failure ->
      NativeSafety.run("Ask map show") {
        frame.removeAllViews()
        if (svg == null) {
          frame.addView(ui.text(failure ?: T.s(R.string.ask_err_map), AskUi.Type.BODY_MEDIUM, ui.onSurfaceVariant).apply {
            gravity = Gravity.CENTER
          }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
          return@run
        }
        val web = WebView(context)
        web.settings.javaScriptEnabled = false
        web.settings.blockNetworkLoads = true
        web.settings.allowFileAccess = false
        web.settings.allowContentAccess = false
        web.setBackgroundColor(0)
        web.isVerticalScrollBarEnabled = false
        web.isHorizontalScrollBarEnabled = false
        web.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        // Taps fall through to the thread so the map never traps a scroll.
        web.setOnTouchListener { _, _ -> false }
        web.isClickable = false
        web.isLongClickable = false
        web.setOnLongClickListener { true }
        val encoded = android.util.Base64.encodeToString(svg.toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP)
        val html = "<html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>" +
          "<body style=\"margin:0;background:transparent\"><img alt=\"\" style=\"display:block;width:100%;height:auto\" " +
          "src=\"data:image/svg+xml;base64,$encoded\"></body></html>"
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
        frame.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        ui.arrive(web)
      }
    }
  }

  // ---- History list --------------------------------------------------------

  private sealed class HistoryRow {
    data class Header(val label: String) : HistoryRow()
    data class Chat(val item: AskConversationSummary) : HistoryRow()
  }

  private inner class HistoryAdapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    var rows: List<HistoryRow> = emptyList()

    fun submit(list: List<AskConversationSummary>) {
      val out = mutableListOf<HistoryRow>()
      var lastLabel = ""
      list.forEach { item ->
        val label = if (item.pinned) T.s(R.string.ask_bucket_pinned) else bucket(item.updated)
        if (label != lastLabel) { out += HistoryRow.Header(label); lastLabel = label }
        out += HistoryRow.Chat(item)
      }
      rows = out
      @Suppress("NotifyDataSetChanged")
      notifyDataSetChanged()
    }

    override fun getItemCount() = rows.size
    override fun getItemViewType(position: Int) = if (rows[position] is HistoryRow.Header) 0 else 1

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      if (viewType == 0) {
        val label = ui.text("", AskUi.Type.LABEL_LARGE, ui.onSurfaceVariant).apply {
          setPadding(ui.dp(20), ui.dp(16), ui.dp(20), ui.dp(8))
          layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
          ViewCompat.setAccessibilityHeading(this, true)
        }
        return object : RecyclerView.ViewHolder(label) {}
      }
      return ChatHolder()
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
      when (val row = rows[position]) {
        is HistoryRow.Header -> (holder.itemView as TextView).text = row.label
        is HistoryRow.Chat -> (holder as ChatHolder).bind(row.item)
      }
    }
  }

  private inner class ChatHolder : RecyclerView.ViewHolder(ui.horizontal()) {
    private val row = itemView as LinearLayout
    private val icon = ImageView(context)
    private val title = ui.text("", AskUi.Type.BODY_LARGE, ui.onSurface)
    private val date = ui.text("", AskUi.Type.BODY_MEDIUM, ui.onSurfaceVariant)
    var item: AskConversationSummary? = null

    init {
      row.layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        marginStart = ui.dp(8); marginEnd = ui.dp(8)
      }
      row.minimumHeight = ui.dp(72)
      row.setPadding(ui.dp(12), ui.dp(8), ui.dp(16), ui.dp(8))
      row.isClickable = true
      row.isFocusable = true
      val iconBox = FrameLayout(context).apply { background = ui.circle(ui.containerHighest) }
      icon.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      iconBox.addView(icon, FrameLayout.LayoutParams(ui.dp(20), ui.dp(20), Gravity.CENTER))
      row.addView(iconBox, LinearLayout.LayoutParams(ui.dp(40), ui.dp(40)))
      val texts = ui.vertical()
      title.maxLines = 1
      title.ellipsize = android.text.TextUtils.TruncateAt.END
      texts.addView(title, ui.matchWrap())
      texts.addView(date, ui.matchWrap(top = 2))
      row.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = ui.dp(16) })
      row.setOnClickListener { NativeSafety.run("Ask open chat") { item?.let { session.openConversation(it.id) } } }
      row.setOnLongClickListener {
        NativeSafety.run("Ask chat menu") {
          val current = item ?: return@run
          val popup = androidx.appcompat.widget.PopupMenu(context, row, Gravity.END)
          popup.menu.add(0, 1, 0, T.s(R.string.ask_open))
          popup.menu.add(0, 2, 1, T.s(R.string.ask_delete))
          popup.setOnMenuItemClickListener { choice ->
            NativeSafety.run("Ask chat menu choice") {
              if (choice.itemId == 1) session.openConversation(current.id) else delete(current)
            }
            true
          }
          popup.show()
        }
        true
      }
      ViewCompat.addAccessibilityAction(row, T.s(R.string.ask_delete_chat)) { _, _ ->
        NativeSafety.run("Ask delete action") { item?.let(::delete) }
        true
      }
    }

    fun bind(value: AskConversationSummary) {
      item = value
      title.text = value.title
      date.text = stamp(value.updated)
      val active = value.id == session.conversationID
      icon.setImageDrawable(ui.icon(if (value.pinned) R.drawable.ask_ic_pin else R.drawable.ask_ic_chat,
        if (active) ui.onSecondaryContainer else ui.onSurfaceVariant))
      row.background = android.graphics.drawable.RippleDrawable(ColorStateList.valueOf(ui.withAlpha(ui.onSurface, 0.12f)),
        ui.rounded(if (active) ui.secondaryContainer else 0, 28f), ui.rounded(ui.onSurface, 28f))
      row.contentDescription = "${value.title}, ${stamp(value.updated)}${if (active) ", open now" else ""}"
    }
  }

  private fun delete(item: AskConversationSummary) {
    session.deleteLater(item)
    snack(T.s(R.string.ask_chat_deleted), T.s(R.string.ask_undo), { session.undoDelete(item.id) }) { undone ->
      if (!undone) session.commitDelete(item.id)
    }
  }

  private inner class SwipeToDelete : ItemTouchHelper.SimpleCallback(0, ItemTouchHelper.LEFT or ItemTouchHelper.RIGHT) {
    private val background = android.graphics.Paint().apply { color = ui.errorContainer }
    private val deleteIcon = ui.icon(R.drawable.ask_ic_delete, ui.onErrorContainer)

    override fun getSwipeDirs(recyclerView: RecyclerView, holder: RecyclerView.ViewHolder): Int =
      if (holder is ChatHolder) super.getSwipeDirs(recyclerView, holder) else 0

    override fun onMove(recyclerView: RecyclerView, viewHolder: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder) = false

    override fun onSwiped(viewHolder: RecyclerView.ViewHolder, direction: Int) {
      NativeSafety.run("Ask swipe delete") {
        val item = (viewHolder as? ChatHolder)?.item ?: return@run
        delete(item)
      }
    }

    override fun onChildDraw(canvas: Canvas, recyclerView: RecyclerView, viewHolder: RecyclerView.ViewHolder,
                             dX: Float, dY: Float, actionState: Int, isCurrentlyActive: Boolean) {
      NativeSafety.run("Ask swipe draw") {
        val view = viewHolder.itemView
        val rect = android.graphics.RectF(view.left.toFloat(), view.top.toFloat(), view.right.toFloat(), view.bottom.toFloat())
        canvas.drawRoundRect(rect, ui.dpf(28f), ui.dpf(28f), background)
        deleteIcon?.let { icon ->
          val size = ui.dp(24)
          val top = view.top + (view.height - size) / 2
          val left = if (dX > 0) view.left + ui.dp(24) else view.right - ui.dp(24) - size
          icon.setBounds(left, top, left + size, top + size)
          icon.draw(canvas)
        }
      }
      super.onChildDraw(canvas, recyclerView, viewHolder, dX, dY, actionState, isCurrentlyActive)
    }
  }

  private fun bucket(time: Long): String {
    if (time <= 0) return T.s(R.string.ask_bucket_earlier)
    val now = Calendar.getInstance()
    val then = Calendar.getInstance().apply { timeInMillis = time }
    val days = ((startOfDay(now) - startOfDay(then)) / DateUtils.DAY_IN_MILLIS).toInt()
    return when {
      days <= 0 -> T.s(R.string.ask_bucket_today)
      days == 1 -> T.s(R.string.ask_bucket_yesterday)
      days < 7 -> T.s(R.string.ask_bucket_week)
      days < 31 -> T.s(R.string.ask_bucket_month)
      else -> T.s(R.string.ask_bucket_earlier)
    }
  }

  private fun startOfDay(calendar: Calendar): Long = (calendar.clone() as Calendar).apply {
    set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
  }.timeInMillis

  private fun stamp(time: Long): String {
    if (time <= 0) return ""
    return if (DateUtils.isToday(time)) DateUtils.formatDateTime(context, time, DateUtils.FORMAT_SHOW_TIME)
    else DateUtils.formatDateTime(context, time, DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_ABBREV_MONTH or
      DateUtils.FORMAT_SHOW_WEEKDAY or DateUtils.FORMAT_ABBREV_WEEKDAY)
  }

  // ---- Connectivity --------------------------------------------------------

  private fun registerNetwork() {
    if (Build.VERSION.SDK_INT < 24 || networkCallback != null) return
    NativeSafety.run("Ask network watch") {
      val manager = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { root.post { NativeSafety.run("Ask online") { onChrome() } } }
        override fun onLost(network: Network) { root.post { NativeSafety.run("Ask offline") { onChrome() } } }
      }
      manager.registerDefaultNetworkCallback(callback)
      networkCallback = callback
    }
  }

  private fun unregisterNetwork() {
    val callback = networkCallback ?: return
    networkCallback = null
    NativeSafety.run("Ask network unwatch") {
      (activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(callback)
    }
  }

  private companion object {
    const val MENU_NEW = 1
    const val MENU_HISTORY = 2
    const val MENU_SHARE = 3
    const val MENU_REFRESH = 4
    const val MENU_PROVIDERS = 5
  }
}
