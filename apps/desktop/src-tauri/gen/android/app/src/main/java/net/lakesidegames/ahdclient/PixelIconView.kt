package net.lakesidegames.ahdclient

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.view.View
import kotlin.math.max
import kotlin.math.min

/**
 * Draws a game pixel icon as crisp square pixels in one tint. The cell size is
 * a whole number of device pixels, so edges stay sharp at every density; the
 * grid is centered in the view. Decorative: screen readers read the label next
 * to it, not the picture.
 */
class PixelIconView(context: Context) : View(context) {
  private val paint = Paint().apply { isAntiAlias = false; style = Paint.Style.FILL }
  private var icon: PixelIcon? = null

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  fun setIcon(next: PixelIcon?) {
    if (next == icon) return
    icon = next
    invalidate()
  }

  fun setTint(color: Int) {
    if (paint.color == color) return
    paint.color = color
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val grid = icon ?: return
    if (grid.width == 0 || grid.height == 0) return
    val cell = max(1, min(width / grid.width, height / grid.height))
    val left = (width - cell * grid.width) / 2
    val top = (height - cell * grid.height) / 2
    for (y in 0 until grid.height) {
      val row = grid.rows[y]
      var x = 0
      while (x < row.length) {
        if (row[x] != '1') { x++; continue }
        // One rectangle per run of filled cells.
        var end = x
        while (end < row.length && row[end] == '1') end++
        canvas.drawRect(
          (left + x * cell).toFloat(), (top + y * cell).toFloat(),
          (left + end * cell).toFloat(), (top + (y + 1) * cell).toFloat(), paint,
        )
        x = end
      }
    }
  }
}
