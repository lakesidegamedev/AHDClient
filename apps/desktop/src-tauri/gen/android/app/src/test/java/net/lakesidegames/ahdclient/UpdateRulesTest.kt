package net.lakesidegames.ahdclient

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateRulesTest {
  private val page = "https://ops.lakesidegames.net/downloads/"
  private fun body(code: Any = 2011000, name: String = "2.11.0", url: String = page) =
    """{"versionCode":$code,"versionName":"$name","pageUrl":"$url"}"""

  @Test fun readsAGoodManifest() {
    val release = UpdateRules.parse(body())!!
    assertEquals(2011000L, release.versionCode)
    assertEquals("2.11.0", release.versionName)
    assertEquals(page, release.pageUrl)
  }

  @Test fun rejectsBrokenOrUnsafeManifests() {
    for (bad in listOf(
      null, "", "not json", "{}", body(code = 0), body(code = -3), body(name = ""), body(name = "x".repeat(40)),
      body(url = "http://ops.lakesidegames.net/downloads/"), body(url = "https://evil.example/downloads/"),
      body(url = "https://ops.lakesidegames.net.evil.example/"), body(url = "https://user@ops.lakesidegames.net/"),
      body(url = "https://ops.lakesidegames.net:8443/"), body(url = "javascript:alert(1)"), body(url = ""),
      "x".repeat(5000),
    )) assertNull(bad.toString(), UpdateRules.parse(bad))
  }

  @Test fun comparesVersionCodes() {
    val release = UpdateRules.parse(body())!!
    assertTrue(UpdateRules.isNewer(2010000, release))
    assertFalse(UpdateRules.isNewer(2011000, release))
    assertFalse(UpdateRules.isNewer(2012000, release))
    assertFalse(UpdateRules.isNewer(1, null))
  }

  @Test fun playInstallsAreLeftToPlay() {
    assertFalse(UpdateRules.directInstall("com.android.vending"))
    assertTrue(UpdateRules.directInstall(null))
    assertTrue(UpdateRules.directInstall("com.google.android.packageinstaller"))
    assertTrue(UpdateRules.directInstall("com.android.shell"))
  }

  @Test fun checksAtMostOnceADay() {
    val day = UpdateRules.CHECK_INTERVAL_MS
    assertTrue(UpdateRules.due(1000, 0))
    assertFalse(UpdateRules.due(day - 1 + 5, 5))
    assertTrue(UpdateRules.due(day + 5, 5))
    // A clock that went backwards must not stop checks for good.
    assertTrue(UpdateRules.due(5, 1000))
  }

  @Test fun bannerShowsOncePerVersion() {
    val release = UpdateRules.parse(body())!!
    assertTrue(UpdateRules.shouldBanner(true, 0, release))
    assertFalse(UpdateRules.shouldBanner(true, release.versionCode, release))
    assertFalse(UpdateRules.shouldBanner(false, 0, release))
    assertFalse(UpdateRules.shouldBanner(true, 0, null))
    val later = UpdateRules.parse(body(code = 2012000, name = "2.12.0"))!!
    assertTrue(UpdateRules.shouldBanner(true, release.versionCode, later))
    assertNotNull(later)
  }
}
