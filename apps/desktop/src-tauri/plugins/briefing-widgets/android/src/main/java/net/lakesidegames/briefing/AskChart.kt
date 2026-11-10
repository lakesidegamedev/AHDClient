package net.lakesidegames.briefing

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import java.util.Locale

/** A chart Ask drew as Mermaid: a pie, or bars and lines over labels. */
internal data class AskChartSpec(
  val kind: Kind,
  val title: String,
  val labels: List<String>,
  val series: List<List<Double>>,
  val yLabel: String
) {
  enum class Kind { BAR, LINE, PIE }
}

/**
 * Reads the two Mermaid forms the Ask service writes for live data
 * (`pie showData` and `xychart-beta`). Anything else stays a code block.
 */
internal object AskChartParser {
  private val quoted = Regex("\"((?:[^\"\\\\]|\\\\.)*)\"")

  fun parse(source: String): AskChartSpec? = NativeSafety.get("Ask chart parse", null as AskChartSpec?) {
    val lines = source.lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("%%") }
    val first = lines.firstOrNull() ?: return@get null
    when {
      first.startsWith("pie") -> pie(first, lines.drop(1))
      first.startsWith("xychart") -> xy(lines.drop(1))
      else -> null
    }
  }

  private fun pie(header: String, rows: List<String>): AskChartSpec? {
    var title = quoted.find(header.substringAfter("title", ""))?.groupValues?.get(1)
      ?: header.substringAfter("title", "").trim()
    val labels = mutableListOf<String>()
    val values = mutableListOf<Double>()
    for (row in rows) {
      if (row.startsWith("title")) { title = quoted.find(row)?.groupValues?.get(1) ?: row.removePrefix("title").trim(); continue }
      val label = quoted.find(row)?.groupValues?.get(1) ?: continue
      val value = row.substringAfterLast(':').trim().toDoubleOrNull() ?: continue
      if (value < 0) continue
      labels += label
      values += value
    }
    if (labels.isEmpty() || values.sum() <= 0) return null
    return AskChartSpec(AskChartSpec.Kind.PIE, title, labels, listOf(values), "")
  }

  private fun xy(rows: List<String>): AskChartSpec? {
    var title = ""
    var labels = emptyList<String>()
    var yLabel = ""
    var kind = AskChartSpec.Kind.BAR
    val series = mutableListOf<List<Double>>()
    for (row in rows) {
      when {
        row.startsWith("title") -> title = quoted.find(row)?.groupValues?.get(1) ?: row.removePrefix("title").trim()
        row.startsWith("x-axis") -> {
          val inside = row.substringAfter('[', "").substringBeforeLast(']', "")
          labels = quoted.findAll(inside).map { it.groupValues[1] }.toList()
            .ifEmpty { inside.split(',').map { it.trim() }.filter { it.isNotEmpty() } }
        }
        row.startsWith("y-axis") -> yLabel = quoted.find(row)?.groupValues?.get(1).orEmpty()
        row.startsWith("bar") || row.startsWith("line") -> {
          if (row.startsWith("line") && series.isEmpty()) kind = AskChartSpec.Kind.LINE
          val values = row.substringAfter('[', "").substringBeforeLast(']', "").split(',')
            .mapNotNull { it.trim().toDoubleOrNull() }
          if (values.isNotEmpty()) series += values
        }
      }
    }
    if (labels.isEmpty() || series.isEmpty()) return null
    val trimmed = series.map { it.take(labels.size) }.filter { it.size == labels.size }
    if (trimmed.isEmpty()) return null
    return AskChartSpec(kind, title, labels, trimmed, yLabel)
  }
}

