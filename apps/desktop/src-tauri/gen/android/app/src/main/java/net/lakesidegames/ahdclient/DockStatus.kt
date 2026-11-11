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
  /** The turn that is running now, when the server said. */
  val turnNumber: Int? = null,
) {
  /** True when there is anything worth a strip. */
  val hasStrip: Boolean get() = funds != null || actions != null || nextTurnAt != null || !turnActive

  companion object {
    /** Canned figures for the screenshot preview link; never fetched. */
    fun preview(now: Long): DockStatus = DockStatus(
      nextTurnAt = now + 2 * 3_600_000L + 14 * 60_000L + 5_000L,
      turnActive = true,
      turnTitle = Texts.s(R.string.dock_turn_title, 214) + " · March 1976",
      funds = metric(Texts.s(R.string.dock_funds), 1_284_000.0, 41_500.0, " USD", "/profile"),
      actions = DockMetric(Texts.s(R.string.dock_actions), "6 / 10", null, true, "/actions", Texts.s(R.string.dock_actions_spoken_of, "6", "10")),
      corpCash = metric(Texts.s(R.string.dock_corp_cash), 8_420_000.0, -120_000.0, " USD", "/corporation"),
      stateInfluence = metric(Texts.s(R.string.dock_state_influence), 42.0, 1.5, "%", "/profile"),
      nationalInfluence = metric(Texts.s(R.string.dock_national_influence), 17.0, null, "", "/profile"),
      notifications = 3,
      mail = 2,
      updatedAt = now,
      turnNumber = 214,
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
        metric(Texts.s(R.string.dock_funds), it, double(perTurn, "funds"), money, "/profile")
      }
      val actionsNow = double(data, "actions")
      val actionCap = double(data, "actionCap")
      val actions = actionsNow?.let {
        val shown = DockFormat.number(it) + (actionCap?.let { cap -> " / " + DockFormat.number(cap) } ?: "")
        val spoken = if (actionCap != null) Texts.s(R.string.dock_actions_spoken_of, DockFormat.spoken(it), DockFormat.spoken(actionCap))
          else Texts.s(R.string.dock_actions_spoken, DockFormat.spoken(it))
        DockMetric(Texts.s(R.string.dock_actions), shown, null, true, "/actions", spoken)
      }
      val corpMoney = corp?.optString("liquidCurrencyCode")?.takeIf { it.isNotBlank() && it != "null" }?.let { " $it" } ?: ""
      val corpPath = corp?.optLong("sequentialId", -1)?.takeIf { it > 0 }?.let { "/corporation/$it" }
      val corpCash = double(corp, "liquidCapital")?.let {
        metric(Texts.s(R.string.dock_corp_cash), it, double(perTurn, "liquidCapital"), corpMoney, corpPath ?: "/corporation")
      }
      val state = if (imperial) null else double(data, "politicalInfluence")?.let {
        metric(Texts.s(R.string.dock_state_influence), it, double(perTurn, "politicalInfluence"), "%", "/profile")
      }
      val national = if (imperial) null else double(data, "nationalInfluence")?.let {
        metric(Texts.s(R.string.dock_national_influence), it, double(perTurn, "nationalInfluence"), "", "/profile")
      }

      val current = double(turn, "current")?.toLong()
      val title = listOfNotNull(current?.let { Texts.s(R.string.dock_turn_title, it.toInt()) }, turn?.optString("date")?.takeIf { it.isNotBlank() && it != "null" })
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
        turnNumber = current?.takeIf { it in 1..99_999 }?.toInt(),
      )
    }

    private fun metric(label: String, value: Double, change: Double?, suffix: String, path: String): DockMetric {
      val shownChange = change?.takeIf { it.isFinite() && abs(it) >= 0.005 }
      val money = suffix.startsWith(" ")
      val unit = if (money) " " + suffix.trim() else suffix
      val spokenUnit = if (money) " " + suffix.trim() else if (suffix == "%") " " + Texts.s(R.string.dock_percent_word) else ""
      val base = Texts.s(R.string.dock_spoken_value, label, DockFormat.spoken(value), spokenUnit)
      val spoken = if (shownChange == null) base
        else Texts.s(if (shownChange > 0) R.string.dock_spoken_up else R.string.dock_spoken_down, base, DockFormat.spoken(abs(shownChange)), spokenUnit)
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
    if (!value.isFinite()) return Texts.s(R.string.dock_na)
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
    if (!value.isFinite()) return Texts.s(R.string.dock_unknown)
    val magnitude = abs(value)
    return when {
      magnitude >= 1e9 -> format("#,##0.#", value / 1e9) + " " + Texts.s(R.string.dock_billion)
      magnitude >= 1e6 -> format("#,##0.#", value / 1e6) + " " + Texts.s(R.string.dock_million)
      magnitude >= 1e4 -> format("#,##0.#", value / 1e3) + " " + Texts.s(R.string.dock_thousand)
      magnitude < 10 -> format("#,##0.##", value)
      else -> format("#,##0.#", value)
    }
  }

  private fun format(pattern: String, value: Double): String =
    DecimalFormat(pattern, DecimalFormatSymbols(Texts.locale())).format(value)

  /**
   * The strip's countdown, one compact token like the iOS dock: "2:14:05", "14:05",
   * "3d 4h", "Due now" once it has passed, "Paused" when turns are stopped, and
   * an empty string when there is no turn time to show.
   */
  fun clock(remainingMs: Long?, active: Boolean): String {
    if (!active) return Texts.s(R.string.dock_paused)
    if (remainingMs == null) return ""
    val total = remainingMs / 1000
    if (total <= 0) return Texts.s(R.string.dock_due_now)
    val days = total / 86_400
    val hours = total / 3_600
    val minutes = (total % 3_600) / 60
    val seconds = total % 60
    return when {
      days > 0 -> Texts.s(R.string.fmt_dh, days.toInt(), (hours % 24).toInt())
      hours > 0 -> "$hours:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}"
      else -> "$minutes:${seconds.toString().padStart(2, '0')}"
    }
  }

  /** Live countdown for the status sheet: "2h 14m", "14m 05s", "45s". */
  fun countdown(remainingMs: Long): String {
    val total = (remainingMs / 1000).coerceAtLeast(0)
    val days = total / 86_400
    val hours = (total % 86_400) / 3_600
    val minutes = (total % 3_600) / 60
    val seconds = total % 60
    return when {
      days > 0 -> Texts.s(R.string.fmt_dh, days.toInt(), hours.toInt())
      hours > 0 -> Texts.s(R.string.fmt_hm, hours.toInt(), minutes.toInt())
      minutes > 0 -> Texts.s(R.string.fmt_ms, minutes.toInt(), seconds.toString().padStart(2, '0'))
      else -> Texts.s(R.string.fmt_s, seconds.toInt())
    }
  }

  /** The countdown in words for screen readers, coarse enough not to chatter. */
  fun spokenCountdown(remainingMs: Long): String {
    val total = (remainingMs / 1000).coerceAtLeast(0)
    val days = total / 86_400
    val hours = (total % 86_400) / 3_600
    val minutes = (total % 3_600) / 60
    fun unit(id: Int, count: Long) = Texts.n(id, count.toInt(), count.toInt())
    return when {
      days > 0 -> unit(R.plurals.spoken_days, days) + " " + unit(R.plurals.spoken_hours, hours)
      hours > 0 -> unit(R.plurals.spoken_hours, hours) + " " + unit(R.plurals.spoken_minutes, minutes)
      minutes > 0 -> unit(R.plurals.spoken_minutes, minutes)
      else -> Texts.s(R.string.spoken_less_than_minute)
    }
  }
}
