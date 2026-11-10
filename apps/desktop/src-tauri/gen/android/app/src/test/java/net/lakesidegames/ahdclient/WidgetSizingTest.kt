package net.lakesidegames.ahdclient

import org.junit.Assert.assertEquals
import org.junit.Test

class WidgetSizingTest {
  @Test fun smallestWidgetShowsOnlyTheMainFigure() {
    assertEquals(WidgetSizing.Tier.MINI, WidgetSizing.tier(110))
    assertEquals(WidgetSizing.Tier.MINI, WidgetSizing.tier(159))
  }

  @Test fun mediumWidgetKeepsTheCompactLayout() {
    assertEquals(WidgetSizing.Tier.COMPACT, WidgetSizing.tier(160))
    assertEquals(WidgetSizing.Tier.COMPACT, WidgetSizing.tier(249))
  }

  @Test fun tallWidgetShowsEverything() {
    assertEquals(WidgetSizing.Tier.FULL, WidgetSizing.tier(250))
    assertEquals(WidgetSizing.Tier.FULL, WidgetSizing.tier(400))
  }
}
