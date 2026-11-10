package net.lakesidegames.briefing

import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextPaint
import android.text.method.LinkMovementMethod
import android.text.style.BackgroundColorSpan
import android.text.style.ClickableSpan
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TableLayout
import android.widget.TableRow
import android.widget.TextView

/** One parsed piece of an answer. */
internal sealed class AskBlock {
  data class Heading(val level: Int, val text: String) : AskBlock()
  data class Paragraph(val text: String) : AskBlock()
  data class ListItem(val depth: Int, val marker: String, val text: String)
  data class Items(val items: List<ListItem>) : AskBlock()
  data class Quote(val text: String) : AskBlock()
  data class Code(val language: String, val code: String, val closed: Boolean) : AskBlock()
  data class Table(val head: List<String>, val rows: List<List<String>>, val right: List<Boolean>) : AskBlock()
  object Rule : AskBlock()
}

/**
 * Markdown for Ask answers: headings, emphasis, lists, quotes, code, tables,
 * links, maps and charts. The same subset the Ask site and the desktop panel
 * render, parsed by line so a half-streamed answer still lays out cleanly.
 */
internal object AskMarkdownParser {
  private val heading = Regex("^\\s{0,3}(#{1,6})\\s+(.+?)\\s*#*\\s*$")
  private val rule = Regex("^\\s{0,3}(?:-\\s*){3,}$|^\\s{0,3}(?:\\*\\s*){3,}$|^\\s{0,3}(?:_\\s*){3,}$")
  private val item = Regex("^(\\s*)([-*+\\u2022]|\\d{1,3}[.)])\\s+(.*)$")
  private val tableDivider = Regex("^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?\\s*$")
  private val fence = Regex("^\\s{0,3}```\\s*([A-Za-z0-9_+-]*).*$")

  fun parse(text: String): List<AskBlock> {
    val lines = text.replace("\r\n", "\n").split('\n')
    val blocks = mutableListOf<AskBlock>()
    var index = 0
    while (index < lines.size) {
      val line = lines[index]
      if (line.isBlank()) { index++; continue }
      val fenceMatch = fence.matchEntire(line)
      if (fenceMatch != null) {
        val language = fenceMatch.groupValues[1].lowercase()
        val code = StringBuilder()
        index++
        var closed = false
        while (index < lines.size) {
          if (lines[index].trimStart().startsWith("```")) { closed = true; index++; break }
          if (code.isNotEmpty()) code.append('\n')
          code.append(lines[index])
          index++
        }
        blocks += AskBlock.Code(language, code.toString(), closed)
        continue
      }
      val headingMatch = heading.matchEntire(line)
      if (headingMatch != null) {
        blocks += AskBlock.Heading(headingMatch.groupValues[1].length, headingMatch.groupValues[2])
        index++
        continue
      }
      if (rule.matches(line)) { blocks += AskBlock.Rule; index++; continue }
      if (line.contains('|') && index + 1 < lines.size && tableDivider.matches(lines[index + 1])) {
        val head = cells(line)
        val right = cells(lines[index + 1]).map { it.trim().endsWith(":") && !it.trim().startsWith(":") }
        index += 2
        val rows = mutableListOf<List<String>>()
        while (index < lines.size && lines[index].contains('|') && lines[index].isNotBlank()) {
          rows += cells(lines[index])
          index++
        }
        blocks += AskBlock.Table(head, rows, right)
        continue
      }
      if (line.trimStart().startsWith(">")) {
        val quote = mutableListOf<String>()
        while (index < lines.size && lines[index].trimStart().startsWith(">")) {
          quote += lines[index].trimStart().removePrefix(">").removePrefix(" ")
          index++
        }
        blocks += AskBlock.Quote(quote.joinToString("\n"))
        continue
      }
      if (item.matches(line)) {
        val items = mutableListOf<AskBlock.ListItem>()
        val indents = mutableListOf<Int>()
        while (index < lines.size) {
          val current = lines[index]
          val match = item.matchEntire(current)
          if (match != null) {
            val indent = match.groupValues[1].replace("\t", "    ").length
            while (indents.isNotEmpty() && indent < indents.last()) indents.removeAt(indents.size - 1)
            if (indents.isEmpty() || indent > indents.last()) indents += indent
            val marker = match.groupValues[2].let { if (it[0].isDigit()) it.dropLast(1) + "." else "•" }
            items += AskBlock.ListItem(Math.min(indents.size - 1, 3), marker, match.groupValues[3])
            index++
          } else if (current.isNotBlank() && current.startsWith(" ") && items.isNotEmpty() && !startsBlock(current)) {
            val last = items.removeAt(items.size - 1)
            items += last.copy(text = last.text + " " + current.trim())
            index++
          } else if (current.isBlank() && index + 1 < lines.size && item.matches(lines[index + 1])) {
            index++
          } else break
        }
        blocks += AskBlock.Items(items)
        continue
      }
      val paragraph = mutableListOf<String>()
      while (index < lines.size && lines[index].isNotBlank() && (paragraph.isEmpty() || !startsBlock(lines[index]))) {
        paragraph += lines[index].trimEnd()
        index++
      }
      blocks += AskBlock.Paragraph(paragraph.joinToString("\n"))
    }
    return blocks
  }

