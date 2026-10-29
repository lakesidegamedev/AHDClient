package net.lakesidegames.ahdclient

import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.CookieManager
import android.widget.RemoteViews
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.text.DecimalFormat
import java.util.concurrent.Executors
import java.util.concurrent.Future

/** Native home-screen stats. No WebView, renderer IPC or stored session copy. */
open class BriefingWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    CompanionSafety.run("widget receiver render") { BriefingWidgets.render(context) }
    CompanionSafety.run("widget receiver schedule") { BriefingWidgets.schedule(context) }
  }

  override fun onReceive(context: Context, intent: Intent) {
    CompanionSafety.run("widget receiver base dispatch") { super.onReceive(context, intent) }
    CompanionSafety.run("widget receiver action") {
      when (intent.action) {
        BriefingWidgets.NEXT, BriefingWidgets.PREVIOUS -> {
          val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1)
          if (BriefingWidgets.ids(context).contains(id)) {
            val current = BriefingWidgets.section(context, id)
            val delta = if (intent.action == BriefingWidgets.NEXT) 1 else BriefingWidgets.sections.size - 1
            context.getSharedPreferences("briefing-widget-prefs", Context.MODE_PRIVATE).edit()
              .putInt("section-$id", (current + delta) % BriefingWidgets.sections.size).apply()
            BriefingWidgets.render(context)
          }
        }
        BriefingWidgets.REFRESH -> BriefingWidgets.schedule(context)
      }
    }
  }

  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: android.os.Bundle) {
    // Resizing changes which figures fit.
    CompanionSafety.run("widget resize render") { BriefingWidgets.render(context) }
  }

  override fun onDeleted(context: Context, ids: IntArray) {
    CompanionSafety.run("widget receiver delete") {
      val prefs = context.getSharedPreferences("briefing-widget-prefs", Context.MODE_PRIVATE).edit()
      ids.forEach { prefs.remove("section-$it") }
      prefs.apply()
    }
  }

  override fun onDisabled(context: Context) {
    CompanionSafety.run("widget receiver disable") {
      if (BriefingWidgets.ids(context).isEmpty()) {
        context.getSystemService(JobScheduler::class.java).cancel(BriefingWidgets.JOB_ID)
        context.getSystemService(JobScheduler::class.java).cancel(BriefingWidgets.TURN_JOB_ID)
        BriefingWidgets.clear(context)
      }
    }
  }
}

class OverviewWidget : BriefingWidget()
class ProfileWidget : BriefingWidget()
class ElectionWidget : BriefingWidget()
class CorporationWidget : BriefingWidget()
class StocksWidget : BriefingWidget()

object BriefingWidgets {
  const val JOB_ID = 21001
  /** A refresh at the next turn, so the figures change when the turn does. */
  const val TURN_JOB_ID = 21002
  const val NEXT = "net.lakesidegames.ahdclient.widget.NEXT"
  const val PREVIOUS = "net.lakesidegames.ahdclient.widget.PREVIOUS"
  const val REFRESH = "net.lakesidegames.ahdclient.widget.REFRESH"
  const val ORIGIN = "https://ahousedividedgame.com"
  // Overview is last so saved card positions from older versions still match.
  val sections = listOf("profile", "election", "corporation", "stocks", "overview")
  private val labels = listOf("Profile", "Election", "Corporation", "Stocks", "Overview")
  private val providers = listOf(ProfileWidget::class.java, ElectionWidget::class.java, CorporationWidget::class.java,
    StocksWidget::class.java, OverviewWidget::class.java)
  private val lock = Any()

