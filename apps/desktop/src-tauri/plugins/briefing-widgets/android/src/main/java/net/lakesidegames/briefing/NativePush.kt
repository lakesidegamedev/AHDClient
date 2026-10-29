package net.lakesidegames.briefing

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.Executors

object NativePush {
  private const val ORIGIN = "https://ahousedividedgame.com"
  private const val CHANNEL = "ahd-inbox"
  /** Used when a push names no alert id (servers before AHDGame #3764). */
  private const val NOTIFICATION_ID = 21002
  /** One channel per inbox category, so a player can silence one kind in Android Settings. */
  private val CATEGORY_CHANNELS = linkedMapOf(
    "crisis" to "Crisis", "election" to "Elections", "legislation" to "Legislation",
    "party" to "Party", "treasury" to "Treasury", "standing" to "Standing", "system" to "System",
  )
  private const val FALLBACK_BODY = "You have new activity. Open your inbox to catch up."
  private val lock = Any()
  private val worker = Executors.newSingleThreadExecutor()
  private var busy = false
  private var tokenPending = false
  private var nextAttempt = 0L
  private var statusMessage = "Turn on alerts for new inbox activity."

  private fun file(context: Context) = File(context.noBackupFilesDir, "native-push.json")
  private fun read(context: Context): JSONObject = NativeSafety.get("push state read", JSONObject()) {
    JSONObject(file(context).readText())
  }
  private fun save(context: Context, state: JSONObject) {
    val destination = file(context)
    val temporary = File(destination.parentFile, "native-push.tmp")
    temporary.writeText(state.toString())
    if (!temporary.renameTo(destination)) throw IllegalStateException("Could not save push preferences")
  }
  private fun digest(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
  private fun session(): String = (CookieManager.getInstance().getCookie("$ORIGIN/api/push/device") ?: "")
    .split(';').map { it.trim() }.filter {
      val name = it.substringBefore('=')
      name == "auth-token" || Regex("auth-token-[A-Za-z0-9-]+").matches(name) ||
        Regex("(__Secure-)?(authjs|next-auth)\\.session-token(\\.[0-9]+)?").matches(name)
    }.sorted().joinToString("; ")
  fun permitted(context: Context) = NativeSafety.get("notification permission read", false) {
    NotificationManagerCompat.from(context).areNotificationsEnabled()
  }
  private fun available(context: Context) = NativeSafety.get("Firebase availability check", false) {
    FirebaseApp.initializeApp(context) != null
  }

  fun status(context: Context): JSONObject = synchronized(lock) {
    val state = read(context)
    val header = session()
    JSONObject().put("enabled", state.optBoolean("enabled")).put("permissionGranted", permitted(context))
      .put("available", available(context)).put("registered", header.isNotEmpty() && permitted(context) &&
        state.optBoolean("enabled") && state.optString("registeredSession") == digest(header))
      .put("message", statusMessage)
  }
  fun setEnabled(context: Context, enabled: Boolean) = synchronized(lock) {
    val state = read(context)
    state.put("enabled", enabled)
    if (!state.has("installation")) {
      val bytes = ByteArray(32); SecureRandom().nextBytes(bytes)
      state.put("installation", bytes.joinToString("") { "%02x".format(it) })
    }
    if (!enabled) {
      state.remove("registeredSession")
      NotificationManagerCompat.from(context).cancelAll()
    }
    save(context, state)
    if (!enabled && FirebaseApp.getApps(context).isNotEmpty()) {
      FirebaseMessaging.getInstance().isAutoInitEnabled = false
    }
    nextAttempt = 0
  }
  fun tokenChanged(context: Context, token: String) {
    NativeSafety.run("push token update") {
      synchronized(lock) {
        val state = read(context); state.put("token", token); state.remove("registeredSession")
        save(context, state); nextAttempt = 0
      }
      sync(context, true)
    }
  }
  fun sync(context: Context, force: Boolean = false) {
    val app = context.applicationContext
    synchronized(lock) {
      val state = read(app)
      val header = session()
      val fingerprint = if (header.isEmpty()) "" else digest(header)
      if (state.optString("observedSession", state.optString("registeredSession")) != fingerprint) {
        state.put("observedSession", fingerprint); nextAttempt = 0
        state.remove("registeredSession"); state.put("needsRevoke", state.optBoolean("mayBeRegistered")); save(app, state)
        NotificationManagerCompat.from(app).cancelAll()
      }
      val enabled = state.optBoolean("enabled") && permitted(app)
      if (!enabled || header.isEmpty()) {
        statusMessage = if (!state.optBoolean("enabled")) "Push alerts are off." else if (!permitted(app))
          "Allow notifications in Android Settings, then return here." else "Sign in to multiplayer to receive alerts."
        NotificationManagerCompat.from(app).cancelAll()
      } else if (!available(app)) { statusMessage = "Push is unavailable in this build."; return }
      if (enabled && header.isNotEmpty() && state.optString("token").isEmpty() && !tokenPending) {
        tokenPending = true
        FirebaseMessaging.getInstance().isAutoInitEnabled = true
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
          NativeSafety.run("FCM token completion") {
            synchronized(lock) { tokenPending = false }
            if (task.isSuccessful) tokenChanged(app, task.result)
            else synchronized(lock) { statusMessage = "Could not contact Google Play services. Try again when online." }
          }
        }
        return
      }
      if (busy || (!force && System.currentTimeMillis() < nextAttempt)) return
      val register = enabled && header.isNotEmpty() && state.optString("token").isNotEmpty() && !state.optBoolean("needsRevoke")
      if (!state.has("installation") || (!register && !state.optBoolean("mayBeRegistered"))) return
      val body = JSONObject().put("installation", state.getString("installation"))
      if (register) body.put("provider", "fcm").put("token", state.getString("token")).put("environment", "production")
      // Persist revocation intent before networking, including registration whose response may be lost.
      if (register) state.put("mayBeRegistered", true)
      save(app, state)
      busy = true
      nextAttempt = System.currentTimeMillis() + 60_000
      if (register) statusMessage = "Connecting push alerts..."
      val permittedAtSend = permitted(app)
      val submitted = NativeSafety.run("push sync scheduling") {
        worker.execute {
          NativeSafety.run("push sync task") {
            try {
              val code = send(if (register) "POST" else "DELETE", body, if (register) header else "")
              synchronized(lock) {
                val latest = read(app)
                val stillCurrent = session() == header && latest.optBoolean("enabled") == state.optBoolean("enabled") &&
                  latest.optString("token") == state.optString("token") && permitted(app) == permittedAtSend
                if (!stillCurrent) {
                  nextAttempt = 0
                } else if (code == 200) {
                  if (register) {
                    latest.put("registeredSession", fingerprint)
                    nextAttempt = System.currentTimeMillis() + 12 * 60 * 60_000
                    statusMessage = "Push alerts are on. Tap one to open what it is about."
                  } else {
                    latest.remove("registeredSession"); latest.put("mayBeRegistered", false); latest.put("needsRevoke", false)
                    nextAttempt = 0
                  }
                  save(app, latest)
                } else if (register) {
                  latest.remove("registeredSession"); save(app, latest)
                  statusMessage = when (code) {
                    401, 403 -> "Sign in to multiplayer to receive alerts."
                    503 -> "Push delivery is not available yet. We will retry automatically."
                    else -> "Could not connect. We will retry when online."
                  }
                }
              }
            } finally {
              synchronized(lock) { busy = false }
            }
          }
        }
      }
      if (!submitted) {
        busy = false
        nextAttempt = 0
        statusMessage = "Push is unavailable right now."
      }
    }
  }
  /**
   * Ask the game to send this phone one test alert now. Blocking: call it off
   * the main thread. Returns the server's verdict ("sent", "not_registered",
   * "retry", "invalid") or a local one ("signed_out", "rate_limited", "error").
   */
  fun sendTest(context: Context): String = NativeSafety.get("push test", "error") {
    val state = synchronized(lock) { read(context.applicationContext) }
    val header = session()
    if (header.isEmpty()) return@get "signed_out"
    if (!state.has("installation")) return@get "not_registered"
    val connection = URL("$ORIGIN/api/push/test").openConnection() as HttpURLConnection
    try {
      connection.requestMethod = "POST"; connection.instanceFollowRedirects = false
      connection.connectTimeout = 8000; connection.readTimeout = 12000; connection.doOutput = true
      connection.setRequestProperty("Content-Type", "application/json")
      connection.setRequestProperty("Cookie", header)
      connection.outputStream.use {
        it.write(JSONObject().put("installation", state.getString("installation")).toString().toByteArray())
      }
      when (val code = connection.responseCode) {
        200 -> JSONObject(connection.inputStream.bufferedReader().use { it.readText() }).optString("result", "error")
        401, 403 -> "signed_out"
        429 -> "rate_limited"
        else -> if (code >= 500) "retry" else "error"
      }
    } finally { connection.disconnect() }
  }