/** A titled card holding the chart, with a spoken summary for TalkBack. */
internal object AskChartCard {
  fun build(ui: AskUi, spec: AskChartSpec): View {
    val card = ui.vertical().apply {
      background = ui.rounded(ui.containerLow, 16f, ui.outlineVariant)
      setPadding(ui.dp(16), ui.dp(14), ui.dp(16), ui.dp(14))
    }
    if (spec.title.isNotBlank()) card.addView(ui.text(spec.title, AskUi.Type.TITLE_SMALL, ui.onSurface), ui.matchWrap(bottom = 2))
    if (spec.yLabel.isNotBlank()) card.addView(ui.text(spec.yLabel, AskUi.Type.LABEL_MEDIUM, ui.onSurfaceVariant), ui.matchWrap())
    val chart = AskChartView(ui, spec)
    card.addView(chart, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
      topMargin = ui.dp(12)
    })
    card.contentDescription = describe(spec)
    card.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
    chart.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    return card
  }

  private fun describe(spec: AskChartSpec): String {
    val kind = when (spec.kind) {
      AskChartSpec.Kind.PIE -> T.s(R.string.ask_chart_pie)
      AskChartSpec.Kind.LINE -> T.s(R.string.ask_chart_line)
      AskChartSpec.Kind.BAR -> T.s(R.string.ask_chart_bar)
    }
    val values = spec.labels.mapIndexed { index, label ->
      "$label ${spec.series.joinToString(T.s(R.string.ask_chart_and)) { AskChartView.format(it[index]) }}"
    }
    return "$kind${if (spec.title.isNotBlank()) ", ${spec.title}" else ""}: ${values.joinToString(", ")}"
  }
}

/**
 * Draws charts natively so they match the sheet's type and colors. Bars run
 * horizontally: long labels stay readable on a narrow phone.
 */
