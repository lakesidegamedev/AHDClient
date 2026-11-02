package net.lakesidegames.ahdclient

import org.json.JSONObject
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale
import kotlin.math.abs

/**
 * What the dock's status strip and sheet show, built from the same sanitized
 * snapshot the widgets and the Inbox badge read (BriefingWidgets). Pure
 * Kotlin plus org.json so it is unit tested on the JVM.
 *
 * Figures match the widgets: compact numbers (1.2K, 3.4M), a per-turn change
 * beside funds, and the home currency code after money.
 */
class DockMetric(
  val label: String,
  val value: String,
  val change: String?,
  /** Sign of [change]; only meaningful when [change] is not null. */
  val positive: Boolean,
  /** A game page this row opens, or null when the row is informational. */
  val path: String?,
  /** Full wording for screen readers ("1.2 million dollars, up 40 thousand"). */
  val spoken: String,
)

class DockStatus(
  val nextTurnAt: Long?,
  val turnActive: Boolean,
  val turnTitle: String?,
  val funds: DockMetric?,
  val actions: DockMetric?,
  val corpCash: DockMetric?,
  val stateInfluence: DockMetric?,
  val nationalInfluence: DockMetric?,
  val notifications: Int,
  val mail: Int,
  val updatedAt: Long,
) {
  /** True when there is anything worth a strip. */
  val hasStrip: Boolean get() = funds != null || actions != null || nextTurnAt != null || !turnActive

  companion object {
    /** Canned figures for the screenshot preview link; never fetched. */
    fun preview(now: Long): DockStatus = DockStatus(
      nextTurnAt = now + 2 * 3_600_000L + 14 * 60_000L + 5_000L,
      turnActive = true,
      turnTitle = "Turn 214 · March 1976",
      funds = metric("Campaign funds", 1_284_000.0, 41_500.0, " USD", "/profile"),
      actions = DockMetric("Actions", "6 / 10", null, true, "/actions", "6 of 10 actions"),
      corpCash = metric("Corporate cash", 8_420_000.0, -120_000.0, " USD", "/corporation"),
      stateInfluence = metric("State influence", 42.0, 1.5, "%", "/profile"),
      nationalInfluence = metric("National influence", 17.0, null, "", "/profile"),
      notifications = 3,
      mail = 2,
      updatedAt = now,
    )

    /** Null for a signed-out player, a player with no character, or no cache. */
    fun from(data: JSONObject?): DockStatus? {
      if (data == null || data.optString("status") != "ready") return null
      val imperial = data.optBoolean("isImperial")
      val money = data.optString("homeCurrency").takeIf { it.isNotBlank() && it != "null" }?.let { " $it" } ?: ""
      val perTurn = data.optJSONObject("perTurn")
      val turn = data.optJSONObject("turn")
      val corp = data.optJSONObject("corpNav")

      val funds = if (imperial) null else double(data, "funds")?.let {
        metric("Campaign funds", it, double(perTurn, "funds"), money, "/profile")
      }
      val actionsNow = double(data, "actions")
      val actionCap = double(data, "actionCap")
      val actions = actionsNow?.let {
        val shown = DockFormat.number(it) + (actionCap?.let { cap -> " / " + DockFormat.number(cap) } ?: "")
        val spoken = DockFormat.spoken(it) + (actionCap?.let { cap -> " of " + DockFormat.spoken(cap) } ?: "") + " actions"
        DockMetric("Actions", shown, null, true, "/actions", spoken)
      }
      val corpMoney = corp?.optString("liquidCurrencyCode")?.takeIf { it.isNotBlank() && it != "null" }?.let { " $it" } ?: ""
      val corpPath = corp?.optLong("sequentialId", -1)?.takeIf { it > 0 }?.let { "/corporation/$it" }
      val corpCash = double(corp, "liquidCapital")?.let {
        metric("Corporate cash", it, double(perTurn, "liquidCapital"), corpMoney, corpPath ?: "/corporation")
      }
      val state = if (imperial) null else double(data, "politicalInfluence")?.let {
        metric("State influence", it, double(perTurn, "politicalInfluence"), "%", "/profile")
      }
      val national = if (imperial) null else double(data, "nationalInfluence")?.let {
        metric("National influence", it, double(perTurn, "nationalInfluence"), "", "/profile")
      }

      val current = double(turn, "current")?.toLong()
      val title = listOfNotNull(current?.let { "Turn $it" }, turn?.optString("date")?.takeIf { it.isNotBlank() && it != "null" })
        .joinToString(" · ").ifEmpty { null }
      val inbox = data.optJSONObject("inbox")
      return DockStatus(
        nextTurnAt = parseTime(turn?.optString("nextAt")),
        turnActive = turn?.optBoolean("active", true) ?: true,
        turnTitle = title,
        funds = funds,
        actions = actions,
        corpCash = corpCash,
        stateInfluence = state,
        nationalInfluence = national,
        notifications = (double(inbox, "unread") ?: 0.0).coerceIn(0.0, 99_999.0).toInt(),
        mail = (double(inbox, "mail") ?: 0.0).coerceIn(0.0, 99_999.0).toInt(),
        updatedAt = data.optLong("updatedAt", 0L),
      )
    }

    private fun metric(label: String, value: Double, change: Double?, suffix: String, path: String): DockMetric {
      val shownChange = change?.takeIf { it.isFinite() && abs(it) >= 0.005 }
      val money = suffix.startsWith(" ")
      val unit = if (money) " " + suffix.trim() else suffix
      val spokenUnit = if (money) " " + suffix.trim() else if (suffix == "%") " percent" else ""
      val spoken = buildString {
        append(label).append(' ').append(DockFormat.spoken(value)).append(spokenUnit)
        if (shownChange != null) {
          append(if (shownChange > 0) ", up " else ", down ").append(DockFormat.spoken(abs(shownChange))).append(spokenUnit)
        }
      }
      return DockMetric(
        label = label,
        value = DockFormat.number(value, unit),
        change = shownChange?.let { DockFormat.signed(it, if (suffix == "%") " pp" else "") },
        positive = (shownChange ?: 0.0) >= 0.0,
        path = path,
        spoken = spoken,
      )
    }

    private fun double(source: JSONObject?, key: String): Double? =
      source?.takeIf { it.has(key) }?.optDouble(key, Double.NaN)?.takeIf { it.isFinite() }

    private fun parseTime(value: String?): Long? {
      val text = value?.takeIf { it.isNotBlank() && it != "null" } ?: return null
      return listOf("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX").firstNotNullOfOrNull { pattern ->
        CompanionSafety.get("dock turn time", null as Long?) {
          java.text.SimpleDateFormat(pattern, Locale.US).parse(text)?.time
        }
      }
    }
  }
}

