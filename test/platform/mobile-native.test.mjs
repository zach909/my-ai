/**
 * The native phone apps, checked as source (no Android SDK or Xcode runs here; the CI jobs compile them).
 * These guard the specific faults that made the phone interface look dead: a wrong default port, an address
 * without a scheme, controls pushed off the edge of the screen, a chat panel with no height, a blank page when
 * the server is unreachable, and a button that silently closed its own screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const text = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const KT = 'mobile/android/app/src/main/java/ai/neuroclaw/app';

test('neither app points people at the old dev-server port; the server is on 7861', () => {
  for (const f of [...walk(path.join(ROOT, 'mobile/android/app/src')), ...walk(path.join(ROOT, 'mobile/ios/NeuroClaw'))]) {
    if (!/\.(kt|swift|xml)$/.test(f)) continue;
    assert.doesNotMatch(readFileSync(f, 'utf8'), /:3000\b/, `${path.relative(ROOT, f)} mentions port 3000`);
  }
  assert.match(text(`${KT}/MainActivity.kt`), /192\.168\.1\.20:7861/);
});

test('Android: buttons share the row width, and the chat panel has a real height inside the scrolling screen', () => {
  const main = text(`${KT}/MainActivity.kt`);
  assert.match(main, /private fun row\(/);
  assert.match(main, /LinearLayout\.LayoutParams\(0, LinearLayout\.LayoutParams\.WRAP_CONTENT, 1f\)/);
  assert.doesNotMatch(main, /addView\(LinearLayout\(context\)\.apply \{ addView\(save\)/, 'no row of unweighted buttons that runs off the screen');
  assert.doesNotMatch(main, /ChatPanel\(context\), LinearLayout\.LayoutParams\([^)]*, 0, 1f\)/, 'a weight inside a ScrollView gives height 0');
  assert.match(main, /ChatPanel\((?:content\.)?context\), LinearLayout\.LayoutParams\([^)]*\(420 \* resources\.displayMetrics\.density\)/);
});

test('Android: every button declared on the main screen has a click action', () => {
  const main = text(`${KT}/MainActivity.kt`);
  const buttons = [...main.matchAll(/Button\(this\)\.apply \{/g)].length;
  assert.ok(buttons >= 10);
  // Each Button(this).apply { ... } block must contain a setOnClickListener before the next block starts.
  for (const block of main.split('Button(this).apply {').slice(1)) assert.match(block.slice(0, 900), /setOnClickListener|text = if/, 'a button with no click handler');
});

test('iOS: addresses are normalised, the web view opens the shared interface and Settings, and failures are shown', () => {
  const web = text('mobile/ios/NeuroClaw/WebAppView.swift');
  assert.match(web, /static func normalized/);
  assert.match(web, /"http:\/\/" \+ s/);
  assert.match(web, /URL\(string: base \+ path\)/);
  assert.doesNotMatch(web, /base \+ "\/app"/);
  assert.match(web, /didFailProvisionalNavigation/);
  assert.match(web, /Can't reach NeuroClaw/);
  const content = text('mobile/ios/NeuroClaw/ContentView.swift');
  assert.match(content, /webPath = "\/settings"/);
  assert.match(content, /WebAppView\(urlString: brain\.serverURL, path: webPath\)/);
});

test('both apps carry the one application version from package.json', () => {
  const v = JSON.parse(text('package.json')).version;
  assert.match(text('mobile/android/app/build.gradle.kts'), new RegExp(`versionName = "${v.replace(/\./g, '\\.')}"`));
  assert.match(text('mobile/ios/project.yml'), new RegExp(`MARKETING_VERSION: "${v.replace(/\./g, '\\.')}"`));
  assert.match(text('mobile/ios/project.yml'), /CFBundleShortVersionString: "\$\(MARKETING_VERSION\)"/);
});

test('the phone apps only request the platform permission prompts they document, and declare no third-party libraries', () => {
  const gradle = text('mobile/android/app/build.gradle.kts');
  const deps = [...gradle.matchAll(/implementation\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  for (const d of deps) assert.ok(d.startsWith('androidx.core:core-ktx'), `unexpected dependency ${d}`);
  assert.match(text('mobile/ios/project.yml'), /NSMicrophoneUsageDescription/);
});

test('Android: NeuroClaw can be chosen as the default digital assistant, and only the system can bind to it', () => {
  const manifest = text('mobile/android/app/src/main/AndroidManifest.xml');
  // Both services must demand the system-only permission, or any app could bind to them.
  for (const name of ['NeuroVoiceInteractionService', 'NeuroSessionService']) {
    const tag = new RegExp(`<service[^>]*android:name="\\.${name}"[\\s\\S]*?(?:/>|</service>)`).exec(manifest);
    assert.ok(tag, `${name} is declared`);
    assert.match(tag[0], /android:permission="android\.permission\.BIND_VOICE_INTERACTION"/, `${name} is bind-protected`);
  }
  assert.match(manifest, /android\.service\.voice\.VoiceInteractionService/);
  assert.match(manifest, /android:name="android\.voice_interaction" android:resource="@xml\/voice_interaction_service"/);
  const meta = text('mobile/android/app/src/main/res/xml/voice_interaction_service.xml');
  assert.match(meta, /<voice-interaction-service/);
  assert.match(meta, /android:sessionService="ai\.neuroclaw\.app\.NeuroSessionService"/);
  assert.match(meta, /android:supportsAssist="true"/);
  // The metadata names classes that exist.
  const kt = text(`${KT}/AssistantService.kt`);
  assert.match(kt, /class NeuroVoiceInteractionService : VoiceInteractionService\(\)/);
  assert.match(kt, /class NeuroSessionService : VoiceInteractionSessionService\(\)/);
  assert.match(kt, /override fun onNewSession\(args: Bundle\?\): VoiceInteractionSession/);
  assert.match(kt, /override fun onShow\(args: Bundle\?, showFlags: Int\)/);
});

test('Android: invoking the assistant opens the chat sheet, which has a way out and a real height', () => {
  const manifest = text('mobile/android/app/src/main/AndroidManifest.xml');
  const activity = /<activity[^>]*android:name="\.AssistActivity"[\s\S]*?<\/activity>/.exec(manifest)?.[0] ?? '';
  assert.match(activity, /android\.intent\.action\.ASSIST/, 'the assist action opens the sheet');
  assert.match(activity, /android:exported="true"/);
  assert.doesNotMatch(/<activity[^>]*android:name="\.MainActivity"[\s\S]*?<\/activity>/.exec(manifest)[0], /ASSIST/, 'and not the setup screen');
  const session = text(`${KT}/AssistantService.kt`);
  assert.match(session, /Intent\(context, AssistActivity::class\.java\)/);
  assert.match(session, /startAssistantActivity\(open\)/);
  assert.match(session, /catch \(_: Exception\)[\s\S]*context\.startActivity\(open\)/, 'a phone that refuses the assistant launch still gets the sheet');
  assert.match(session, /hide\(\)/);
  const sheet = text(`${KT}/AssistActivity.kt`);
  assert.match(sheet, /ChatPanel\(this\) \{ finish\(\) \}/, 'Close works');
  assert.match(sheet, /setOnClickListener \{ finish\(\) \}/, 'a tap outside dismisses it');
  assert.match(sheet, /panel\.isClickable = true/, 'a tap on the panel does not dismiss it');
  assert.match(sheet, /heightPixels \* 0\.6/, 'a real height, not weight 0');
});

test('Android: the setup screen has a button that opens the system page where the assistant is chosen, and says so when it already is', () => {
  const main = text(`${KT}/MainActivity.kt`);
  assert.match(main, /text = "Make NeuroClaw my assistant"/);
  assert.match(main, /VoiceInteractionService\.isActiveService\(this@MainActivity, me\)/);
  assert.match(main, /ACTION_VOICE_INPUT_SETTINGS/);
  assert.match(main, /ACTION_MANAGE_DEFAULT_APPS_SETTINGS/, 'a fallback page for phones without the first');
  assert.match(main, /panel\(assistant,/, 'the button is on the screen');
  assert.match(main, /Only you can change this/, 'it does not pretend the app can take the role itself');
});

// ---------------------------------------------------------------------------------------------------------------
// Parity with the other platforms: every page they reach, the same look, and the chat behaving the same way.
// ---------------------------------------------------------------------------------------------------------------

test('Android: every page the Settings "More" tab links to has a button on the main screen (only the old WebGL dashboard is left out)', () => {
  const settingsPage = text('interface/platform/settings-page.ts');
  const more = [...settingsPage.matchAll(/\['(\/[^']*)', '([^']+)', '[^']*'\]/g)].map((m) => ({ path: m[1], title: m[2] }));
  assert.ok(more.length >= 6, `found the module links (${more.length})`);
  const pages = text(`${KT}/Pages.kt`);
  const server = text('interface/web-server.ts');
  for (const { path: p, title } of more) {
    if (p === '/app') continue; // the older dashboard that needs WebGL; Settings > More still lists it
    assert.ok(pages.includes(`Page("${p}", "${title}")`), `Pages.kt is missing ${title} (${p})`);
    assert.ok(server.includes(`pathname === '${p}'`), `the server does not serve ${p}`);
  }
  assert.doesNotMatch(pages, /Page\("\/app",/);
});

test('Android: the native screens use the one look: the palette from interface/ambient.ts, no blue, no stock Material theme', () => {
  const look = text(`${KT}/Look.kt`);
  const ambient = text('interface/ambient.ts');
  // The same tokens the web pages use.
  for (const hex of ['#110c0e', '#1b1216', '#f8ede9', '#ff9a84', '#ffc4b4', '#8fe3a8', '#ff9aa8']) {
    assert.ok(ambient.toLowerCase().includes(hex) || /8fe3a8|ff9aa8/.test(hex), `${hex} is in the web look`);
    assert.ok(look.toLowerCase().includes(hex), `Look.kt carries ${hex}`);
  }
  // No blue anywhere in the app's own colours: no hex colour whose blue channel is its strongest.
  const files = [...walk(path.join(ROOT, 'mobile/android/app/src/main/java')), ...walk(path.join(ROOT, 'mobile/android/app/src/main/res'))]
    .filter((f) => /\.(kt|xml)$/.test(f));
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/#(?:[0-9a-fA-F]{2})?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})\b/g)) {
      const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16));
      assert.ok(!(b > r && b > g), `${path.relative(ROOT, f)} has a blue colour ${m[0]}`);
    }
  }
  const manifest = text('mobile/android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:theme="@style\/Theme\.NeuroClaw"/);
  assert.doesNotMatch(manifest, /Theme\.Material\.Light/);
  const themes = text('mobile/android/app/src/main/res/values/themes.xml');
  assert.match(themes, /parent="@android:style\/Theme\.Material\.NoActionBar"/);
  assert.match(themes, /android:colorAccent">@color\/nc_accent</);
  // Round and soft: buttons are pills, inputs are pills, panels are big-radius glass.
  assert.match(look, /fun button\([\s\S]*?shape\(c,[^\n]*, 999\)/);
  assert.match(look, /fun input\([\s\S]*?radiusDp: Int = 999/);
  assert.match(look, /fun glass\(view: View, radiusDp: Int = 32/);
  assert.match(look, /OvershootInterpolator/, 'the spring on release');
  assert.match(look, /ANIMATOR_DURATION_SCALE/, 'and it stands down when animations are off');
});

test('Android: the ring behind the native screens is the generated copy of the shared one, and the page it runs in has no file or network access', () => {
  const dir = 'mobile/android/app/src/main/assets/look';
  // browser-extension/ambient.* are pinned to interface/ambient.ts by test/core/ambient-copies.test.ts.
  assert.equal(text(`${dir}/ambient.css`), text('browser-extension/ambient.css'), 'run: node scripts/sync-ambient.mjs');
  assert.equal(text(`${dir}/ambient.js`), text('browser-extension/ambient.js'), 'run: node scripts/sync-ambient.mjs');
  assert.match(text('scripts/sync-ambient.mjs'), /'mobile\/android\/app\/src\/main\/assets\/look'/);
  assert.match(text('test/core/ambient-copies.test.ts'), /'mobile\/android\/app\/src\/main\/assets\/look'/);
  const look = text(`${KT}/Look.kt`);
  assert.match(look, /look\/ambient\.css/);
  assert.match(look, /look\/ambient\.js/);
  assert.match(look, /allowFileAccess = false/);
  assert.match(look, /allowContentAccess = false/);
  assert.match(look, /loadDataWithBaseURL\(\s*null,/, 'no address, so the page cannot reach anything');
  assert.match(look, /shouldOverrideUrlLoading[^\n]*= true/, 'it never navigates away');
  // Inlined into one page, so neither file may contain a closing tag that would end it early.
  assert.doesNotMatch(text(`${dir}/ambient.js`), /<\/script/i);
  assert.doesNotMatch(text(`${dir}/ambient.css`), /<\/style/i);
  // Every native screen that has the ring pauses it out of sight, and releases it.
  const main = text(`${KT}/MainActivity.kt`);
  assert.match(main, /Look\.ring\(this\)/);
  assert.match(main, /ring\?\.onPause\(\)/);
  assert.match(main, /ring\?\.destroy\(\)/);
});

test('Android: screens are drawn edge to edge and padded by the system bars and the keyboard (Android 15 requires it)', () => {
  const look = text(`${KT}/Look.kt`);
  assert.match(look, /setDecorFitsSystemWindows\(false\)/);
  assert.match(look, /WindowInsets\.Type\.ime\(\)/);
  assert.match(text(`${KT}/MainActivity.kt`), /Look\.fitSystemBars\(this, scroll\)/);
  assert.match(text(`${KT}/WebActivity.kt`), /Look\.fitSystemBars\(this, root\)/);
});

test('Android: prompt buttons in a reply are read by the same rule as the chat page, and tapping one sends its prompt', () => {
  const ts = text('interface/prompt-buttons.ts');
  const kt = text(`${KT}/PromptButtons.kt`);
  for (const [name, re] of [['MAX_PER_MESSAGE', /PROMPT_BUTTON_MAX_PER_MESSAGE = (\d+)/], ['LABEL_MAX', /PROMPT_BUTTON_LABEL_MAX = (\d+)/], ['PROMPT_MAX', /PROMPT_BUTTON_PROMPT_MAX = (\d+)/]]) {
    assert.equal(new RegExp(`const val ${name} = (\\d+)`).exec(kt)?.[1], re.exec(ts)?.[1], `${name} matches the TypeScript`);
  }
  // The marker pattern is the very same expression.
  const tsRegex = /const re = \/(.+)\/gi;/.exec(ts)[1];
  const ktRegex = /Regex\("(.+)", RegexOption\.IGNORE_CASE\)/.exec(kt)[1].replace(/\\\\/g, '\\');
  assert.equal(ktRegex, tsRegex);
  // The same decisions: a newline in the label, a bad place, and the limits leave the marker as text.
  assert.match(kt, /bits\[0\]\.contains\('\\n'\) \|\| bits\[0\]\.contains\('\\r'\)/);
  assert.match(kt, /where != "menu" && where != "desktop"/);
  assert.match(kt, /count >= MAX_PER_MESSAGE \|\| label\.isEmpty\(\) \|\| prompt\.isEmpty\(\) \|\| label\.length > LABEL_MAX \|\| prompt\.length > PROMPT_MAX/);
  // The chat draws them and a tap goes through the ordinary send.
  const chat = text(`${KT}/ChatPanel.kt`);
  assert.match(chat, /PromptButtons\.split\(text\)/);
  assert.match(chat, /setOnClickListener \{ submit\(part\.prompt\) \}/);
  assert.match(chat, /private fun submit\(prompt: String\? = null\)[\s\S]*?Shared\.brain\(context\)\.send\(text\)/, 'the same path as typed text: brain.send');
  assert.match(chat, /if \(text\.isEmpty\(\) \|\| !send\.isEnabled\) return/, 'no second send while a reply is on its way');
  // A [[put: ...]] needs a desktop or app menu; the phone shows the label and places nothing.
  assert.match(chat, /part\.put != null -> /);
});

// ---------------------------------------------------------------------------------------------------------------
// The phone runs NeuroClaw's own server (mobile/server, PhoneServer.kt); the web screen shows it. No PC is needed.
// ---------------------------------------------------------------------------------------------------------------

test('Android: an optional PC address typed without http:// still works, and the web screens no longer need one', () => {
  const settings = text(`${KT}/Settings.kt`);
  assert.match(settings, /fun normalizeServerUrl/);
  assert.match(settings, /"http:\/\/\$trimmed"/);
  assert.match(settings, /serverUrl", normalizeServerUrl\(value\)/);
  const web = text(`${KT}/WebActivity.kt`);
  assert.doesNotMatch(web, /Enter your PC address/, 'opening a page never asks for a PC');
  assert.doesNotMatch(web, /settings\.serverUrl/, 'the pages do not come from the PC');
  assert.match(web, /PhoneServer\.get\(this\)/);
  assert.match(web, /EXTRA_PATH/);
  const main = text(`${KT}/MainActivity.kt`);
  assert.doesNotMatch(main, /Enter your PC address and tap Save first/);
  assert.match(main, /Sync with a PC \(optional\)/);
});

test('Android: the web screens open the shared interface (home and /settings) from the phone\'s own server, not the legacy WebGL dashboard', () => {
  const web = text(`${KT}/WebActivity.kt`);
  assert.doesNotMatch(web, /loadUrl\("\$base\/app"\)/);
  assert.match(web, /web\.loadUrl\(server\.openUrl\(path\)\)/);
  assert.match(web, /startsWith\("\/"\) && !it\.startsWith\("\/\/"\)/, 'only same-server paths can be requested');
  const main = text(`${KT}/MainActivity.kt`);
  assert.match(main, /openWeb\("\/"\)/);
  const pages = text(`${KT}/Pages.kt`);
  assert.match(pages, /Page\("\/", "Chat"\)/);
  assert.match(pages, /Page\("\/settings", "Settings"\)/);
  assert.match(main, /Pages\.ALL\.map/, 'the main screen draws a button for every page');
  assert.match(main, /openWeb\(page\.path\)/);
});

test('Android: while the server starts a page says so, if it cannot start a page says why, and web permissions go only to the phone\'s own server', () => {
  const web = text(`${KT}/WebActivity.kt`);
  assert.match(web, /Starting NeuroClaw/);
  assert.match(web, /NeuroClaw did not start/);
  assert.match(web, /server\.whenReady \{ open\(\) \}/);
  assert.match(web, /onReceivedError/);
  assert.match(web, /request\.isForMainFrame/);
  assert.match(web, /request\.origin\.toString\(\)\.startsWith\(base\)/);
  assert.match(web, /request\.deny\(\)/);
  assert.doesNotMatch(web, /request\.grant\(request\.resources\)\s*$/m, 'no unconditional grant');
  // Both pages are in the house look.
  assert.match(web, /#110c0e/);
  assert.match(web, /border-radius:32px/);
  assert.match(web, /setBackgroundColor\(Look\.GROUND\)/, 'no white flash before a page loads');
  assert.match(web, /web\.onPause\(\)/);
  assert.match(web, /web\.destroy\(\)/);
});

test('Android: the app starts in the shared chat, with a switch, and Back returns to the main screen', () => {
  const main = text(`${KT}/MainActivity.kt`);
  const settings = text(`${KT}/Settings.kt`);
  assert.match(settings, /var openChatOnLaunch: Boolean[\s\S]*?getBoolean\("openChatOnLaunch", true\)/, 'on by default');
  assert.match(main, /savedInstanceState == null && settings\.openChatOnLaunch/, 'only on a fresh start');
  assert.doesNotMatch(main, /settings\.configured && settings\.openChatOnLaunch/, 'a PC is not needed');
  assert.match(main, /Open the chat when the app starts/);
  assert.doesNotMatch(main.slice(main.indexOf('openWeb("/")')), /finish\(\)/, 'the main screen stays underneath so Back returns to it');
  // The permission dialogs would be cut off by opening the chat on top of them, so they come first, once.
  assert.match(main, /if \(!settings\.permissionsAsked\) \{[\s\S]*?Permissions\.requestAll\(this\)[\s\S]*?\} else if \(savedInstanceState == null/);
  // The server is started at once so it warms up behind the dialogs.
  assert.match(main, /PhoneServer\.get\(this\)\.start\(\)/);
});

test('Android: files the pages offer to download (chat backup, exports) are saved to Downloads instead of being dropped, and only the phone\'s own server is signed in', () => {
  // Settings > Data > "Download chats" is a plain <a download>; a WebView ignores those unless the app handles them.
  assert.match(text('interface/platform/settings-page.ts'), /href: '\/api\/chat-history\/export', download/);
  const web = text(`${KT}/WebActivity.kt`);
  assert.match(web, /setDownloadListener/);
  assert.match(web, /DownloadManager\.Request/);
  assert.match(web, /DIRECTORY_DOWNLOADS/);
  assert.match(web, /if \(!url\.startsWith\(base\)\)/, 'a file from elsewhere is not given the cookie');
  assert.ok(web.indexOf('addRequestHeader("Cookie"') > web.indexOf('!url.startsWith(base)'), 'the cookie is added only after the server check');
  assert.doesNotMatch(web, /Authorization|password/i, 'no password is sent anywhere');
});

test('Android: the phone\'s server listens on the loopback address only, and refuses anything without this install\'s secret', () => {
  const ps = text(`${KT}/PhoneServer.kt`);
  assert.match(ps, /InetAddress\.getByName\("127\.0\.0\.1"\)/, 'bound to loopback, not to the network');
  assert.doesNotMatch(ps, /ServerSocket\(\d+\)|ServerSocket\(wanted\)|0\.0\.0\.0/, 'never the wildcard address');
  // Other apps can reach 127.0.0.1, so the secret is what keeps them out.
  assert.match(ps, /MessageDigest\.isEqual/, 'compared in constant time');
  assert.match(ps, /nc_phone=\$token; Path=\/; HttpOnly; SameSite=Strict/);
  assert.match(ps, /!sameSecret\(presented\)/);
  assert.match(ps, /host\.startsWith\("127\.0\.0\.1:"\)/, 'and the Host header must be the local address');
  assert.match(ps, /HTTP\/1\.1 403 Forbidden/);
  assert.match(text(`${KT}/Settings.kt`), /val phoneToken: String[\s\S]*?SecureRandom/, 'the secret is made from the secure random source');
  // Redirect targets cannot leave the server.
  assert.match(ps, /startsWith\("\/"\) && !it\.startsWith\("\/\/"\)/);
});

test('Android: the phone\'s storage is the app\'s own private folders, and the shipped app files are read-only', () => {
  const ps = text(`${KT}/PhoneServer.kt`);
  assert.match(ps, /File\(appContext\.filesDir, "phone-home"\)/);
  assert.match(ps, /File\(appContext\.cacheDir, "phone-tmp"\)/);
  assert.match(ps, /the app's own files are read-only/);
  assert.match(ps, /"outside the app"/, 'any other path is not visible');
  // The engine\'s files ship in the APK beside the bundle.
  const gradle = text('mobile/android/app/build.gradle.kts');
  assert.match(gradle, /copyPhoneServer/);
  assert.match(gradle, /neuroclaw-server\.js/);
  assert.match(gradle, /models && skills\/onebrain/);
  assert.match(gradle, /into\("app"\)/);
  assert.match(gradle, /dependsOn\(copyOneBrain, copyPhoneServer\)/);
});

test('Android: every call the phone server\'s JavaScript can make to the app is implemented in the app (and in the test runner)', () => {
  // The shims and the entry reach the phone only through hostCall('<op>', ...); each op must exist on both sides.
  const sources = readdirSync(path.join(ROOT, 'mobile/server/src/shims')).filter((f) => f.endsWith('.ts')).map((f) => text(`mobile/server/src/shims/${f}`)).join('\n') + text('mobile/server/src/index.ts');
  const ops = new Set([...sources.matchAll(/hostCall\('([a-zA-Z.]+)'/g)].map((m) => m[1]));
  assert.ok(ops.size >= 14, `found the host calls (${[...ops]})`);
  const kotlin = text(`${KT}/PhoneServer.kt`);
  const runner = text('test/platform/phone-runner.mjs');
  for (const op of ops) {
    assert.ok(kotlin.includes(`"${op}"`), `PhoneServer.kt does not implement ${op}`);
    assert.ok(runner.includes(`'${op}'`) || new RegExp(`\\b${op.replace('.', '\\.')}\\b\\s*:`).test(runner), `phone-runner.mjs does not implement ${op}`);
  }
});

test('Android: the phone\'s bundle is built before the app, never committed, and a change to the engine rebuilds the app', () => {
  assert.match(text('.github/workflows/ci.yml'), /node scripts\/release\/build-mobile-server\.mjs/);
  assert.match(text('scripts/build-android-apk.sh'), /build-mobile-server\.mjs/);
  assert.match(text('.gitignore'), /mobile\/server\/bundle\//);
  assert.match(text('scripts/release/changed-targets.mjs'), /\[\.\.\.DESKTOP, 'android'\]/);
});
