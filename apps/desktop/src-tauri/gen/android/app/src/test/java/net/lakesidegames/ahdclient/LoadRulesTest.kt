package net.lakesidegames.ahdclient

import android.webkit.WebViewClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LoadRulesTest {
  private val url = "https://ahousedividedgame.com/country/fr"

  @Test fun showsTheScreenForTheGamePageWhenThereIsNoConnection() {
    assertTrue(LoadRules.showsError(true, WebViewClient.ERROR_HOST_LOOKUP, url, url))
    assertTrue(LoadRules.showsError(true, WebViewClient.ERROR_CONNECT, url, url))
    assertTrue(LoadRules.showsError(true, WebViewClient.ERROR_TIMEOUT, url, url))
  }

  @Test fun ignoresImagesAndScriptsThatFailToLoad() {
    assertFalse(LoadRules.showsError(false, WebViewClient.ERROR_HOST_LOOKUP, "https://cdn.example/a.png", url))
  }

  @Test fun leavesTheSignInRedirectCaseToTheAppsOwnClient() {
    // A refused connection to an address the client never served is the OAuth redirect it retries itself.
    assertFalse(LoadRules.showsError(true, WebViewClient.ERROR_CONNECT, "custom://callback", url))
  }

  @Test fun ignoresErrorsThePlayerCannotFix() {
    assertFalse(LoadRules.showsError(true, WebViewClient.ERROR_UNSUPPORTED_SCHEME, url, url))
    assertFalse(LoadRules.showsError(true, WebViewClient.ERROR_UNKNOWN, url, url))
    assertFalse(LoadRules.showsError(true, WebViewClient.ERROR_HOST_LOOKUP, null, url))
  }

  @Test fun barShowsOnlyWhileAGamePageLoads() {
    assertTrue(LoadRules.barVisible(30, onGamePage = true, errorShown = false))
    assertFalse(LoadRules.barVisible(100, onGamePage = true, errorShown = false))
    assertFalse(LoadRules.barVisible(30, onGamePage = false, errorShown = false))
    assertFalse(LoadRules.barVisible(30, onGamePage = true, errorShown = true))
  }

  @Test fun barAlwaysShowsAVisibleSliver() {
    assertEquals(80, LoadRules.barFill(0, 1000))
    assertEquals(500, LoadRules.barFill(50, 1000))
    assertEquals(1000, LoadRules.barFill(100, 1000))
  }
}
