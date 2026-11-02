plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.neuroclaw.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "ai.neuroclaw.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 100
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    // OneBrain ships inside the app so it can answer offline: the same
    // models && skills/onebrain/model.json the PC loads, copied in at build.
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/onebrain-assets"))
}

val copyOneBrain by tasks.registering(Copy::class) {
    from(rootProject.file("../../models && skills/onebrain/model.json")) { into("onebrain") }
    // The full network for the phone: the PC's engine bundled by
    // mobile/brain (npm run build:phone-brain), run in a hidden WebView.
    from(rootProject.file("../brain/bundle/neuroclaw-brain.js"))
    into(layout.buildDirectory.dir("generated/onebrain-assets"))
}

// NeuroClaw's own server for the phone: the PC's engine and web server, bundled by
// scripts/release/build-mobile-server.mjs (mobile/server), run by PhoneServer.kt. The files the engine reads at run
// time ("/phone/app/...") ship beside it under assets/app. The ring that the native screens draw behind them is
// the generated assets/look (scripts/sync-ambient.mjs).
val copyPhoneServer by tasks.registering(Copy::class) {
    val bundle = rootProject.file("../server/bundle/neuroclaw-server.js")
    doFirst {
        if (!bundle.exists()) throw GradleException("mobile/server/bundle/neuroclaw-server.js is missing: run  node scripts/release/build-mobile-server.mjs  first")
    }
    from(bundle)
    from(rootProject.file("../../package.json")) { into("app") }
    from(rootProject.file("../../models && skills/index.jsonl")) { into("app/models && skills") }
    from(rootProject.file("../../models && skills/onebrain")) { into("app/models && skills/onebrain") }
    into(layout.buildDirectory.dir("generated/onebrain-assets"))
}
tasks.named("preBuild") { dependsOn(copyOneBrain, copyPhoneServer) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
}
