import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

if (file("google-services.json").exists()) { apply(plugin = "com.google.gms.google-services") }

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "net.lakesidegames.ahdclient"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "net.lakesidegames.ahdclient"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    // Release signing comes from gen/android/keystore.properties (gitignored):
    //   keyAlias=upload
    //   password=<store and key password>
    //   storeFile=<absolute path to the upload keystore>
    // Without the file the release build stays unsigned, which is what CI
    // produces for verification.
    val keystorePropertiesFile = rootProject.file("keystore.properties")
    val keystoreProperties = Properties().apply {
        if (keystorePropertiesFile.exists()) {
            FileInputStream(keystorePropertiesFile).use { load(it) }
        }
    }
    if (keystorePropertiesFile.exists()) {
        signingConfigs {
            create("release") {
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["password"] as String
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["password"] as String
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (keystorePropertiesFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    implementation("androidx.dynamicanimation:dynamicanimation:1.0.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
// wry 0.55's generated RustWebView.getCookies returns CookieManager.getCookie(url)
// as a non-null String, but getCookie returns null when the URL has no
// cookies (a fresh install or a signed-out player). Kotlin then throws
// NullPointerException inside the JNI call and the app dies on launch
// (ticket 1387). wry writes generated/RustWebView.kt during the Rust build,
// which runs after preBuild, so patch it as the first action of every Kotlin
// compile instead.
fun patchWryGetCookies(root: File) {
    root.walkTopDown().filter { it.name == "RustWebView.kt" && it.parentFile.name == "generated" }.forEach { file ->
        val text = file.readText()
        val fixed = text.replace("return cookieManager.getCookie(url)\n", "return cookieManager.getCookie(url) ?: \"\"\n")
        if (fixed != text) {
            file.writeText(fixed)
            println("Patched null-safe getCookies in ${file.path}")
        }
    }
}
tasks.matching { it.name.startsWith("compile") && it.name.endsWith("Kotlin") }.configureEach {
    doFirst { patchWryGetCookies(project.file("src/main/java")) }
}