/** Number and countdown wording shared by the strip, the sheet and TalkBack. */
object DockFormat {
  /** Compact figure: 1.2K, 3.4M, 5.6B. Values under 10 keep two decimals. */
  fun number(value: Double, suffix: String = ""): String {
    if (!value.isFinite()) return "n/a"
    val magnitude = abs(value)
    val formatted = when {
      magnitude >= 1e9 -> format("#,##0.#", value / 1e9) + "B"
      magnitude >= 1e6 -> format("#,##0.#", value / 1e6) + "M"
      magnitude >= 1e4 -> format("#,##0.#", value / 1e3) + "K"
      magnitude < 10 -> format("#,##0.##", value)
      else -> format("#,##0.#", value)
    }
    return formatted + suffix
  }

  fun signed(value: Double, suffix: String = ""): String {
    val text = number(value, suffix)
    return if (value > 0) "+$text" else text
  }

  /** The same figure in words: "1.2 million", "40 thousand". */
  fun spoken(value: Double): String {
    if (!value.isFinite()) return "unknown"
    val magnitude = abs(value)
    return when {
      magnitude >= 1e9 -> format("#,##0.#", value / 1e9) + " billion"
      magnitude >= 1e6 -> format("#,##0.#", value / 1e6) + " million"
      magnitude >= 1e4 -> format("#,##0.#", value / 1e3) + " thousand"
      magnitude < 10 -> format("#,##0.##", value)
      else -> format("#,##0.#", value)
    }
  }

  private fun format(pattern: String, value: Double): String =
    DecimalFormat(pattern, DecimalFormatSymbols(Locale.getDefault())).format(value)

  /** Live countdown for the strip: "2h 14m", "14m 05s", "45s". */
  fun countdown(remainingMs: Long): String {
    val total = (remainingMs / 1000).coerceAtLeast(0)
    val days = total / 86_400
    val hours = (total % 86_400) / 3_600
    val minutes = (total % 3_600) / 60
    val seconds = total % 60
    return when {
      days > 0 -> "${days}d ${hours}h"
      hours > 0 -> "${hours}h ${minutes}m"
      minutes > 0 -> "${minutes}m ${seconds.toString().padStart(2, '0')}s"
      else -> "${seconds}s"
    }
  }

  /** The countdown in words for screen readers, coarse enough not to chatter. */
  fun spokenCountdown(remainingMs: Long): String {
    val total = (remainingMs / 1000).coerceAtLeast(0)
    val days = total / 86_400
    val hours = (total % 86_400) / 3_600
    val minutes = (total % 3_600) / 60
    fun unit(count: Long, name: String) = "$count $name" + if (count == 1L) "" else "s"
    return when {
      days > 0 -> unit(days, "day") + " " + unit(hours, "hour")
      hours > 0 -> unit(hours, "hour") + " " + unit(minutes, "minute")
      minutes > 0 -> unit(minutes, "minute")
      else -> "less than a minute"
    }
  }
}
