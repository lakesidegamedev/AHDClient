package net.lakesidegames.ahdclient

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.view.LayoutInflater
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView

/** Design review only: the five widget picker samples, stacked. Debug and CI builds only. */
object WidgetPreviewScreen {
  private val layouts = intArrayOf(
    R.layout.widget_preview_overview, R.layout.widget_preview_profile, R.layout.widget_preview_election,
    R.layout.widget_preview_corporation, R.layout.widget_preview_stocks,
  )
  private var open: Dialog? = null

  fun show(activity: Activity) {
    open?.dismiss()
    val density = activity.resources.displayMetrics.density
    val column = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding((12 * density).toInt(), (24 * density).toInt(), (12 * density).toInt(), (12 * density).toInt()) }
    for (id in layouts) {
      val sample = LayoutInflater.from(activity).inflate(id, column, false)
      column.addView(sample, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (190 * density).toInt()).apply { bottomMargin = (10 * density).toInt() })
    }
    val scroll = ScrollView(activity).apply { setBackgroundColor(Color.parseColor("#33333A")); addView(column) }
    open = Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen).apply { setContentView(scroll); show() }
  }
}
