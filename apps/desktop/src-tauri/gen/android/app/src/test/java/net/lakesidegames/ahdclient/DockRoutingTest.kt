package net.lakesidegames.ahdclient

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DockRoutingTest {
  @Test fun signInAndOutPagesAreAuthPages() {
    for (path in listOf("/login", "/login/", "/register", "/logout", "/login?next=/actions", "/Logout", "/login/discord")) {
      assertTrue(path, DockRouting.isAuthPath(path))
    }
    for (path in listOf("/", "/loginhelp", "/profile", "/country/us/login", "/api/auth/discord/callback", null)) {
      assertFalse(path.toString(), DockRouting.isAuthPath(path))
    }
  }

  @Test fun theNationFollowsCountryPages() {
    assertEquals("UK", DockRouting.countryOf("/country/uk"))
    assertEquals("UK", DockRouting.countryOf("/country/uk/budget"))
    assertEquals("US", DockRouting.countryOf("/country/us/region/NY/legislature"))
    assertNull(DockRouting.countryOf("/countries"))
    assertNull(DockRouting.countryOf("/country"))
    assertNull(DockRouting.countryOf("/country/"))
    assertNull(DockRouting.countryOf("/actions"))
    assertNull(DockRouting.countryOf("/country/uk%0d"))
    assertNull(DockRouting.countryOf("/country/toolongcode/x"))
    assertNull(DockRouting.countryOf(null))
  }

  @Test fun theLocaleComesFromItsCookieOnly() {
    assertEquals("de", DockRouting.localeFrom("auth-token=abc; ahd-locale=de; other=1"))
    assertEquals("pt-BR", DockRouting.localeFrom("ahd-locale=pt-BR"))
    assertNull(DockRouting.localeFrom("auth-token=abc"))
    assertNull(DockRouting.localeFrom("xahd-locale=de"))
    assertNull(DockRouting.localeFrom("ahd-locale="))
    assertNull(DockRouting.localeFrom("ahd-locale=de\r\nX-Evil: 1"))
    assertNull(DockRouting.localeFrom("ahd-locale=" + "a".repeat(40)))
    assertNull(DockRouting.localeFrom("ahd-locale=d e"))
    assertNull(DockRouting.localeFrom(null))
  }

  @Test fun modelsAreCachedPerLanguageAndCountry() {
    val home = DockKey("id", "en", null)
    assertEquals("en|-", home.sub)
    assertEquals("en|UK", DockKey("id", "en", "UK").sub)
    assertEquals("-|-", DockKey("id", null, null).sub)
    assertEquals("de|-", DockKey("id", "de", null).sub)
    assertTrue(home.sub != DockKey("id", "de", null).sub)
    assertEquals(DockKey.sub("en", "UK"), DockKey("other", "en", "UK").sub)
  }

  @Test fun theStripBelongsToLiveGamePagesOnly() {
    assertTrue(DockRouting.stripAllowed(onGamePage = true, signedIn = true, authPage = false, sandbox = false))
    // The launcher and Briefing are not game pages.
    assertFalse(DockRouting.stripAllowed(onGamePage = false, signedIn = true, authPage = false, sandbox = false))
    assertFalse(DockRouting.stripAllowed(onGamePage = true, signedIn = false, authPage = false, sandbox = false))
    assertFalse(DockRouting.stripAllowed(onGamePage = true, signedIn = true, authPage = true, sandbox = false))
    assertFalse(DockRouting.stripAllowed(onGamePage = true, signedIn = true, authPage = false, sandbox = true))
  }
}
