package net.lakesidegames.ahdclient

/** How much a home-screen widget can show, from the height the launcher reports. */
object WidgetSizing {
  enum class Tier { FULL, COMPACT, MINI }

  /** Under 160 dp (a 3 by 2 widget) only the header and the main figure fit. */
  fun tier(heightDp: Int): Tier = when {
    heightDp < 160 -> Tier.MINI
    heightDp < 250 -> Tier.COMPACT
    else -> Tier.FULL
  }
}
