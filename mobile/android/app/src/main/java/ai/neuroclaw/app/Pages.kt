package ai.neuroclaw.app

/**
 * The pages of the shared interface that the engine serves and the phone shows in its web view
 * (WebActivity). The same list as the "More" tab in interface/platform/settings-page.ts, plus the chat and
 * Settings themselves, so the phone reaches everything the desktop does without going through Settings first.
 * test/platform/mobile-native.test.mjs fails if a page is added there and not here.
 *
 * Left out on purpose: "/app", the older React dashboard, which needs WebGL. Settings > More still lists it.
 */
object Pages {
    class Page(val path: String, val title: String)

    val ALL: List<Page> = listOf(
        Page("/", "Chat"),
        Page("/settings", "Settings"),
        Page("/accounts", "Accounts"),
        Page("/commons", "Commons"),
        Page("/sharing", "Sharing"),
        Page("/app/store", "Store"),
        Page("/builder", "Extension Builder"),
        Page("/app/self-improvement", "Self-improvement"),
    )
}