  private fun send(method: String, body: JSONObject, header: String): Int = NativeSafety.get("push request", 0) {
    val connection = URL("$ORIGIN/api/push/device").openConnection() as HttpURLConnection
    try {
      connection.requestMethod = method; connection.instanceFollowRedirects = false
      connection.connectTimeout = 6000; connection.readTimeout = 6000; connection.doOutput = true
      connection.setRequestProperty("Content-Type", "application/json")
      if (header.isNotEmpty()) connection.setRequestProperty("Cookie", header)
      connection.outputStream.use { it.write(body.toString().toByteArray()) }
      connection.responseCode
    } finally { connection.disconnect() }
  }

  private fun text(value: String?, limit: Int): String? =
    value?.filterNot { it.isISOControl() }?.trim()?.take(limit)?.takeIf { it.isNotEmpty() }

  /** A bounded path on the game site, or null for anything that could leave it. */
  fun gamePath(value: String?): String? = value?.takeIf { path ->
    path.length <= 300 && path.startsWith("/") && !path.startsWith("//") &&
      path.none { it == '\\' || it.isWhitespace() || it.isISOControl() }
  }

  fun show(context: Context, message: RemoteMessage) {
    NativeSafety.run("push notification") {
      synchronized(lock) {
        val state = read(context)
        val header = session()
        if (!state.optBoolean("enabled") || !permitted(context) || header.isEmpty() ||
          state.optString("registeredSession") != digest(header) || message.data["path"] != "/notifications") return@run
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val data = message.data
        // Servers before category threads send none; those alerts keep the original channel.
        val thread = data["thread"]?.takeIf { it in CATEGORY_CHANNELS }
        val channel = thread?.let { "ahd-$it" } ?: CHANNEL
        if (Build.VERSION.SDK_INT >= 26) {
          val name = thread?.let { CATEGORY_CHANNELS[it] } ?: "Inbox activity"
          val importance = if (thread == "crisis") NotificationManager.IMPORTANCE_HIGH else NotificationManager.IMPORTANCE_DEFAULT
          manager.createNotificationChannel(NotificationChannel(channel, name, importance).apply {
            description = if (thread == null) "New activity in your A House Divided inbox." else "$name alerts from your A House Divided inbox."
          })
        }
        val title = text(data["title"], 120) ?: "A House Divided"
        val body = text(data["body"], 400) ?: FALLBACK_BODY
        val subtitle = text(data["subtitle"], 120)
        // Each alert gets its own entry; a retried delivery of the same alert replaces itself.
        val id = data["id"]?.takeIf { Regex("[0-9a-f]{24}").matches(it) }?.hashCode() ?: NOTIFICATION_ID
        val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return@run
        intent.data = Uri.parse("ahdclient://page" + (gamePath(data["href"]) ?: "/notifications"))
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending = PendingIntent.getActivity(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val icon = context.resources.getIdentifier("ic_stat_ahd", "drawable", context.packageName)
        // A locked phone set to hide sensitive content shows only this.
        val hidden = NotificationCompat.Builder(context, channel).setSmallIcon(icon).setContentTitle("A House Divided")
          .setContentText(subtitle?.substringBefore(" \u00b7 ")?.let { "New $it alert" } ?: "New inbox activity").build()
        val notification = NotificationCompat.Builder(context, channel).setSmallIcon(icon)
          .setContentTitle(title).setContentText(body).setSubText(subtitle)
          .setStyle(NotificationCompat.BigTextStyle().bigText(body))
          .setGroup("ahd-${thread ?: "inbox"}")
          .setContentIntent(pending).setAutoCancel(true).setOnlyAlertOnce(true).setShowWhen(true)
          .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(hidden).build()
        try { manager.notify(id, notification) } catch (_: SecurityException) { }
      }
    }
  }
}
class PushService : FirebaseMessagingService() {
  override fun onNewToken(token: String) {
    NativeSafety.run("FCM token callback") { NativePush.tokenChanged(this, token) }
  }
  override fun onMessageReceived(message: RemoteMessage) {
    NativeSafety.run("FCM message callback") { NativePush.show(this, message) }
  }
}
