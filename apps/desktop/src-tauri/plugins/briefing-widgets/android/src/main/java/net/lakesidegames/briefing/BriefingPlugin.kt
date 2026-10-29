package net.lakesidegames.briefing

import android.Manifest
import android.app.Activity
import android.app.Application
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

@InvokeArg
class PushOptions { var enabled: Boolean = false }

@InvokeArg
class CookieOptions { var url: String = "" }

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")])
class BriefingPlugin(private val activity: Activity) : Plugin(activity), Application.ActivityLifecycleCallbacks {
  private val handler = Handler(Looper.getMainLooper())
  private val poll = object : Runnable {
    override fun run() {
      NativeSafety.run("push poll") {
        syncSafely()
        handler.postDelayed(this, 5000)
      }
    }
  }
  override fun load(webView: WebView) {
    NativeSafety.run("Ask attach") { NativeAskController.attach(activity, webView) }
    NativeSafety.run("lifecycle registration") {
      activity.application.registerActivityLifecycleCallbacks(this)
    }
    NativeSafety.run("push poll start") { handler.post(poll) }
  }
  @Command
  fun showAsk(invoke: Invoke) {
    NativeSafety.run("Ask presentation request") { NativeAskController.present() }
    invoke.resolve(JSObject("{\"ok\":true}"))
  }
  /**
   * The cookie header the WebView would send to `url`. wry's own reader waits
   * ten seconds for the main thread, then drops its reply channel; a late
   * reply then panics in wry and aborts the app (API 36 launch test, 2.4.0).
   * Tauri's plugin bridge waits without a deadline instead.
   */
  @Command
  fun cookiesForUrl(invoke: Invoke) {
    val url = NativeSafety.get("cookie argument parsing", "") { invoke.parseArgs(CookieOptions::class.java).url }
    val header = NativeSafety.get("cookie read", "") {
      if (url.startsWith("https://")) CookieManager.getInstance().getCookie(url) ?: "" else ""
    }
    invoke.resolve(JSObject().apply { put("cookies", header) })
  }
  @Command
  fun pushStatus(invoke: Invoke) {
    syncSafely()
    invoke.resolve(JSObject(statusSafely().toString()))
  }
  @Command
  fun sendTestPush(invoke: Invoke) {
    val app = activity.applicationContext
    // Network I/O: never on the main thread.
    val started = NativeSafety.run("push test scheduling") {
      Thread {
        val result = NativePush.sendTest(app)
        invoke.resolve(JSObject().apply { put("result", result) })
      }.start()
    }
    if (!started) invoke.resolve(JSObject().apply { put("result", "error") })
  }
  @Command
  fun configurePush(invoke: Invoke) {
    val enabled = NativeSafety.get("push argument parsing", false) {
      invoke.parseArgs(PushOptions::class.java).enabled
    }
    if (!NativeSafety.run("push configuration") {
      NativePush.setEnabled(activity, enabled)
    }) {
      invoke.resolve(JSObject(statusSafely().toString()))
      return
    }
    val permissionGranted = NativeSafety.get("notification permission check", false) {
      NativePush.permitted(activity)
    }
    if (enabled && Build.VERSION.SDK_INT >= 33 && !permissionGranted) {
      if (!NativeSafety.run("notification permission request") {
        requestPermissionForAlias("notifications", invoke, "pushPermissionResult")
      }) {
        invoke.resolve(JSObject(statusSafely().toString()))
      }
    } else {
      syncSafely(true)
      invoke.resolve(JSObject(statusSafely().toString()))
    }
  }
  @PermissionCallback
  fun pushPermissionResult(invoke: Invoke) {
    syncSafely(true)
    invoke.resolve(JSObject(statusSafely().toString()))
  }
  override fun onActivityResumed(target: Activity) {
    if (target === activity) {
      NativeSafety.run("push poll resume") {
        handler.removeCallbacks(poll)
        handler.post(poll)
      }
    }
  }
  override fun onActivityPaused(target: Activity) {
    if (target === activity) {
      NativeSafety.run("push poll pause") {
        handler.removeCallbacks(poll)
        syncSafely()
      }
    }
  }
  override fun onActivityDestroyed(target: Activity) {
    if (target === activity) {
      NativeSafety.run("push poll shutdown") {
        handler.removeCallbacks(poll)
        activity.application.unregisterActivityLifecycleCallbacks(this)
      }
    }
  }
  override fun onActivityCreated(target: Activity, state: Bundle?) {}
  override fun onActivityStarted(target: Activity) {}
  override fun onActivityStopped(target: Activity) {}
  override fun onActivitySaveInstanceState(target: Activity, state: Bundle) {}

  private fun syncSafely(force: Boolean = false) {
    NativeSafety.run("push sync") {
      NativePush.sync(activity, force)
    }
  }

  private fun statusSafely(): JSONObject = NativeSafety.get("push status", JSONObject()
    .put("enabled", false).put("permissionGranted", false).put("available", false)
    .put("registered", false).put("message", "Push is unavailable in this build.")) {
    NativePush.status(activity)
  }
}