  fun ids(context: Context): List<Int> = CompanionSafety.get("widget lookup", emptyList()) {
    providers.flatMap {
      AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, it)).toList()
    }
  }

  fun section(context: Context, id: Int): Int = CompanionSafety.get("widget section lookup", 0) {
    val provider = AppWidgetManager.getInstance(context).getAppWidgetInfo(id)?.provider?.className
    val default = providers.indexOfFirst { it.name == provider }.coerceAtLeast(0)
    context.getSharedPreferences("briefing-widget-prefs", Context.MODE_PRIVATE)
      .getInt("section-$id", default).coerceIn(sections.indices)
  }

  fun schedule(context: Context) {
    CompanionSafety.run("widget schedule") {
      if (ids(context).isEmpty()) return@run
      val scheduler = context.getSystemService(JobScheduler::class.java)
      if (scheduler.getPendingJob(JOB_ID) != null) return@run
      scheduler.schedule(JobInfo.Builder(JOB_ID, ComponentName(context, BriefingRefreshJob::class.java))
        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setMinimumLatency(0).build())
    }
  }

  /**
   * Fetch again once the next turn has run, like the iOS timeline. Shortly
   * after the scheduled time, then every five minutes for up to half an hour
   * while the turn is still processing.
   */
  private fun scheduleTurnRefresh(context: Context, data: JSONObject) {
    CompanionSafety.run("widget turn schedule") {
      if (ids(context).isEmpty() || data.optJSONObject("turn")?.optBoolean("active", true) == false) return@run
      val at = nextTurnAt(data) ?: return@run
      val now = System.currentTimeMillis()
      val delay = when {
        at > now -> at - now + 15_000
        now - at < 1_800_000 -> 300_000L
        else -> return@run
      }
      if (delay > 86_400_000) return@run
      context.getSystemService(JobScheduler::class.java).schedule(
        JobInfo.Builder(TURN_JOB_ID, ComponentName(context, BriefingRefreshJob::class.java))
          .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setMinimumLatency(delay).build())
    }
  }

  private fun cacheFile(context: Context) = File(context.noBackupFilesDir, "multiplayer-briefing.json")
  fun clear(context: Context) = synchronized(lock) { cacheFile(context).delete(); Unit }
  private fun read(context: Context): JSONObject? = CompanionSafety.get("widget cache read", null) {
    synchronized(lock) {
      val data = JSONObject(cacheFile(context).readText())
      val cookie = session()
      if (cookie.isNotEmpty() && data.optString("identity") == fingerprint(cookie)) data else null
    }
  }

  /** Unread inbox count and when it was fetched, for the tab bar badge. */
  fun inbox(context: Context): Pair<Int, Long>? = CompanionSafety.get("inbox count read", null) {
    val data = read(context) ?: return@get null
    val unread = data.optJSONObject("inbox")?.optDouble("unread", 0.0) ?: 0.0
    Pair(unread.coerceIn(0.0, 99_999.0).toInt(), data.optLong("updatedAt", 0L))
  }

  private fun session(): String = (CookieManager.getInstance().getCookie("$ORIGIN/api/client-status") ?: "")
    .split(';').map { it.trim() }.filter {
      val name = it.substringBefore('=')
      name == "auth-token" || name.matches(Regex("auth-token-[a-zA-Z0-9-]+")) ||
        name.matches(Regex("(__Secure-)?(authjs|next-auth)\\.session-token(\\.[0-9]+)?"))
    }.sorted().joinToString("; ")

  private fun fingerprint(session: String) = MessageDigest.getInstance("SHA-256")
    .digest(session.toByteArray()).joinToString("") { "%02x".format(it) }

  fun refresh(context: Context) {
    CompanionSafety.run("widget refresh") { refreshUnsafe(context) }
  }

  private fun refreshUnsafe(context: Context) {
    var connection: HttpURLConnection? = null
    try {
      val cookie = session()
      val identity = fingerprint(cookie)
      if (cookie.isEmpty()) { clear(context); return }
      if (read(context)?.optString("identity") != identity) clear(context)
      // widgets=1 adds the turn clock and inbox counts.
      val activeConnection = URL("$ORIGIN/api/client-status?layout=full&widgets=1").openConnection() as? HttpURLConnection
        ?: return
      connection = activeConnection
      activeConnection.connectTimeout = 6000
      activeConnection.readTimeout = 6000
      activeConnection.instanceFollowRedirects = false
      activeConnection.useCaches = false
      activeConnection.setRequestProperty("Cookie", cookie)
      activeConnection.setRequestProperty("X-AHD-Client-Version", BuildConfig.VERSION_NAME)
      activeConnection.setRequestProperty("Cache-Control", "no-cache")
      val status = activeConnection.responseCode
      if (cookie != session()) { clear(context); return }
      if (status == 401 || status == 403) { clear(context); return }
      if (status != 200) return
      val body = activeConnection.inputStream.use { input ->
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
          val size = input.read(buffer)
          if (size < 0) break
          output.write(buffer, 0, size)
          if (output.size() > 131072) return
        }
        output.toString("UTF-8")
      }
      if (cookie != session()) { clear(context); return }
      val raw = JSONObject(body)
      val safe = sanitize(raw).put("updatedAt", System.currentTimeMillis()).put("identity", identity)
      synchronized(lock) {
        val file = cacheFile(context)
        val temporary = File(file.path + ".tmp")
        temporary.writeText(safe.toString())
        if (!temporary.renameTo(file)) temporary.delete()
      }
      scheduleTurnRefresh(context, safe)
    } finally {
      connection?.let { active ->
        CompanionSafety.run("widget connection cleanup") { active.disconnect() }
      }
      CompanionSafety.run("widget refresh render") { render(context) }
    }
  }

  fun sanitize(raw: JSONObject): JSONObject {
    if (raw.optString("status") == "no-character") return JSONObject().put("status", "no-character")
    require(raw.has("name") && raw.get("name") is String)
    val safe = JSONObject().put("status", "ready")
    for (key in listOf("name", "avatarUrl", "actions", "actionCap", "funds", "personalHomeLiquid", "homeCurrency",
      "politicalInfluence", "nationalInfluence", "favorability", "isImperial")) {
      if (raw.has(key) && (key != "avatarUrl" || safeImageUrl(raw.optString(key)) != null)) safe.put(key, raw.get(key))
    }
    for ((key, fields) in mapOf(
      "electionStats" to listOf("electionId", "electionType", "countryId", "state", "myVotePct", "marginPct", "seatsProjected", "totalSeats", "isMultiSeat", "endTurn"),
      "corpNav" to listOf("sequentialId", "name", "logoUrl", "tickerSymbol", "sharePrice", "priceChange1h", "liquidCapital", "liquidCurrencyCode", "marketingStrength", "marketCap"),
      "turn" to listOf("current", "date", "nextAt", "active"),
      "inbox" to listOf("unread", "mail")
    )) {
      val source = raw.optJSONObject(key) ?: continue
      val child = JSONObject()
      fields.forEach {
        if (source.has(it) && (it != "logoUrl" || safeImageUrl(source.optString(it)) != null)) child.put(it, source.get(it))
      }
      safe.put(key, child)
    }
    // Recent values for the trend lines and per-turn fallbacks, newest last.
    for ((key, fields) in listOf(
      "electionStats" to listOf("trend" to "pct", "trendSeats" to "seats"),
      "corpNav" to listOf("trend" to "sharePrice", "trendMarketing" to "marketingStrength",
        "trendCapital" to "liquidCapital", "trendMarketCap" to "marketCap")
    )) {
      val history = raw.optJSONObject(key)?.optJSONArray("history") ?: continue
      for ((name, field) in fields) {
        val values = org.json.JSONArray()
        for (index in maxOf(0, history.length() - 12) until history.length()) {
          val value = history.optJSONObject(index)?.optDouble(field, Double.NaN) ?: Double.NaN
          if (value.isFinite()) values.put(value)
        }
        safe.optJSONObject(key)?.put(name, values)
      }
    }
    raw.optJSONObject("perTurn")?.let { source ->
      val changes = JSONObject()
      for (key in listOf("funds", "politicalInfluence", "nationalInfluence", "favorability", "voteShare", "sharePrice", "marketCap", "liquidCapital")) {
        val value = source.optDouble(key, Double.NaN)
        if (value.isFinite() && kotlin.math.abs(value) < 1e18) changes.put(key, value)
      }
      safe.put("perTurn", changes)
    }
    raw.optJSONArray("turnBriefing")?.let { source ->
      val changes = org.json.JSONArray()
      for (index in 0 until minOf(source.length(), 5)) {
        val item = source.optJSONObject(index) ?: continue
        val value = item.optDouble("value", Double.NaN)
        val delta = item.optDouble("delta", Double.NaN)
        if (!value.isFinite() || !delta.isFinite()) continue
        val change = JSONObject().put("category", item.optString("category").take(20))
          .put("label", item.optString("label").take(80)).put("value", value).put("delta", delta)
          .put("unit", item.optString("unit").take(16))
        gamePath(item.optString("href"))?.let { change.put("href", it) }
        changes.put(change)
      }
      safe.put("turnBriefing", changes)
    }
    raw.optJSONArray("marketWatch")?.let { source ->
      val watched = org.json.JSONArray()
      for (index in 0 until minOf(source.length(), 5)) {
        val item = source.optJSONObject(index) ?: continue
        if (item.optLong("sequentialId", -1) <= 0 || item.optDouble("ownedShares", 0.0) <= 0) continue
        val child = JSONObject()
        for (key in listOf("sequentialId", "name", "logoUrl", "tickerSymbol", "sharePrice", "liquidCurrencyCode", "ownedShares")) {
          if (item.has(key) && (key != "logoUrl" || safeImageUrl(item.optString(key)) != null)) child.put(key, item.get(key))
        }
        watched.put(child)
      }
      safe.put("marketWatch", watched)
    }
    return safe
  }

  private fun safeImageUrl(value: String): String? = CompanionSafety.get("widget image validation", null) {
    val uri = Uri.parse(value)
    val host = uri.host?.lowercase().orEmpty()
    value.takeIf { it.length <= 2048 && uri.scheme == "https" &&
      (host == "ahousedividedgame.com" || host.endsWith(".ahousedividedgame.com") ||
        host == "cdn.discordapp.com" || host.endsWith(".public.blob.vercel-storage.com")) }
  }

  fun page(context: Context, section: String): String? {
    val data = read(context)
    return when (section) {
      "profile" -> "/profile"
      "election" -> data?.optJSONObject("electionStats")?.optString("electionId")
        ?.takeIf { it.matches(Regex("[0-9a-fA-F]{24}")) }?.let { "/elections/$it" } ?: "/elections"
      "corporation" -> data?.optJSONObject("corpNav")?.optLong("sequentialId", -1)
        ?.takeIf { it > 0 }?.let { "/corporation/$it" } ?: "/corporation"
      "stocks" -> data?.optJSONArray("marketWatch")?.optJSONObject(0)?.optLong("sequentialId", -1)
        ?.takeIf { it > 0 }?.let { "/corporation/$it" } ?: "/stockmarket/global"
      "inbox" -> "/notifications"
      else -> null
    }
  }

  /** A bounded path on the game site, or null for anything that could leave it. */
  fun gamePath(value: String?): String? = value?.takeIf { path ->
    path.length <= 300 && path.startsWith("/") && !path.startsWith("//") &&
      path.none { it == '\\' || it.isWhitespace() || it.isISOControl() }
  }

  // Formatting, matched to the iOS widgets.

  private fun double(source: JSONObject?, key: String): Double? =
    source?.takeIf { it.has(key) }?.optDouble(key, Double.NaN)?.takeIf { it.isFinite() }

  private fun text(source: JSONObject?, key: String): String? =
    source?.optString(key)?.takeIf { it.isNotBlank() && it != "null" }

  private fun values(source: JSONObject?, key: String): List<Double> {
    val array = source?.optJSONArray(key) ?: return emptyList()
    return (0 until array.length()).map { array.optDouble(it, Double.NaN) }.filter { it.isFinite() }
  }

  /** Compact figure: 1.2K, 3.4M, 5.6B. Values under 10 keep two decimals. */
  private fun number(value: Double?, suffix: String = ""): String {
    if (value == null || !value.isFinite()) return "n/a"
    val magnitude = kotlin.math.abs(value)
    val formatted = when {
      magnitude >= 1e9 -> DecimalFormat("#,##0.#").format(value / 1e9) + "B"
      magnitude >= 1e6 -> DecimalFormat("#,##0.#").format(value / 1e6) + "M"
      magnitude >= 1e4 -> DecimalFormat("#,##0.#").format(value / 1e3) + "K"
      magnitude < 10 -> DecimalFormat("#,##0.##").format(value)
      else -> DecimalFormat("#,##0.#").format(value)
    }
    return formatted + suffix
  }

  private fun signed(value: Double, suffix: String = ""): String {
    val text = number(value, suffix)
    return if (value > 0) "+$text" else text
  }

  /** A per-turn change, or null when it is unknown or rounds to nothing. */
  private fun change(value: Double?, suffix: String = ""): String? =
    value?.takeIf { it.isFinite() && kotlin.math.abs(it) >= 0.005 }?.let { signed(it, suffix) }

  private fun currency(code: String?): String = code?.let { " $it" } ?: ""

  /** The change between the two latest recorded values. */
  private fun latestChange(values: List<Double>): Double? =
    if (values.size < 2) null else (values[values.size - 1] - values[values.size - 2]).takeIf { it.isFinite() }

  private fun nextTurnAt(data: JSONObject?): Long? {
    val at = text(data?.optJSONObject("turn"), "nextAt") ?: return null
    return listOf("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX").firstNotNullOfOrNull { pattern ->
      CompanionSafety.get("widget turn time", null as Long?) {
        java.text.SimpleDateFormat(pattern, java.util.Locale.US).parse(at)?.time
      }
    }
  }

  private fun nextTurn(context: Context, data: JSONObject?): String? {
    val turn = data?.optJSONObject("turn") ?: return null
    if (!turn.optBoolean("active", true)) return "turns paused"
    val at = nextTurnAt(data) ?: return null
    return if (at <= System.currentTimeMillis()) "next turn running"
    else "next turn at ${android.text.format.DateFormat.getTimeFormat(context).format(java.util.Date(at))}"
  }

  private fun inboxText(data: JSONObject?): String? {
    val inbox = data?.optJSONObject("inbox") ?: return null
    val unread = double(inbox, "unread") ?: 0.0
    return if (unread > 0) "${number(unread)} unread" else "All read"
  }

  // The card model. Each section builds the same figures as its iOS widget.

  private class Figure(val label: String, val short: String, val value: String, val change: String?, val positive: Boolean)

  private class Row(val title: String, val value: String, val change: String?, val positive: Boolean,
    val neutral: Boolean, val path: String?)

  private class Card(
    val title: String,
    val subtitle: String,
    val heroLabel: String,
    val heroValue: String,
    val heroChange: String?,
    val heroPositive: Boolean,
    /** Epoch milliseconds the hero counts down to, for the overview. */
    val countdownTo: Long? = null,
    val heroNote: String? = null,
    val chart: List<Double> = emptyList(),
    val chartColor: Int = GOLD,
    val chartLabel: String = "",
    val chartPercent: Boolean = false,
    val figures: List<Figure> = emptyList(),
    val rows: List<Row> = emptyList(),
    val rowsTitle: String = "Latest turn"
  )

  private const val CREAM = 0xFFF7F0DB.toInt()
  private const val GOLD = 0xFFE8B852.toInt()
  private const val GAIN = 0xFF66D685.toInt()
  private const val LOSS = 0xFFFA706B.toInt()
  private const val BLUE = 0xFF85B8FA.toInt()
  private const val NAVY = 0xFF090E17.toInt()
  private const val PROFILE_RED = 0xFFDB4D52.toInt()

  private fun accent(section: String) = when (section) {
    "election" -> BLUE
    "corporation", "stocks" -> GOLD
    "overview" -> CREAM
    else -> PROFILE_RED
  }

  private fun figure(label: String, short: String, value: String, change: Double? = null, suffix: String = "") =
    Figure(label, short, value, change(change, suffix), (change ?: 0.0) >= 0)

  private fun turnSubtitle(data: JSONObject): String? {
    val turn = data.optJSONObject("turn") ?: return null
    val current = double(turn, "current") ?: return null
    return listOfNotNull("Turn ${current.toLong()}", text(turn, "date")).joinToString(" · ")
  }

  /** Funds, influence and favorability, each with its per-turn change. */
  private fun standing(data: JSONObject): List<Figure> {
    if (data.optBoolean("isImperial")) return emptyList()
    val money = currency(text(data, "homeCurrency"))
    val perTurn = data.optJSONObject("perTurn")
    val result = mutableListOf(
      figure("Campaign funds", "Funds", number(double(data, "funds"), money), double(perTurn, "funds")),
      figure("State influence", "State", number(double(data, "politicalInfluence"), "%"), double(perTurn, "politicalInfluence"))
    )
    double(data, "nationalInfluence")?.let {
      result.add(figure("National influence", "National", number(it), double(perTurn, "nationalInfluence")))
    }
    result.add(figure("Favorability", "Favor", number(double(data, "favorability"), "%"), double(perTurn, "favorability")))
    return result
  }

  private fun changeRows(data: JSONObject): List<Row> {
    val source = data.optJSONArray("turnBriefing") ?: return emptyList()
    val money = currency(text(data.optJSONObject("corpNav"), "liquidCurrencyCode"))
    return (0 until source.length()).mapNotNull { source.optJSONObject(it) }.map { item ->
      val value = item.optDouble("value")
      val delta = item.optDouble("delta")
      val suffix = if (item.optString("category") == "election") "" else money
      val (shown, moved) = when (item.optString("unit")) {
        "currency" -> number(value, suffix) to signed(delta, suffix)
        "percent" -> number(value, "%") to signed(delta, " pp")
        else -> number(value) to signed(delta)
      }
      Row(item.optString("label"), shown, moved, delta >= 0, false, gamePath(text(item, "href")))
    }
  }

  private fun actionsText(data: JSONObject): String {
    val cap = double(data, "actionCap")
    return number(double(data, "actions")) + (cap?.let { " / " + number(it) } ?: "")
  }

  private fun card(section: String, data: JSONObject, compact: Boolean): Card? {
    val money = currency(text(data, "homeCurrency"))
    val cash = figure("Personal cash", "Cash", number(double(data, "personalHomeLiquid"), money))
    val imperial = data.optBoolean("isImperial")
    val name = text(data, "name")?.take(100) ?: "Your character"
    val inbox = inboxText(data)
    return when (section) {
      "overview" -> {
        val turn = data.optJSONObject("turn")
        val next = nextTurnAt(data)
        val now = System.currentTimeMillis()
        val (value, countdown) = when {
          turn != null && !turn.optBoolean("active", true) -> "Paused" to null
          next != null && next > now -> "" to next
          next != null -> "Running" to null
          else -> "n/a" to null
        }
        val figures = mutableListOf<Figure>()
        inbox?.let { figures.add(figure("Inbox", "Inbox", it)) }
        figures.addAll(standing(data))
        double(data.optJSONObject("inbox"), "mail")?.let {
          figures.add(figure("Mail", "Mail", if (it > 0) "${number(it)} unread" else "All read"))
        }
        figures.add(cash)
        Card(name, turnSubtitle(data) ?: "Overview", "Next turn", value, null, true, countdownTo = countdown,
          heroNote = if (imperial) "Personal cash ${cash.value}" else "Actions ${actionsText(data)}",
          figures = figures, rows = changeRows(data))
      }
      "profile" -> {
        val figures = standing(data).toMutableList()
        if (imperial) figures.add(cash) else figures.add(minOf(1, figures.size), cash)
        inbox?.let { figures.add(figure("Inbox", "Inbox", it)) }
        if (imperial) Card(name, turnSubtitle(data) ?: "Profile", "Personal cash", cash.value, null, true,
          figures = figures, rows = changeRows(data))
        else Card(name, turnSubtitle(data) ?: "Profile", "Actions", actionsText(data), null, true,
          figures = figures, rows = changeRows(data))
      }
      "election" -> {
        val election = data.optJSONObject("electionStats") ?: return null
        val shares = values(election, "trend")
        val vote = double(data.optJSONObject("perTurn"), "voteShare") ?: latestChange(shares)
        val figures = mutableListOf<Figure>()
        val margin = double(election, "marginPct")
        figures.add(Figure("Margin", "Margin", margin?.let { signed(it, " pp") } ?: "n/a", null, (margin ?: 0.0) >= 0))
        if (election.optBoolean("isMultiSeat")) {
          val seats = number(double(election, "seatsProjected")) +
            (double(election, "totalSeats")?.let { " / " + number(it) } ?: "")
          figures.add(figure("Projected seats", "Seats", seats, latestChange(values(election, "trendSeats"))))
        }
        double(election, "endTurn")?.let { end ->
          val now = double(data.optJSONObject("turn"), "current")
          val left = if (now != null && end > now) (end - now).toLong() else null
          figures.add(figure("Polls close", "Polls",
            if (left == null) "Turn ${end.toLong()}" else if (left == 1L) "Next turn" else "In $left turns"))
        }
        if (shares.size >= 3) {
          figures.add(figure("Over ${shares.size} turns", "${shares.size} turns", signed(shares.last() - shares.first(), " pp")))
        }
        val subtitle = listOfNotNull(text(election, "electionType"), text(election, "state") ?: text(election, "countryId"))
          .joinToString(" · ").ifEmpty { "Election" }
        Card("Your election", subtitle, "Vote share", number(double(election, "myVotePct"), "%"),
          change(vote, " pp"), (vote ?: 0.0) >= 0, chart = shares, chartColor = BLUE,
          chartLabel = "Vote share, last ${minOf(shares.size, 12)} turns", chartPercent = true, figures = figures)
      }
      "corporation" -> {
        val corp = data.optJSONObject("corpNav") ?: return null
        val perTurn = data.optJSONObject("perTurn")
        val ccy = currency(text(corp, "liquidCurrencyCode"))
        val prices = values(corp, "trend")
        val price = double(corp, "sharePrice")
        val priceChange = double(perTurn, "sharePrice") ?: latestChange(prices)
        val percent = if (priceChange != null && price != null && price - priceChange > 0)
          (priceChange / (price - priceChange) * 100).takeIf { it.isFinite() } else null
        val hour = double(corp, "priceChange1h")
        val heroChange: String?
        val heroPositive: Boolean
        val absolute = change(priceChange)
        if (absolute != null) {
          // Narrow widgets show only the percentage; wider ones show both.
          val pct = change(percent, "%")
          heroChange = if (compact) pct ?: absolute else pct?.let { "$absolute ($it)" } ?: absolute
          heroPositive = (priceChange ?: 0.0) >= 0
        } else {
          // Servers without per-turn changes: fall back to the last hour.
          heroChange = change(hour, "%")
          heroPositive = (hour ?: 0.0) >= 0
        }
        val figures = mutableListOf<Figure>()
        double(corp, "marketCap")?.let {
          figures.add(figure("Market cap", "Mkt cap", number(it, ccy),
            double(perTurn, "marketCap") ?: latestChange(values(corp, "trendMarketCap"))))
        }
        figures.add(figure("Liquid capital", "Capital", number(double(corp, "liquidCapital"), ccy),
          double(perTurn, "liquidCapital") ?: latestChange(values(corp, "trendCapital"))))
        figures.add(figure("Marketing", "Marketing", number(double(corp, "marketingStrength")),
          latestChange(values(corp, "trendMarketing"))))
        hour?.let { figures.add(Figure("Last hour", "Last hour", signed(it, "%"), null, it >= 0)) }
        if (prices.size >= 3 && prices.first() > 0) {
          val trend = (prices.last() - prices.first()) / prices.first() * 100
          figures.add(Figure("Over ${prices.size} turns", "${prices.size} turns", signed(trend, "%"), null, trend >= 0))
        }
        val color = if (prices.size >= 2 && prices.last() < prices.first()) LOSS else GAIN
        Card(text(corp, "name")?.take(100) ?: "Corporation", text(corp, "tickerSymbol")?.let { "\$${it.uppercase()}" } ?: "Corporation",
          "Share price", number(price, ccy), heroChange, heroPositive, chart = prices, chartColor = color,
          chartLabel = "Share price, last ${minOf(prices.size, 12)} turns", figures = figures)
      }
      else -> {
        val holdings = data.optJSONArray("marketWatch")?.takeIf { it.length() > 0 } ?: return null
        val items = (0 until minOf(holdings.length(), 5)).mapNotNull { holdings.optJSONObject(it) }
        val first = items.firstOrNull() ?: return null
        fun ticker(item: JSONObject) = text(item, "tickerSymbol")?.let { "\$${it.uppercase()}" } ?: item.optString("name").take(24)
        val rows = items.map { item ->
          val ccy = currency(text(item, "liquidCurrencyCode"))
          val quote = double(item, "sharePrice")
          val owned = double(item, "ownedShares") ?: 0.0
          Row(ticker(item), number(quote, ccy), quote?.let { number(it * owned, ccy) }, true, true,
            item.optLong("sequentialId", -1).takeIf { it > 0 }?.let { "/corporation/$it" })
        }
        val ccy = currency(text(first, "liquidCurrencyCode"))
        val quote = double(first, "sharePrice")
        val owned = double(first, "ownedShares") ?: 0.0
        val figures = mutableListOf(figure("Shares owned", "Shares", number(owned)))
        quote?.let { figures.add(figure("Holding value", "Value", number(it * owned, ccy))) }
        val many = items.size > 1
        Card(if (many) "Your holdings" else ticker(first), if (many) "${items.size} companies" else first.optString("name").take(60),
          "Quote", number(quote, ccy), null, true, figures = figures, rows = rows, rowsTitle = "Holdings")
      }
    }
  }

  /**
   * The trend chart as a bitmap, since RemoteViews cannot draw paths: a
   * lighter panel, dashed grid, solid baseline, a heavy line over a filled
   * area and a dot on the latest value, with the high and low on the right.
   */
  private fun chartBitmap(context: Context, values: List<Double>, color: Int, widthDp: Int, heightDp: Int,
    scale: ((Double) -> String)?): android.graphics.Bitmap? {
    val points = values.filter { it.isFinite() }.takeLast(12)
    if (points.size < 2) return null
    val density = context.resources.displayMetrics.density
    val width = (widthDp * density).toInt().coerceIn(80, 1400)
    val height = (heightDp * density).toInt().coerceIn(24, 400)
    val bitmap = android.graphics.Bitmap.createBitmap(width, height, android.graphics.Bitmap.Config.ARGB_8888)
    val canvas = android.graphics.Canvas(bitmap)
    val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
    val low = points.minOrNull() ?: return null
    val high = points.maxOrNull() ?: return null
    val labelSize = 8 * density
    var labelWidth = 0f
    val labels = scale?.let { listOf(it(high), it(low)) }
    if (labels != null) {
      paint.textSize = labelSize
      labelWidth = labels.maxOf { paint.measureText(it) } + 5 * density
    }
    val panel = android.graphics.RectF(0.5f, 0.5f, width - labelWidth - 0.5f, height - 0.5f)
    val radius = 6 * density
    paint.style = android.graphics.Paint.Style.FILL
    paint.color = 0x12FFFFFF
    canvas.drawRoundRect(panel, radius, radius, paint)
    paint.style = android.graphics.Paint.Style.STROKE
    paint.strokeWidth = density * 0.75f
    paint.color = 0x24FFFFFF
    canvas.drawRoundRect(panel, radius, radius, paint)
    val inset = 5 * density
    val plot = android.graphics.RectF(panel.left + inset, panel.top + inset, panel.right - inset, panel.bottom - inset)
    paint.pathEffect = android.graphics.DashPathEffect(floatArrayOf(2 * density, 3 * density), 0f)
    paint.color = 0x24FFFFFF
    for (fraction in listOf(0f, 0.5f)) {
      val y = plot.top + plot.height() * fraction
      canvas.drawLine(plot.left, y, plot.right, y, paint)
    }
    paint.pathEffect = null
    paint.color = 0x52FFFFFF
    canvas.drawLine(plot.left, plot.bottom, plot.right, plot.bottom, paint)
    val spread = maxOf(high - low, 0.0001)
    val xs = points.indices.map { plot.left + plot.width() * it / (points.size - 1) }
    val ys = points.map { plot.bottom - plot.height() * ((it - low) / spread).toFloat() }
    val line = android.graphics.Path()
    line.moveTo(xs[0], ys[0])
    for (index in 1 until points.size) line.lineTo(xs[index], ys[index])
    val area = android.graphics.Path(line)
    area.lineTo(xs.last(), plot.bottom)
    area.lineTo(xs[0], plot.bottom)
    area.close()
    paint.style = android.graphics.Paint.Style.FILL
    paint.shader = android.graphics.LinearGradient(0f, plot.top, 0f, plot.bottom,
      (color and 0x00FFFFFF) or 0x73000000, (color and 0x00FFFFFF) or 0x0A000000, android.graphics.Shader.TileMode.CLAMP)
    canvas.drawPath(area, paint)
    paint.shader = null
    paint.style = android.graphics.Paint.Style.STROKE
    paint.strokeWidth = 2.25f * density
    paint.strokeCap = android.graphics.Paint.Cap.ROUND
    paint.strokeJoin = android.graphics.Paint.Join.ROUND
    paint.color = color
    paint.setShadowLayer(1.5f * density, 0f, density, 0x80000000.toInt())
    canvas.drawPath(line, paint)
    paint.clearShadowLayer()
    paint.style = android.graphics.Paint.Style.FILL
    canvas.drawCircle(xs.last(), ys.last(), 3.75f * density, paint.apply { this.color = NAVY })
    canvas.drawCircle(xs.last(), ys.last(), 2.75f * density, paint.apply { this.color = color })
    if (labels != null) {
      paint.color = 0x99F7F0DB.toInt()
      paint.textSize = labelSize
      paint.textAlign = android.graphics.Paint.Align.RIGHT
      canvas.drawText(labels[0], width.toFloat(), labelSize + 2 * density, paint)
      canvas.drawText(labels[1], width.toFloat(), height - 3 * density, paint)
    }
    return bitmap
  }

  fun render(context: Context) {
    CompanionSafety.run("widget render") { renderUnsafe(context) }
  }

  private val figureCells = intArrayOf(R.id.fig_cell_0, R.id.fig_cell_1, R.id.fig_cell_2, R.id.fig_cell_3, R.id.fig_cell_4, R.id.fig_cell_5)
  private val figureLabels = intArrayOf(R.id.fig_label_0, R.id.fig_label_1, R.id.fig_label_2, R.id.fig_label_3, R.id.fig_label_4, R.id.fig_label_5)
  private val figureValues = intArrayOf(R.id.fig_value_0, R.id.fig_value_1, R.id.fig_value_2, R.id.fig_value_3, R.id.fig_value_4, R.id.fig_value_5)
  private val figureChanges = intArrayOf(R.id.fig_change_0, R.id.fig_change_1, R.id.fig_change_2, R.id.fig_change_3, R.id.fig_change_4, R.id.fig_change_5)
  private val figureRows = intArrayOf(R.id.fig_row_0, R.id.fig_row_1, R.id.fig_row_2)
  private val rowViews = intArrayOf(R.id.row_0, R.id.row_1, R.id.row_2, R.id.row_3)
  private val rowTitles = intArrayOf(R.id.row_title_0, R.id.row_title_1, R.id.row_title_2, R.id.row_title_3)
  private val rowValues = intArrayOf(R.id.row_value_0, R.id.row_value_1, R.id.row_value_2, R.id.row_value_3)
  private val rowChanges = intArrayOf(R.id.row_change_0, R.id.row_change_1, R.id.row_change_2, R.id.row_change_3)

  private fun visible(show: Boolean) = if (show) android.view.View.VISIBLE else android.view.View.GONE

  private fun monogram(title: String): String {
    val letters = title.replace("$", "").split(' ').filter { it.isNotBlank() }.take(2).map { it.first() }
    return if (letters.isEmpty()) "A" else letters.joinToString("").uppercase()
  }

  private fun renderUnsafe(context: Context) {
    val manager = AppWidgetManager.getInstance(context)
    val data = read(context)
    val age = System.currentTimeMillis() - (data?.optLong("updatedAt") ?: 0)
    val ready = data?.optString("status") == "ready" && age < 86_400_000
    for (id in ids(context)) {
      val selected = section(context, id)
      val sectionKey = sections[selected]
      val views = RemoteViews(context.packageName, R.layout.briefing_widget)
      // Size tiers from the launcher's reported size: compact shows short
      // labels, four figures and a small chart; taller widgets add the scale,
      // six figures and the latest turn's changes.
      val options = manager.getAppWidgetOptions(id)
      val heightDp = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0).takeIf { it > 0 } ?: 280
      val widthDp = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 0).takeIf { it > 0 } ?: 320
      val compact = heightDp < 250
      val rowLimit = if (heightDp >= 380) 4 else if (heightDp >= 320) 2 else 0
      val card = if (ready) CompanionSafety.get("widget card", null as Card?) { card(sectionKey, data!!, compact) } else null
      val message = when {
        !ready && data?.optString("status") == "no-character" -> "Choose a character in the app."
        !ready && data != null -> "Saved stats expired. Open the app to refresh."
        !ready -> "Sign in to Multiplayer in AHDClient."
        card != null -> null
        sectionKey == "election" -> "No election tally yet."
        sectionKey == "stocks" -> "Buy shares to populate your private market watch."
        sectionKey == "corporation" -> "Your character does not lead a corporation."
        else -> "Stats are unavailable. Tap Refresh to try again."
      }
      val title = card?.title ?: if (ready && sectionKey in listOf("profile", "overview")) text(data, "name")?.take(100) ?: labels[selected] else labels[selected]
      views.setTextViewText(R.id.briefing_title, title)
      views.setTextViewText(R.id.briefing_monogram, monogram(title))
      views.setTextViewText(R.id.briefing_subtitle, card?.subtitle ?: labels[selected])
      views.setTextColor(R.id.briefing_subtitle, accent(sectionKey))
      views.setViewVisibility(R.id.briefing_message, visible(message != null))
      views.setTextViewText(R.id.briefing_message, message ?: "")
      views.setViewVisibility(R.id.briefing_body, visible(card != null))
      if (card != null) {
        views.setTextViewText(R.id.briefing_hero_label, card.heroLabel)
        val countdown = card.countdownTo
        views.setViewVisibility(R.id.briefing_hero_timer, visible(countdown != null))
        views.setViewVisibility(R.id.briefing_hero_value, visible(countdown == null))
        if (countdown != null) {
          views.setChronometer(R.id.briefing_hero_timer,
            android.os.SystemClock.elapsedRealtime() + (countdown - System.currentTimeMillis()), null, true)
          views.setChronometerCountDown(R.id.briefing_hero_timer, true)
        } else {
          views.setTextViewText(R.id.briefing_hero_value, card.heroValue)
        }
        views.setTextViewText(R.id.briefing_hero_change, card.heroChange ?: "")
        views.setTextColor(R.id.briefing_hero_change, if (card.heroPositive) GAIN else LOSS)
        views.setViewVisibility(R.id.briefing_hero_note, visible(card.heroNote != null))
        views.setTextViewText(R.id.briefing_hero_note, card.heroNote ?: "")

        val chartHeight = if (compact) 28 else 56
        val chart = if (card.chart.size >= 2) CompanionSafety.get("widget chart", null as android.graphics.Bitmap?) {
          val scale: ((Double) -> String)? = if (compact) null
            else fun(value: Double): String = number(value, if (card.chartPercent) "%" else "")
          chartBitmap(context, card.chart, card.chartColor, widthDp - 24, chartHeight, scale)
        } else null
        views.setViewVisibility(R.id.briefing_chart, visible(chart != null))
        views.setViewVisibility(R.id.briefing_chart_label, visible(chart != null && !compact))
        views.setTextViewText(R.id.briefing_chart_label, card.chartLabel)
        if (chart != null) views.setImageViewBitmap(R.id.briefing_chart, chart)

        // Stocks with several holdings list them in place of the figures when
        // the widget is short, like the iOS medium size.
        val holdingsInstead = sectionKey == "stocks" && card.rows.size > 1 && compact
        val figureLimit = if (holdingsInstead) 0 else if (compact) (if (chart != null) 2 else 4) else 6
        val figures = card.figures.take(figureLimit)
        views.setViewVisibility(R.id.briefing_figures_label, visible(figures.isNotEmpty() && !compact && sectionKey != "stocks"))
        for (index in figureCells.indices) {
          val item = figures.getOrNull(index)
          views.setViewVisibility(figureCells[index], if (item != null) android.view.View.VISIBLE else android.view.View.INVISIBLE)
          views.setTextViewText(figureLabels[index], item?.let { if (compact) it.short else it.label } ?: "")
          views.setTextViewText(figureValues[index], item?.value ?: "")
          views.setTextViewText(figureChanges[index], item?.change ?: "")
          views.setTextColor(figureChanges[index], if (item?.positive != false) GAIN else LOSS)
        }
        for (index in figureRows.indices) views.setViewVisibility(figureRows[index], visible(index * 2 < figures.size))

        val rows = card.rows.take(if (holdingsInstead) 4 else rowLimit)
        views.setViewVisibility(R.id.briefing_rows_rule, visible(rows.isNotEmpty() && !holdingsInstead))
        views.setViewVisibility(R.id.briefing_rows_label, visible(rows.isNotEmpty() && !holdingsInstead))
        views.setTextViewText(R.id.briefing_rows_label, card.rowsTitle)
        for (index in rowViews.indices) {
          val row = rows.getOrNull(index)
          views.setViewVisibility(rowViews[index], visible(row != null))
          if (row == null) continue
          views.setTextViewText(rowTitles[index], row.title)
          views.setTextViewText(rowValues[index], row.value)
          views.setTextViewText(rowChanges[index], row.change ?: "")
          views.setTextColor(rowChanges[index], if (row.neutral) 0x99F7F0DB.toInt() else if (row.positive) GAIN else LOSS)
          row.path?.let { path ->
            val open = Intent(context, MainActivity::class.java).setAction(Intent.ACTION_VIEW)
              .setData(Uri.parse("ahdclient://page$path"))
            views.setOnClickPendingIntent(rowViews[index], PendingIntent.getActivity(context, id * 8 + index + 1, open,
              PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
          }
        }
      }
      views.setTextViewText(R.id.briefing_updated, if (ready) {
        val mins = (age / 60000).coerceAtLeast(0)
        listOfNotNull(if (sectionKey == "overview") null else nextTurn(context, data),
          if (mins < 1) "updated just now" else "updated ${mins}m ago")
          .joinToString(" · ").replaceFirstChar { it.uppercase() }
      } else "Multiplayer")
      views.setTextViewText(R.id.briefing_section, "${labels[selected]} · ${selected + 1} of ${sections.size}")
      // The overview opens the inbox, like the iOS overview widget.
      val target = if (sectionKey == "overview") "inbox" else sectionKey
      val open = Intent(context, MainActivity::class.java).setAction(Intent.ACTION_VIEW)
        .setData(Uri.parse("ahdclient://briefing/$target"))
      views.setOnClickPendingIntent(R.id.briefing_content_area, PendingIntent.getActivity(context, id * 8, open,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
      for ((view, action) in listOf(R.id.briefing_next to NEXT, R.id.briefing_previous to PREVIOUS, R.id.briefing_refresh to REFRESH)) {
        val provider = manager.getAppWidgetInfo(id)?.provider ?: continue
        val intent = Intent(action).setComponent(provider).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
          .setData(Uri.parse("ahdclient://widget/$id/${action.substringAfterLast('.')}"))
        views.setOnClickPendingIntent(view, PendingIntent.getBroadcast(context, id, intent,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
      }
      manager.updateAppWidget(id, views)
    }
  }
}

class BriefingRefreshJob : JobService() {
  private val executor = Executors.newSingleThreadExecutor()
  private var task: Future<*>? = null
  override fun onStartJob(params: JobParameters): Boolean {
    val submitted = CompanionSafety.get("widget job start", null as Future<*>?) {
      executor.submit {
        try {
          BriefingWidgets.refresh(applicationContext)
        } finally {
          CompanionSafety.run("widget job finish") { jobFinished(params, false) }
        }
      }
    }
    task = submitted
    return submitted != null
  }
  override fun onStopJob(params: JobParameters): Boolean {
    CompanionSafety.run("widget job stop") { task?.cancel(true) }
    return false
  }
  override fun onDestroy() {
    CompanionSafety.run("widget executor shutdown") { executor.shutdownNow() }
    super.onDestroy()
  }
}