internal class AskChartView(private val ui: AskUi, private val spec: AskChartSpec) : View(ui.context) {
  private val palette: List<Int> = listOf(ui.accent, 0xFF2F6FB3.toInt(), 0xFFE0A030.toInt(), 0xFF3F9C6B.toInt(),
    0xFF7A5AA6.toInt(), 0xFFD2691E.toInt(), 0xFF5B7083.toInt(), 0xFFB5487A.toInt(), 0xFF2E8B8B.toInt(),
    0xFF8C8C3A.toInt(), 0xFFA0522D.toInt(), 0xFF4F6D7A.toInt())
  private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ui.onSurfaceVariant; textSize = sp(12f) }
  private val value = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ui.onSurface; textSize = sp(12f); isFakeBoldText = true }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ui.withAlpha(ui.onSurface, 0.06f) }
  private val grid = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ui.outlineVariant; strokeWidth = ui.dpf(1f) }
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = ui.dpf(2.5f); strokeJoin = Paint.Join.ROUND; strokeCap = Paint.Cap.ROUND }
  private val rect = RectF()

  private fun sp(value: Float): Float =
    android.util.TypedValue.applyDimension(android.util.TypedValue.COMPLEX_UNIT_SP, value, context.resources.displayMetrics)

  private val rowHeight: Float get() = ui.dpf(if (spec.series.size > 1) 10f * spec.series.size + 22f else 30f)

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val width = MeasureSpec.getSize(widthMeasureSpec)
    val height = when (spec.kind) {
      AskChartSpec.Kind.BAR -> (rowHeight * spec.labels.size).toInt() + legendHeight()
      AskChartSpec.Kind.LINE -> ui.dp(180) + legendHeight()
      AskChartSpec.Kind.PIE -> ui.dp(150) + ui.dp(16) + (spec.labels.size * ui.dpf(24f)).toInt()
    }
    setMeasuredDimension(width, height)
  }

  private fun legendHeight(): Int = if (spec.series.size > 1 && spec.kind != AskChartSpec.Kind.PIE) ui.dp(24) else 0

  override fun onDraw(canvas: Canvas) {
    NativeSafety.run("Ask chart draw") {
      when (spec.kind) {
        AskChartSpec.Kind.BAR -> bars(canvas)
        AskChartSpec.Kind.LINE -> lines(canvas)
        AskChartSpec.Kind.PIE -> pie(canvas)
      }
    }
  }

  private fun bars(canvas: Canvas) {
    val all = spec.series.flatten()
    val max = Math.max(all.maxOrNull() ?: 0.0, 0.0)
    val min = Math.min(all.minOrNull() ?: 0.0, 0.0)
    val span = if (max - min <= 0) 1.0 else max - min
    val labelWidth = Math.min(width * 0.38f, spec.labels.maxOf { label.measureText(it) } + ui.dpf(4f))
    val valueWidth = spec.series.flatten().maxOf { value.measureText(format(it)) } + ui.dpf(8f)
    val left = labelWidth + ui.dpf(10f)
    val right = width - valueWidth
    val plot = Math.max(right - left, ui.dpf(40f))
    val zero = left + (plot * (-min / span)).toFloat()
    spec.labels.forEachIndexed { row, name ->
      val top = row * rowHeight
      val text = ellipsize(name, labelWidth)
      val centre = top + rowHeight / 2f
      canvas.drawText(text, 0f, centre + label.textSize / 3f, label)
      val barHeight = if (spec.series.size > 1) ui.dpf(8f) else ui.dpf(14f)
      val stackHeight = barHeight * spec.series.size + ui.dpf(2f) * (spec.series.size - 1)
      var y = centre - stackHeight / 2f
      spec.series.forEachIndexed { index, values ->
        val number = values[row]
        val end = left + (plot * ((number - min) / span)).toFloat()
        rect.set(left, y, left + plot, y + barHeight)
        canvas.drawRoundRect(rect, barHeight / 2f, barHeight / 2f, track)
        rect.set(Math.min(zero, end), y, Math.max(zero, end).coerceAtLeast(Math.min(zero, end) + ui.dpf(2f)), y + barHeight)
        fill.color = if (number < 0) ui.withAlpha(palette[index % palette.size], 0.55f) else palette[index % palette.size]
        canvas.drawRoundRect(rect, barHeight / 2f, barHeight / 2f, fill)
        if (spec.series.size == 1 || index == spec.series.size - 1) {
          canvas.drawText(format(number), left + plot + ui.dpf(8f), centre + value.textSize / 3f, value)
        }
        y += barHeight + ui.dpf(2f)
      }
    }
    if (min < 0) canvas.drawLine(zero, 0f, zero, rowHeight * spec.labels.size, grid)
    legend(canvas, rowHeight * spec.labels.size)
  }

  private fun lines(canvas: Canvas) {
    val all = spec.series.flatten()
    val max = all.maxOrNull() ?: 0.0
    val min = Math.min(all.minOrNull() ?: 0.0, 0.0)
    val span = if (max - min <= 0) 1.0 else max - min
    val axisWidth = listOf(max, (max + min) / 2, min).maxOf { label.measureText(format(it)) } + ui.dpf(8f)
    val top = ui.dpf(8f)
    val bottom = ui.dpf(150f)
    val left = axisWidth
    val right = width - ui.dpf(8f)
    for (step in 0..2) {
      val y = bottom - (bottom - top) * step / 2f
      canvas.drawLine(left, y, right, y, grid)
      canvas.drawText(format(min + span * step / 2), 0f, y + label.textSize / 3f, label)
    }
    val count = spec.labels.size
    fun x(index: Int) = if (count <= 1) (left + right) / 2f else left + (right - left) * index / (count - 1f)
    spec.series.forEachIndexed { index, values ->
      val color = palette[index % palette.size]
      val path = Path()
      values.forEachIndexed { point, number ->
        val y = bottom - ((number - min) / span * (bottom - top)).toFloat()
        if (point == 0) path.moveTo(x(point), y) else path.lineTo(x(point), y)
      }
      if (spec.series.size == 1 && count > 1) {
        val area = Path(path).apply { lineTo(x(count - 1), bottom); lineTo(x(0), bottom); close() }
        fill.color = ui.withAlpha(color, 0.14f)
        canvas.drawPath(area, fill)
      }
      stroke.color = color
      canvas.drawPath(path, stroke)
      fill.color = color
      values.forEachIndexed { point, number ->
        val y = bottom - ((number - min) / span * (bottom - top)).toFloat()
        canvas.drawCircle(x(point), y, ui.dpf(3.5f), fill)
      }
    }
    // First, middle and last labels: enough to read the axis without overlap.
    val picks = listOf(0, count / 2, count - 1).distinct()
    picks.forEach { index ->
      val text = ellipsize(spec.labels[index], (right - left) / 3.2f)
      val widthText = label.measureText(text)
      val cx = x(index)
      val start = (cx - widthText / 2f).coerceIn(left - ui.dpf(4f), right - widthText)
      canvas.drawText(text, start, bottom + ui.dpf(20f), label)
    }
    legend(canvas, ui.dpf(180f))
  }

  private fun pie(canvas: Canvas) {
    val values = spec.series.first()
    val total = values.sum()
    val size = ui.dpf(150f)
    val cx = width / 2f
    rect.set(cx - size / 2f, 0f, cx + size / 2f, size)
    var angle = -90f
    val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = ui.dpf(26f) }
    val inset = ring.strokeWidth / 2f
    val arc = RectF(rect.left + inset, rect.top + inset, rect.right - inset, rect.bottom - inset)
    values.forEachIndexed { index, number ->
      val sweep = (number / total * 360.0).toFloat()
      ring.color = palette[index % palette.size]
      canvas.drawArc(arc, angle, Math.max(0.5f, sweep - if (values.size > 1) 1.2f else 0f), false, ring)
      angle += sweep
    }
    val totalText = format(total)
    val big = Paint(value).apply { textSize = sp(18f) }
    canvas.drawText(totalText, cx - big.measureText(totalText) / 2f, size / 2f + big.textSize / 3f, big)
    var y = size + ui.dpf(16f)
    values.forEachIndexed { index, number ->
      fill.color = palette[index % palette.size]
      rect.set(0f, y + ui.dpf(6f), ui.dpf(12f), y + ui.dpf(18f))
      canvas.drawRoundRect(rect, ui.dpf(3f), ui.dpf(3f), fill)
      val share = String.format(Locale.US, "%.0f%%", number / total * 100)
      val right = "${format(number)}  $share"
      val rightWidth = value.measureText(right)
      canvas.drawText(ellipsize(spec.labels[index], width - rightWidth - ui.dpf(32f)), ui.dpf(20f), y + ui.dpf(17f), label)
      canvas.drawText(right, width - rightWidth, y + ui.dpf(17f), value)
      y += ui.dpf(24f)
    }
  }

  private fun legend(canvas: Canvas, top: Float) {
    if (spec.series.size <= 1) return
    var x = 0f
    spec.series.indices.forEach { index ->
      fill.color = palette[index % palette.size]
      rect.set(x, top + ui.dpf(8f), x + ui.dpf(12f), top + ui.dpf(20f))
      canvas.drawRoundRect(rect, ui.dpf(3f), ui.dpf(3f), fill)
      val name = T.s(R.string.ask_chart_series, index + 1)
      canvas.drawText(name, x + ui.dpf(16f), top + ui.dpf(19f), label)
      x += ui.dpf(28f) + label.measureText(name)
    }
  }

  private fun ellipsize(text: String, max: Float): String {
    if (label.measureText(text) <= max) return text
    var end = text.length
    while (end > 1 && label.measureText(text.substring(0, end) + "…") > max) end--
    return text.substring(0, end).trimEnd() + "…"
  }

  companion object {
    fun format(number: Double): String {
      val abs = Math.abs(number)
      return when {
        abs >= 1e12 -> String.format(Locale.US, "%.1fT", number / 1e12)
        abs >= 1e9 -> String.format(Locale.US, "%.1fB", number / 1e9)
        abs >= 1e6 -> String.format(Locale.US, "%.1fM", number / 1e6)
        abs >= 1e4 -> String.format(Locale.US, "%,.0f", number)
        number == Math.floor(number) -> String.format(Locale.US, "%,.0f", number)
        abs >= 100 -> String.format(Locale.US, "%,.0f", number)
        else -> String.format(Locale.US, "%.1f", number)
      }.replace(".0T", "T").replace(".0B", "B").replace(".0M", "M")
    }
  }
}

