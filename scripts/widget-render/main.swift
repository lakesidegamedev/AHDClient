// Renders every home-screen widget kind and size to PNGs on an iOS
// simulator, so layout problems show up in CI instead of on a player's
// phone. Built by .github/scripts/ios-widget-render.sh with AHDWidgets.swift
// (its @main removed) and BriefingStore.swift.
import Foundation
import SwiftUI
import UIKit
import WidgetKit

@MainActor func renderWidgets(fixture: String, output: String) {
  guard let bytes = FileManager.default.contents(atPath: fixture),
    var data = try? JSONDecoder().decode(BriefingStatus.self, from: bytes) else {
    print("fixture did not decode: \(fixture)"); exit(1)
  }
  // Show a live countdown, as on a player's phone mid-turn.
  data.turn?.nextAt = ISO8601DateFormatter().string(from: Date().addingTimeInterval(31 * 60 + 53))
  let saved = SavedBriefing(updatedAt: Date().addingTimeInterval(-25), sessionId: "render", data: data,
    images: nil, imageSources: nil, schema: BriefingStore.currentSchema)
  let entry = BriefingEntry(date: Date(), saved: saved)
  try? FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
  // iPhone 16 Pro sizes, the content inset by the system's 16 pt margin.
  let sizes: [(String, WidgetFamily, CGSize)] = [
    ("small", .systemSmall, CGSize(width: 170, height: 170)),
    ("medium", .systemMedium, CGSize(width: 364, height: 170)),
    ("large", .systemLarge, CGSize(width: 364, height: 382)),
  ]
  // iPad Pro 11 inch sizes: the same families plus extra large, which only
  // iPad offers (Overview and Stocks).
  let ipadSizes: [(String, WidgetFamily, CGSize)] = [
    ("ipad-small", .systemSmall, CGSize(width: 155, height: 155)),
    ("ipad-medium", .systemMedium, CGSize(width: 329, height: 155)),
    ("ipad-large", .systemLarge, CGSize(width: 329, height: 345)),
    ("ipad-extralarge", .systemExtraLarge, CGSize(width: 690, height: 345)),
  ]
  for section in ["corporation", "profile", "overview", "election", "stocks"] {
    let all = sizes + ipadSizes.filter { $0.1 != .systemExtraLarge || section == "overview" || section == "stocks" }
    for (name, family, size) in all where !(section == "overview" && family == .systemSmall) {
      let view = BriefingWidgetView(entry: entry, section: section, familyOverride: family)
        .padding(16)
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .background(LinearGradient(colors: [Color(red: 0.11, green: 0.12, blue: 0.18), Color(red: 0.05, green: 0.05, blue: 0.08)],
          startPoint: .topLeading, endPoint: .bottomTrailing))
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .environment(\.colorScheme, .dark)
      let renderer = ImageRenderer(content: view)
      renderer.scale = 3
      if let png = renderer.uiImage?.pngData() {
        let path = "\(output)/\(section)-\(name).png"
        FileManager.default.createFile(atPath: path, contents: png)
        print("rendered \(path)")
      } else {
        print("render failed: \(section) \(name)")
      }
    }
  }
}

let arguments = CommandLine.arguments
MainActor.assumeIsolated {
  renderWidgets(fixture: arguments.count > 1 ? arguments[1] : "briefing-fixture.json",
    output: arguments.count > 2 ? arguments[2] : "widget-renders")
}