  private fun startsBlock(line: String): Boolean =
    fence.matches(line) || heading.matches(line) || rule.matches(line) || line.trimStart().startsWith(">") || item.matches(line)

  fun cells(line: String): List<String> = line.trim().removePrefix("|").removeSuffix("|").split('|').map { it.trim() }
}

/** Turns parsed blocks into native views inside the answer column. */
internal class AskMarkdownRenderer(
  private val ui: AskUi,
  private val onLink: (String) -> Unit,
  private val mapHost: (String, FrameLayout) -> Unit
) {
  private val inline = Regex(
    "(`[^`\\n]+`)|(\\*\\*[^*\\n]+?\\*\\*)|(__[^_\\n]+?__)|(~~[^~\\n]+?~~)|(\\[[^\\]\\n]+\\]\\([^)\\s]+\\))|(https?://[^\\s)<>\\]]+[^\\s)<>\\].,;:!?'\"])|((?<![\\w*])\\*[^*\\n]+?\\*(?![\\w*]))|((?<![\\w_])_[^_\\n]+?_(?![\\w_]))"
  )

  fun render(markdown: String, into: LinearLayout, streaming: Boolean) {
    into.removeAllViews()
    val blocks = AskMarkdownParser.parse(markdown)
    blocks.forEachIndexed { index, block ->
      val view = when (block) {
        is AskBlock.Heading -> heading(block)
        is AskBlock.Paragraph -> paragraph(block.text)
        is AskBlock.Items -> items(block)
        is AskBlock.Quote -> quote(block.text)
        is AskBlock.Code -> code(block, streaming && index == blocks.lastIndex)
        is AskBlock.Table -> table(block)
        AskBlock.Rule -> View(ui.context).apply {
          setBackgroundColor(ui.outlineVariant)
          layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ui.dp(1))
        }
      }
      val params = (view.layoutParams as? LinearLayout.LayoutParams) ?: ui.matchWrap()
      params.topMargin = if (index == 0) 0 else when (block) {
        is AskBlock.Heading -> ui.dp(if (block.level <= 2) 20 else 16)
        AskBlock.Rule -> ui.dp(16)
        else -> ui.dp(12)
      }
      if (block == AskBlock.Rule) params.bottomMargin = ui.dp(4)
      into.addView(view, params)
    }
  }

  private fun body(text: CharSequence, appearance: Int = AskUi.Type.BODY_LARGE, color: Int = ui.onSurface): TextView =
    ui.text(text, appearance, color).apply {
      if (text is Spanned && text.getSpans(0, text.length, ClickableSpan::class.java).isNotEmpty()) {
        movementMethod = LinkMovementMethod.getInstance()
      }
      setLinkTextColor(ui.link)
      highlightColor = ui.withAlpha(ui.link, 0.2f)
    }

  private fun heading(block: AskBlock.Heading): View {
    val appearance = when (block.level) {
      1, 2 -> AskUi.Type.TITLE_LARGE
      3 -> AskUi.Type.TITLE_MEDIUM
      else -> AskUi.Type.TITLE_SMALL
    }
    return body(spans(block.text), appearance).apply {
      androidx.core.view.ViewCompat.setAccessibilityHeading(this, true)
    }
  }

  private fun paragraph(text: String): View = body(spans(text))

  private fun items(block: AskBlock.Items): View {
    val column = ui.vertical()
    var number = 0
    block.items.forEachIndexed { index, item ->
      val row = LinearLayout(ui.context).apply { orientation = LinearLayout.HORIZONTAL }
      val ordered = item.marker != "•"
      if (ordered) number++
      val marker = ui.text(item.marker, AskUi.Type.BODY_LARGE, if (ordered) ui.onSurfaceVariant else ui.primary).apply {
        gravity = Gravity.END
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        if (!ordered) setTypeface(typeface, Typeface.BOLD)
      }
      row.addView(marker, LinearLayout.LayoutParams(ui.dp(if (ordered) 24 else 14), ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        marginEnd = ui.dp(10)
      })
      row.addView(body(spans(item.text)), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      column.addView(row, ui.matchWrap(top = if (index == 0) 0 else 6).apply { marginStart = ui.dp(item.depth * 20) })
    }
    return column
  }

  private fun quote(text: String): View {
    val box = LinearLayout(ui.context).apply {
      orientation = LinearLayout.HORIZONTAL
      background = ui.rounded(ui.containerHigh, 12f)
      clipToOutline = true
    }
    box.addView(View(ui.context).apply { setBackgroundColor(ui.accent) },
      LinearLayout.LayoutParams(ui.dp(4), ViewGroup.LayoutParams.MATCH_PARENT))
    box.addView(body(spans(text), AskUi.Type.BODY_MEDIUM, ui.onSurfaceVariant).apply {
      setPadding(ui.dp(14), ui.dp(12), ui.dp(14), ui.dp(12))
    }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    return box
  }

  private fun code(block: AskBlock.Code, streamingTail: Boolean): View {
    if (block.language == "ahd-map") {
      if (!block.closed) return placeholder(T.s(R.string.ask_drawing_map))
      val frame = FrameLayout(ui.context)
      mapHost(block.code, frame)
      return frame
    }
    if (block.language == "mermaid" || block.language == "mmd") {
      if (!block.closed && streamingTail) return placeholder(T.s(R.string.ask_drawing_chart))
      AskChartParser.parse(block.code)?.let { return AskChartCard.build(ui, it) }
    }
    val scroller = HorizontalScrollView(ui.context).apply {
      background = ui.rounded(ui.containerHighest, 12f)
      isHorizontalScrollBarEnabled = false
    }
    scroller.addView(ui.text(block.code.trimEnd(), AskUi.Type.BODY_MEDIUM, ui.onSurface).apply {
      typeface = Typeface.MONOSPACE
      textSize = 13f
      setPadding(ui.dp(14), ui.dp(12), ui.dp(14), ui.dp(12))
      setTextIsSelectable(true)
    })
    return scroller
  }

  private fun placeholder(label: String): View = LinearLayout(ui.context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    background = ui.rounded(ui.containerHigh, 16f)
    setPadding(ui.dp(16), ui.dp(16), ui.dp(16), ui.dp(16))
    addView(com.google.android.material.progressindicator.CircularProgressIndicator(ui.context).apply {
      isIndeterminate = true
      indicatorSize = ui.dp(18)
      trackThickness = ui.dp(2)
      setIndicatorColor(ui.primary)
    })
    addView(ui.text(label, AskUi.Type.BODY_MEDIUM, ui.onSurfaceVariant), LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = ui.dp(12) })
  }

  private fun table(block: AskBlock.Table): View {
    val columns = Math.max(block.head.size, block.rows.maxOfOrNull { it.size } ?: 0)
    val numeric = (0 until columns).map { column ->
      block.right.getOrElse(column) { false } || (block.rows.isNotEmpty() && block.rows.all { row ->
        val cell = row.getOrElse(column) { "" }.replace(Regex("[*`$%,+\\s]"), "")
        cell.isEmpty() || cell.matches(Regex("^[-\\u2212]?\\d+(\\.\\d+)?[kKmMbB]?$"))
      })
    }
    val table = TableLayout(ui.context).apply {
      isStretchAllColumns = false
      showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE
    }
    table.dividerDrawable = android.graphics.drawable.GradientDrawable().apply {
      setColor(ui.outlineVariant); setSize(1, ui.dp(1))
    }
    fun row(cells: List<String>, header: Boolean): TableRow {
      val row = TableRow(ui.context)
      if (header) row.setBackgroundColor(ui.containerHigh)
      for (column in 0 until columns) {
        val raw = cells.getOrElse(column) { "" }
        val cell = body(spans(if (header) raw else formatCell(raw)),
          if (header) AskUi.Type.LABEL_LARGE else AskUi.Type.BODY_MEDIUM,
          if (header) ui.onSurface else ui.onSurface).apply {
          setPadding(ui.dp(12), ui.dp(10), ui.dp(12), ui.dp(10))
          maxWidth = ui.dp(220)
          minWidth = ui.dp(56)
          gravity = if (numeric[column] && !(header && column == 0)) Gravity.END else Gravity.START
        }
        row.addView(cell)
      }
      return row
    }
    table.addView(row(block.head, header = true))
    block.rows.forEach { table.addView(row(it, header = false)) }
    val scroller = HorizontalScrollView(ui.context).apply {
      background = ui.rounded(ui.surface, 12f, ui.outlineVariant)
      clipToOutline = true
      isHorizontalScrollBarEnabled = false
      isFillViewport = true
      setPadding(ui.dp(1), ui.dp(1), ui.dp(1), ui.dp(1))
    }
    scroller.addView(table, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    return scroller
  }

  /** Same shaping as the desktop panel: digit grouping and up/down arrows on signed changes. */
  private fun formatCell(cell: String): String {
    val text = cell.trim()
    if (Regex("^[+-]?\\d{7,}$").matches(text)) return text.reversed().chunked(3).joinToString(",").reversed().replace("-,", "-").replace("+,", "+")
    val signed = Regex("^([+-])\\d[\\d.,]*%").find(text)
    if (signed != null) return (if (signed.groupValues[1] == "+") "▲ " else "▼ ") + text
    return cell
  }

  /** Inline markdown to styled text. Code first so its contents stay literal. */
  fun spans(text: String): CharSequence {
    val out = SpannableStringBuilder()
    appendInline(out, text, 0)
    return out
  }

  private fun appendInline(out: SpannableStringBuilder, text: String, depth: Int) {
    var cursor = 0
    for (match in inline.findAll(text)) {
      if (match.range.first > cursor) out.append(text.substring(cursor, match.range.first))
      val token = match.value
      val start = out.length
      when {
        match.groups[1] != null -> {
          out.append(token.substring(1, token.length - 1))
          out.setSpan(TypefaceSpan("monospace"), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
          out.setSpan(BackgroundColorSpan(ui.containerHighest), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
          out.setSpan(RelativeSizeSpan(0.92f), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        match.groups[2] != null || match.groups[3] != null -> {
          nested(out, token.substring(2, token.length - 2), depth)
          out.setSpan(StyleSpan(Typeface.BOLD), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        match.groups[4] != null -> {
          nested(out, token.substring(2, token.length - 2), depth)
          out.setSpan(StrikethroughSpan(), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        match.groups[5] != null -> {
          val label = token.substring(1, token.indexOf("]("))
          val target = token.substring(token.indexOf("](") + 2, token.length - 1)
          nested(out, label, depth)
          link(out, start, target)
        }
        match.groups[6] != null -> {
          out.append(token)
          link(out, start, token)
        }
        else -> {
          nested(out, token.substring(1, token.length - 1), depth)
          out.setSpan(StyleSpan(Typeface.ITALIC), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
      }
      cursor = match.range.last + 1
    }
    if (cursor < text.length) out.append(text.substring(cursor))
  }

  private fun nested(out: SpannableStringBuilder, text: String, depth: Int) {
    if (depth < 3) appendInline(out, text, depth + 1) else out.append(text)
  }

  private fun link(out: SpannableStringBuilder, start: Int, target: String) {
    val resolved = when {
      target.startsWith("https://") || target.startsWith("http://") -> target
      target.startsWith("/") && !target.startsWith("//") -> target
      else -> null
    } ?: return
    val color = ui.link
    out.setSpan(object : ClickableSpan() {
      override fun onClick(widget: View) {
        NativeSafety.run("Ask answer link") { onLink(resolved) }
      }
      override fun updateDrawState(paint: TextPaint) {
        paint.color = color
        paint.isUnderlineText = true
      }
    }, start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    out.setSpan(ForegroundColorSpan(color), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
  }
}
