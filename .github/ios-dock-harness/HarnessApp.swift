import UIKit
import WebKit

// A bare app around the real NativeNavController so the dock can be rendered
// and screenshotted on a simulator in a few minutes, without the Tauri build.
// It loads a stand-in game page into a WKWebView and attaches the dock the
// same way the plugin does. Launch with -AHDDockPreview <state>.
@main
final class HarnessDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    let window = UIWindow(frame: UIScreen.main.bounds)
    let controller = UIViewController()
    controller.view.backgroundColor = UIColor(red: 0x14 / 255, green: 0x14 / 255, blue: 0x1c / 255, alpha: 1)
    let web = WKWebView(frame: controller.view.bounds)
    web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    web.isOpaque = false
    web.backgroundColor = .clear
    var rows = ""
    for index in 1...40 {
      rows += "<div class='row'><b>Senate bill \(index)</b><span>Vote closes in \(index) turns</span></div>"
    }
    let html = """
      <meta name='viewport' content='width=device-width, initial-scale=1'>
      <style>
        body { margin: 0; background: #1b1b26; color: #e8e8ee; font: 16px -apple-system; }
        h1 { margin: 0; padding: 70px 16px 12px; background: #23233a; }
        .row { display: flex; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid #2c2c3c; }
        span { color: #9a9ab0; }
      </style>
      <h1>Stand-in game page</h1>\(rows)
      """
    web.loadHTMLString(html, baseURL: URL(string: "https://ahousedividedgame.com/"))
    controller.view.addSubview(web)
    window.rootViewController = controller
    window.makeKeyAndVisible()
    self.window = window
    NativeNavController.shared.attach(web)
    return true
  }
}
