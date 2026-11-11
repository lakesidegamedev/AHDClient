package net.lakesidegames.ahdclient

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLinksTest {
  private fun p(path: String?, query: String? = null, host: String = "ahousedividedgame.com", scheme: String = "https") =
    AppLinks.pathFor(scheme, host, path, query)

  @Test fun gamePagesOpenInApp() {
    assertEquals("/profile", p("/profile"))
    assertEquals("/elections/123?tab=1", p("/elections/123", "tab=1"))
    assertEquals("/state/NY", p("/state/NY", host = "www.ahousedividedgame.com"))
  }

  @Test fun authApiAndAdminNeverOpenInApp() {
    for (path in listOf("/login", "/register", "/logout", "/api/auth/discord/callback", "/api/x", "/auth/x",
      "/admin", "/forgot-password", "/reset-password", "/confirm-email", "/")) assertNull(path, p(path))
  }

  @Test fun lookalikesAndOtherHostsAreIgnored() {
    assertNull(p("/statement"))
    assertNull(p("/profile", host = "sandbox.ahousedividedgame.com"))
    assertNull(p("/profile", host = "evil.example"))
    assertNull(p("/profile", scheme = "http"))
    assertNull(p(null))
    assertNull(p("//evil.example/profile"))
  }

  @Test fun everySectionIsAllowedAndNoneIsAuth() {
    assertTrue(AppLinks.SECTIONS.none { it in setOf("api", "login", "auth", "register", "logout") })
    AppLinks.SECTIONS.forEach { assertEquals("/$it", p("/$it")) }
  }
}
