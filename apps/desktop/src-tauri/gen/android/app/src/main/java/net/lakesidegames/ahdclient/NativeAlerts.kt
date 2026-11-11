package net.lakesidegames.ahdclient

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView
import androidx.core.app.NotificationManagerCompat
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import net.lakesidegames.briefing.NativePush

/**
 * Alerts the player actually turns on: the one-time sheet, the Alerts row in More and the
 * system permission flow. Delivery itself stays in NativePush; this only decides when to ask
 * and drives the switch. Every entry point runs under CompanionSafety at its caller.
 */
object NativeAlerts {
  private const val PREFS = "ahd-alerts"
  private const val ASKED = "asked"
  private const val DENIALS = "denials"
  private val BACKGROUND = Color.parseColor("#14141C")
  private val ACCENT = Color.parseColor("#DC2626")

  private var showing: BottomSheetDialog? = null
  private val NOTHING: () -> Unit = {}

  /** The player switched the reminder on before alerts were allowed; finish it when they are. */
  private var pendingReminder = false
  private var lastSignedIn = false
  private var lastStatus: DockStatus? = null

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun asked(context: Context) = prefs(context).getBoolean(ASKED, false)

  fun permission(context: Context): AlertsPolicy.Permission = AlertsPolicy.permission(
    Build.VERSION.SDK_INT, NotificationManagerCompat.from(context).areNotificationsEnabled(), prefs(context).getInt(DENIALS, 0))

  /** After a signed-in status load. Does nothing unless every rule passes; the question is shown once, ever. */
  fun askOnce(activity: MainActivity, signedIn: Boolean, statusLoaded: Boolean, onGamePage: Boolean) {
    if (showing != null || activity.isFinishing || asked(activity)) return
    val allowed = AlertsPolicy.shouldAsk(false, signedIn, statusLoaded, onGamePage,
      NativePush.isEnabled(activity), permission(activity))
    if (!allowed) return
    prefs(activity).edit().putBoolean(ASKED, true).apply()
    present(activity, AlertsPolicy.Mode.ASK)
  }

  /** The Alerts row in More. */
  fun showManager(activity: MainActivity) {
    present(activity, AlertsPolicy.mode(NativePush.isEnabled(activity), permission(activity)))
  }

  /**
   * Schedules, moves or cancels the one pending "Turn N is in" reminder from the dock's next-turn
   * time. Cheap and safe to repeat; call after every status load and every sign-in change.
   */
  fun syncReminder(context: Context, signedIn: Boolean, status: DockStatus?) {
    lastSignedIn = signedIn
    lastStatus = status
    val at = AlertsPolicy.reminderAt(status?.nextTurnAt, System.currentTimeMillis(), TurnReminder.isOn(context),
      permission(context), signedIn, status?.turnActive ?: false)
    if (at == null) { TurnReminder.cancel(context); return }
    val title = Texts.s(AlertsPolicy.reminderTitle(AlertsPolicy.reminderTurn(status?.turnNumber)), AlertsPolicy.reminderTurn(status?.turnNumber) ?: 0)
    TurnReminder.schedule(context, at, title)
  }

  private fun setReminder(context: Context, on: Boolean) {
    TurnReminder.setOn(context, on)
    syncReminder(context, lastSignedIn, lastStatus)
  }

  /** [preview] draws the sheet only, for screenshots: its buttons change nothing. */
  fun present(activity: Activity, mode: AlertsPolicy.Mode, preview: Boolean = false) {
    if (showing != null || activity.isFinishing) return
    val dialog = BottomSheetDialog(activity)
    var chosen = false
    dialog.setContentView(content(activity, mode, preview) { primary ->
      chosen = primary !== NOTHING
      dialog.dismiss()
      if (!preview) primary()
    })
    dialog.behavior.apply { state = BottomSheetBehavior.STATE_EXPANDED; skipCollapsed = true }
    dialog.setOnDismissListener {
      showing = null
      // A pre-prompt closed without turning alerts on drops the reminder the player asked for.
      if (!chosen) pendingReminder = false
    }
    showing = dialog
    dialog.show()
  }

