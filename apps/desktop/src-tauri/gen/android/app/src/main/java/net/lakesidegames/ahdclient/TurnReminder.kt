package net.lakesidegames.ahdclient

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import net.lakesidegames.briefing.NativePush

/**
 * The opt-in "a new turn is in" reminder: one inexact alarm, set from the next-turn time the dock
 * already holds, that raises one notification on the `ahd-turn` channel. Needs no exact-alarm
 * permission; Android may deliver it a little late. Nothing here talks to the server.
 */
object TurnReminder {
  const val CHANNEL = "ahd-turn"
  private const val GROUP = "ahd-alerts"
  private const val ACTION = "net.lakesidegames.ahdclient.TURN_REMINDER"
  private const val EXTRA_TITLE = "title"
  private const val REQUEST = 21003
  private const val NOTIFICATION_ID = 21003
  private const val PREFS = "ahd-alerts"
  private const val ON = "turnReminder"
  private const val SET_AT = "turnReminderAt"
  private const val SET_TITLE = "turnReminderTitle"

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** Off until the player turns it on. */
  fun isOn(context: Context) = prefs(context).getBoolean(ON, false)

  fun setOn(context: Context, on: Boolean) {
    prefs(context).edit().putBoolean(ON, on).apply()
  }

  private fun intent(context: Context, title: String?): PendingIntent {
    val send = Intent(context, TurnReminderReceiver::class.java).setAction(ACTION).setPackage(context.packageName)
    if (title != null) send.putExtra(EXTRA_TITLE, title)
    return PendingIntent.getBroadcast(context, REQUEST, send, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  /**
   * Sets, moves or cancels the one pending alarm so it matches [at] and [title]. Does nothing when
   * the alarm is already as asked. A null [at] cancels it and takes a delivered reminder off the shade.
   */
  fun schedule(context: Context, at: Long?, title: String) {
    val alarms = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    val saved = prefs(context)
    if (at == null) { cancel(context); return }
    if (saved.getLong(SET_AT, 0L) == at && saved.getString(SET_TITLE, null) == title) return
    createChannel(context)
    // set(), not setExact: no special permission, and a few minutes of drift is fine for this.
    alarms.set(AlarmManager.RTC_WAKEUP, at, intent(context, title))
    saved.edit().putLong(SET_AT, at).putString(SET_TITLE, title).apply()
  }

  fun cancel(context: Context) {
    (context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager)?.cancel(intent(context, null))
    prefs(context).edit().remove(SET_AT).remove(SET_TITLE).apply()
    NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
  }

  /** The `ahd-turn` channel in the Inbox alerts group, so Android Settings lists it with the others. */
  fun createChannel(context: Context) {
    // The group and the other channels come from NativePush; this adds only the turn channel.
    NativePush.createChannels(context)
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    Texts.init(context); Texts.syncFromCookie()
    manager.createNotificationChannel(NotificationChannel(CHANNEL, Texts.s(R.string.turn_reminder_channel), NotificationManager.IMPORTANCE_DEFAULT).apply {
      description = Texts.s(R.string.turn_reminder_channel_desc)
      group = GROUP
    })
  }

  /** Raises the notification, unless alerts were switched off or taken away since it was set. */
  internal fun deliver(context: Context, title: String?) {
    val saved = prefs(context)
    saved.edit().remove(SET_AT).remove(SET_TITLE).apply()
    if (!isOn(context) || !NotificationManagerCompat.from(context).areNotificationsEnabled()) return
    Texts.init(context); Texts.syncFromCookie()
    val open = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    val tap = PendingIntent.getActivity(context, REQUEST, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val shown = title?.takeIf { it.isNotBlank() } ?: Texts.s(R.string.turn_reminder_title_unknown)
    val notification = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(context.resources.getIdentifier("ic_stat_ahd", "drawable", context.packageName))
      .setContentTitle(shown)
      .setContentText(Texts.s(R.string.turn_reminder_body))
      .setContentIntent(tap).setAutoCancel(true)
      .setCategory(NotificationCompat.CATEGORY_REMINDER)
      .build()
    createChannel(context)
    NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
  }
}

class TurnReminderReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    CompanionSafety.run("turn reminder") { TurnReminder.deliver(context, intent.getStringExtra("title")) }
  }
}
