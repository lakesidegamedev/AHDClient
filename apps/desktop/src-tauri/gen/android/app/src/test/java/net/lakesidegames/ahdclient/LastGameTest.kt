package net.lakesidegames.ahdclient

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LastGameTest {
  @Test fun savesAPlainLivePageWithItsQuery() {
    assertEquals("/country/fr", LastGame.pathToSave("https://ahousedividedgame.com/country/fr"))
    assertEquals("/map?layer=trade", LastGame.pathToSave("https://www.ahousedividedgame.com/map?layer=trade#top"))
    assertEquals("/", LastGame.pathToSave("https://ahousedividedgame.com/"))
  }

  @Test fun neverSavesPagesThatCouldLoopOrLeaveTheLiveSite() {
    for (url in listOf(
      "https://ahousedividedgame.com/login", "https://ahousedividedgame.com/login?next=%2F",
      "https://ahousedividedgame.com/logout", "https://ahousedividedgame.com/register",
      "https://ahousedividedgame.com/api/auth/discord/callback", "https://ahousedividedgame.com/auth/x",
      "https://sandbox.ahousedividedgame.com/country/fr", "http://tauri.localhost/", "https://evil.example/country/fr",
      "http://ahousedividedgame.com/country/fr", "https://ahousedividedgame.com", "https://ahousedividedgame.com//evil.example",
      "https://ahousedividedgame.com/a b", "https://ahousedividedgame.com/" + "a".repeat(300), "", null,
    )) assertNull(url.toString(), LastGame.pathToSave(url))
    assertEquals("/loginfo", LastGame.pathToSave("https://ahousedividedgame.com/loginfo"))
  }

  @Test fun fileBodyHasThePathAndAccountTheRustSideReads() {
    val saved = JSONObject(LastGame.encode("/country/fr", "abc123"))
    assertEquals("/country/fr", saved.getString("path"))
    assertEquals("abc123", saved.getString("account"))
  }
}