  private fun content(activity: Activity, mode: AlertsPolicy.Mode, preview: Boolean, done: (() -> Unit) -> Unit): View {
    Texts.syncFromCookie()
    val copy = AlertsPolicy.copy(mode)
    val density = activity.resources.displayMetrics.density
    fun dp(value: Int) = (value * density).toInt()
    val column = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      setBackgroundColor(BACKGROUND)
      setPadding(dp(24), dp(28), dp(24), dp(24))
    }
    column.addView(TextView(activity).apply {
      text = Texts.s(copy.title); setTextColor(Color.WHITE); textSize = 22f; setTypeface(typeface, Typeface.BOLD)
      gravity = Gravity.CENTER
      androidx.core.view.ViewCompat.setAccessibilityHeading(this, true)
    })
    column.addView(TextView(activity).apply {
      text = Texts.s(copy.body); setTextColor(Color.argb(179, 255, 255, 255)); textSize = 16f; gravity = Gravity.CENTER
    }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(14) })
    if (mode == AlertsPolicy.Mode.ON || mode == AlertsPolicy.Mode.OFF) column.addView(reminderRow(activity, preview, done),
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(18) })
    column.addView(TextView(activity).apply {
      text = Texts.s(copy.primary); setTextColor(Color.WHITE); textSize = 16f; setTypeface(typeface, Typeface.BOLD)
      gravity = Gravity.CENTER; minHeight = dp(48)
      background = GradientDrawable().apply {
        cornerRadius = dp(12).toFloat()
        setColor(if (mode == AlertsPolicy.Mode.ON) Color.argb(36, 255, 255, 255) else ACCENT)
      }
      contentDescription = Texts.s(copy.primary)
      setOnClickListener { done { primaryTapped(activity, mode) } }
    }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(22) })
    column.addView(TextView(activity).apply {
      text = Texts.s(copy.secondary); setTextColor(Color.argb(204, 255, 255, 255)); textSize = 16f
      gravity = Gravity.CENTER; minHeight = dp(48)
      setOnClickListener { done(NOTHING) }
    }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })
    return column
  }

  /** "Remind me when a new turn starts", off until the player says so. */
  private fun reminderRow(activity: Activity, preview: Boolean, done: (() -> Unit) -> Unit): View {
    val density = activity.resources.displayMetrics.density
    val row = LinearLayout(activity).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      minimumHeight = (48 * density).toInt()
    }
    val label = Texts.s(R.string.alerts_turn_reminder)
    row.addView(TextView(activity).apply {
      text = label; setTextColor(Color.WHITE); textSize = 16f
    }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    val toggle = Switch(activity).apply {
      contentDescription = label
      isChecked = preview || (TurnReminder.isOn(activity) && permission(activity) == AlertsPolicy.Permission.GRANTED)
    }
    toggle.setOnCheckedChangeListener { _, on ->
      if (preview) return@setOnCheckedChangeListener
      when {
        !on -> setReminder(activity, false)
        permission(activity) == AlertsPolicy.Permission.GRANTED -> setReminder(activity, true)
        // Alerts are not allowed yet: the same pre-prompt as the one-time question, then the system's.
        else -> done { askForReminder(activity) }
      }
    }
    row.addView(toggle)
    return row
  }

  /** Switching the reminder on without alerts allowed: the pre-prompt, and on a yes the reminder follows. */
  private fun askForReminder(activity: Activity) {
    if (permission(activity) == AlertsPolicy.Permission.BLOCKED) { openSettings(activity); return }
    pendingReminder = true
    present(activity, AlertsPolicy.Mode.ASK)
  }

  private fun primaryTapped(activity: Activity, mode: AlertsPolicy.Mode) {
    when (mode) {
      AlertsPolicy.Mode.ASK, AlertsPolicy.Mode.OFF -> turnOn(activity)
      AlertsPolicy.Mode.ON -> NativePush.setEnabled(activity, false)
      AlertsPolicy.Mode.BLOCKED -> openSettings(activity)
    }
  }

  /** On, with the system prompt the first time; a player who refused twice goes to system settings instead. */
  private fun turnOn(activity: Activity) {
    NativePush.setEnabled(activity, true)
    when (permission(activity)) {
      AlertsPolicy.Permission.GRANTED -> { NativePush.sync(activity, true); finishPendingReminder(activity) }
      AlertsPolicy.Permission.BLOCKED -> { pendingReminder = false; openSettings(activity) }
      AlertsPolicy.Permission.ASKABLE -> (activity as? MainActivity)?.requestNotificationPermission { granted ->
        if (granted) { NativePush.sync(activity, true); finishPendingReminder(activity) }
        else prefs(activity).edit().putInt(DENIALS, AlertsPolicy.denialsAfterRefusal(
          prefs(activity).getInt(DENIALS, 0), activity.shouldShowRequestPermissionRationale(android.Manifest.permission.POST_NOTIFICATIONS))).apply()
      }
    }
  }

  private fun finishPendingReminder(context: Context) {
    if (!pendingReminder) return
    pendingReminder = false
    setReminder(context, true)
  }

  private fun openSettings(activity: Activity) {
    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
      .putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
    try {
      activity.startActivity(intent)
    } catch (_: android.content.ActivityNotFoundException) {
      activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}")))
    }
  }
}
