package net.lakesidegames.ahdclient

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TextsTest {
  private val placeholder = Regex("%(\\d\\$)?[sd]")

  @Test fun theGameLanguageDecidesTheAppLanguage() {
    assertEquals("de", Texts.pick("de"))
    assertEquals("de", Texts.pick("de-AT"))
    assertEquals("en", Texts.pick("en-GB"))
    // A language the app has no words for stays English, not the phone's.
    assertEquals("en", Texts.pick("fr"))
    // No cookie: the phone, or the per-app language, decides.
    assertNull(Texts.pick(null))
    assertNull(Texts.pick(""))
  }

  @Test fun germanHasEveryEnglishStringAndPlural() {
    val en = TestTexts.load("values")
    val de = TestTexts.load("values-de")
    val missing = en.strings.keys - de.strings.keys
    assertTrue("missing German strings: $missing", missing.isEmpty())
    assertEquals(emptySet<String>(), de.strings.keys - en.strings.keys)
    assertEquals(en.plurals.keys, de.plurals.keys)
  }

  @Test fun germanKeepsTheSamePlaceholders() {
    val en = TestTexts.load("values")
    val de = TestTexts.load("values-de")
    for ((key, english) in en.strings) {
      val german = de.strings[key] ?: continue
      assertEquals(key, placeholder.findAll(english).map { it.value }.sorted().toList(), placeholder.findAll(german).map { it.value }.sorted().toList())
    }
    for ((key, forms) in en.plurals) {
      for (quantity in forms.keys) {
        assertEquals("$key $quantity", placeholder.findAll(forms.getValue(quantity)).map { it.value }.toList(),
          placeholder.findAll(de.plurals.getValue(key).getValue(quantity)).map { it.value }.toList())
      }
    }
  }

  @Test fun noDashesInEitherLanguage() {
    for (folder in listOf("values", "values-de")) {
      val table = TestTexts.load(folder)
      val all = table.strings.values + table.plurals.values.flatMap { it.values }
      assertFalse(folder, all.any { it.contains('—') || it.contains('–') })
    }
  }
}
