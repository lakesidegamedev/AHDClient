package net.lakesidegames.ahdclient

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element

/**
 * Resolves resource ids against the real strings.xml files on the JVM, so tests see the same words
 * the app ships. [install] uses English; [load] reads either language for the parity checks.
 */
object TestTexts {
  class Table(val strings: Map<String, String>, val plurals: Map<String, Map<String, String>>)

  private fun file(folder: String) = File("src/main/res/$folder/strings.xml")

  private fun unescape(text: String) = text.replace("\\'", "'").replace("\\@", "@").replace("\\?", "?")

  fun load(folder: String): Table {
    val strings = HashMap<String, String>()
    val plurals = HashMap<String, Map<String, String>>()
    val root = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file(folder)).documentElement
    val nodes = root.childNodes
    for (i in 0 until nodes.length) {
      val node = nodes.item(i) as? Element ?: continue
      when (node.tagName) {
        "string" -> strings[node.getAttribute("name")] = unescape(node.textContent.trim().removeSurrounding("\""))
        "plurals" -> {
          val items = HashMap<String, String>()
          val children = node.getElementsByTagName("item")
          for (j in 0 until children.length) {
            val item = children.item(j) as Element
            items[item.getAttribute("quantity")] = unescape(item.textContent)
          }
          plurals[node.getAttribute("name")] = items
        }
      }
    }
    return Table(strings, plurals)
  }

  private fun names(clazz: Class<*>): Map<Int, String> =
    clazz.fields.associate { it.getInt(null) to it.name }

  fun install(folder: String = "values") {
    val table = load(folder)
    val stringNames = names(R.string::class.java)
    val pluralNames = names(R.plurals::class.java)
    Texts.lookup = object : Texts.Lookup {
      override fun string(id: Int, args: Array<out Any>): String {
        val text = table.strings.getValue(stringNames.getValue(id))
        return if (args.isEmpty()) text else String.format(text, *args)
      }
      override fun plural(id: Int, count: Int, args: Array<out Any>): String {
        val forms = table.plurals.getValue(pluralNames.getValue(id))
        return String.format(forms.getValue(if (count == 1) "one" else "other"), *args)
      }
    }
  }
}
