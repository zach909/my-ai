// The macOS app window for NeuroClaw.
//
// What it does, and all it does: runs the bundled engine through the launcher script
// (Contents/Resources/runtime/node ... desktop-launcher.mjs --embedded) and shows the app in a window using
// the system's own WebKit. There is no network port and no browser: the page's addresses are nc://app/...,
// and every request WebKit makes for one is written as a line to the launcher's stdin and answered from its
// stdout (the format is documented in interface/platform/embedded-transport.ts). Quitting the app or closing
// the window stops the engine.
//
// Only Apple frameworks are used (SwiftUI, WebKit, Foundation). It asks for no
// permissions: no camera, microphone, accessibility or screen recording. Features
// that need those are unavailable in this app and say so in Settings > About.
import SwiftUI
import WebKit
import Foundation

private func encodeField(_ data: Data) -> String { data.isEmpty ? "-" : data.base64EncodedString() }
private func decodeField(_ text: Substring) -> Data { text == "-" ? Data() : (Data(base64Encoded: String(text)) ?? Data()) }
private func headerBlock(_ text: Substring) -> [String: String] {
    var out: [String: String] = [:]
    let block = String(data: decodeField(text), encoding: .utf8) ?? ""
    for line in block.split(separator: "\n") {
        guard let colon = line.firstIndex(of: ":") else { continue }
        let key = line[line.startIndex..<colon].trimmingCharacters(in: .whitespaces)
        let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        out[key] = out[key].map { $0 + ", " + value } ?? value
    }
    return out
}

/// Runs the engine and carries requests to it and answers back.
final class Engine: ObservableObject {
    static let shared = Engine()
    @Published var ready = false
    @Published var failure: String?
    private var process: Process?
    private var toEngine: FileHandle?
    private var buffer = Data()
    private var nextID = 1
    private var waiting: [Int: (Int, [String: String], Data) -> Void] = [:]  // main thread only; status -1 means failed

    func start() {
        guard process == nil else { return }
        let resources = Bundle.main.resourceURL!
        let p = Process()
        p.executableURL = resources.appendingPathComponent("runtime/node")
        p.arguments = [resources.appendingPathComponent("app/scripts/desktop-launcher.mjs").path, "--embedded"]
        p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        let input = Pipe()
        let output = Pipe()
        p.standardInput = input
        p.standardOutput = output
        p.standardError = FileHandle.nullDevice
        toEngine = input.fileHandleForWriting
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.consume(data) }
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                if self?.failure == nil {
                    self?.failure = "The engine stopped (exit code \(proc.terminationStatus))."
                }
                self?.failAll()
            }
        }
        do { try p.run(); process = p } catch { failure = "Could not start the engine: \(error.localizedDescription)" }
    }

    private func consume(_ data: Data) {
        buffer.append(data)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer[buffer.startIndex..<nl]
            buffer.removeSubrange(buffer.startIndex...nl)
            if let line = String(data: lineData, encoding: .utf8) { handle(line) }
        }
    }

    private func handle(_ line: String) {
        let t = line.split(separator: " ", omittingEmptySubsequences: false)
        guard let kind = t.first else { return }
        switch kind {
        case "READY": ready = true
        case "FAILED": failure = String(data: decodeField(t.count > 1 ? t[1] : "-"), encoding: .utf8) ?? "The engine failed."
        case "R" where t.count == 5:
            if let id = Int(t[1]), let status = Int(t[2]) { finish(id, status, headerBlock(t[3]), decodeField(t[4])) }
        case "E" where t.count >= 2:
            if let id = Int(t[1]) { finish(id, -1, [:], Data()) }
        default: break
        }
    }

    private func finish(_ id: Int, _ status: Int, _ headers: [String: String], _ body: Data) {
        if let done = waiting.removeValue(forKey: id) { done(status, headers, body) }
    }

    private func failAll() {
        let all = waiting
        waiting.removeAll()
        for (_, done) in all { done(-1, [:], Data()) }
    }

    /// Ask the engine for one request. Call and answer on the main thread. Returns an id that `cancel` accepts.
    @discardableResult
    func send(method: String, target: String, headers: [String: String], body: Data, done: @escaping (Int, [String: String], Data) -> Void) -> Int {
        let id = nextID
        nextID += 1
        waiting[id] = done
        let block = headers.map { "\($0.key): \($0.value)" }.joined(separator: "\n")
        let line = "Q \(id) \(method) \(encodeField(Data(target.utf8))) \(encodeField(Data(block.utf8))) \(encodeField(body))\n"
        if let h = toEngine { try? h.write(contentsOf: Data(line.utf8)) }
        return id
    }

    func cancel(_ id: Int) { waiting.removeValue(forKey: id) }

    /// SIGTERM: the launcher stops the engine it started, and leaves one that was already running alone.
    func stop() { if let p = process, p.isRunning { p.terminate() } }
}

/// Serves nc://app/... to WebKit by asking the engine. Nothing goes over the network.
final class NCSchemeHandler: NSObject, WKURLSchemeHandler {
    private var tasks: [ObjectIdentifier: Int] = [:]  // task -> request id, so a cancelled page does not get an answer

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let request = urlSchemeTask.request
        guard let url = request.url, url.host == "app",
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            urlSchemeTask.didFailWithError(URLError(.unsupportedURL))
            return
        }
        var target = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
        if let q = parts.percentEncodedQuery { target += "?" + q }
        var headers: [String: String] = [:]
        for name in ["Content-Type", "Accept"] {
            if let v = request.value(forHTTPHeaderField: name) { headers[name] = v }
        }
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buf = [UInt8](repeating: 0, count: 65536)
            while stream.hasBytesAvailable {
                let n = stream.read(&buf, maxLength: buf.count)
                if n <= 0 { break }
                body.append(buf, count: n)
            }
            stream.close()
        }
        let key = ObjectIdentifier(urlSchemeTask as AnyObject)
        let id = Engine.shared.send(method: request.httpMethod ?? "GET", target: target, headers: headers, body: body) { [weak self] status, responseHeaders, data in
            guard self?.tasks.removeValue(forKey: key) != nil else { return }
            guard status > 0, let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: responseHeaders) else {
                urlSchemeTask.didFailWithError(URLError(.cannotConnectToHost))
                return
            }
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        }
        tasks[key] = id
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        if let id = tasks.removeValue(forKey: ObjectIdentifier(urlSchemeTask as AnyObject)) { Engine.shared.cancel(id) }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { Engine.shared.stop() }
}

extension Notification.Name {
    static let ncReload = Notification.Name("ai.neuroclaw.reload")
    static let ncSettings = Notification.Name("ai.neuroclaw.settings")
}

struct WebView: NSViewRepresentable {
    static let origin = URL(string: "nc://app/")!

    func makeCoordinator() -> Coordinator { Coordinator(origin: WebView.origin) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(NCSchemeHandler(), forURLScheme: "nc")
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        context.coordinator.web = web
        web.load(URLRequest(url: WebView.origin))
        return web
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
        let origin: URL
        weak var web: WKWebView?
        private var observers: [NSObjectProtocol] = []

        init(origin: URL) {
            self.origin = origin
            super.init()
            observers.append(NotificationCenter.default.addObserver(forName: .ncReload, object: nil, queue: .main) { [weak self] _ in self?.web?.reload() })
            observers.append(NotificationCenter.default.addObserver(forName: .ncSettings, object: nil, queue: .main) { [weak self] _ in
                if let self = self, let u = URL(string: "/settings", relativeTo: self.origin) { self.web?.load(URLRequest(url: u)) }
            })
        }

        // Links stay inside the app only when they are NeuroClaw's own; everything else opens in the browser.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { decisionHandler(.cancel); return }
            if url.scheme == "about" || url.scheme == "data" || url.scheme == "blob" || (url.scheme == "nc" && url.host == origin.host) {
                decisionHandler(.allow)
            } else {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
            }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
            return nil
        }

        // Importing chats: the page's file chooser.
        func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.canChooseDirectories = false
            panel.begin { result in completionHandler(result == .OK ? panel.urls : nil) }
        }

        // Exporting chats: attachments ask where to save. A file from this app's own address is fetched from the
        // engine and written here, because a download is a network request and this address has no network behind it.
        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
            let isFile = disposition.lowercased().hasPrefix("attachment") || !response.canShowMIMEType
            if isFile, let url = response.response.url, url.scheme == "nc" {
                saveFile(from: url, suggestedName: response.response.suggestedFilename ?? "download")
                decisionHandler(.cancel)
                return
            }
            decisionHandler(isFile ? .download : .allow)
        }

        private func saveFile(from url: URL, suggestedName: String) {
            guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
            var target = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
            if let q = parts.percentEncodedQuery { target += "?" + q }
            Engine.shared.send(method: "GET", target: target, headers: [:], body: Data()) { status, _, data in
                guard status == 200 else { return }
                let panel = NSSavePanel()
                panel.nameFieldStringValue = suggestedName
                panel.begin { result in
                    if result == .OK, let dest = panel.url { try? data.write(to: dest) }
                }
            }
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = suggestedFilename
            panel.begin { result in completionHandler(result == .OK ? panel.url : nil) }
        }
    }
}

struct ContentView: View {
    @ObservedObject var engine: Engine

    var body: some View {
        ZStack {
            Color(red: 0.067, green: 0.047, blue: 0.055).ignoresSafeArea()
            if let failure = engine.failure {
                VStack(spacing: 12) {
                    Text("NeuroClaw could not start").font(.title2).bold()
                    Text(failure).multilineTextAlignment(.center)
                    Text("Details are in ~/.neuroclaw/logs/server.log").font(.footnote).opacity(0.7)
                    Button("Quit") { NSApp.terminate(nil) }
                }
                .foregroundColor(Color(red: 0.97, green: 0.93, blue: 0.91))
                .padding(32)
            } else if engine.ready {
                WebView()
            } else {
                Text("Starting NeuroClaw...").foregroundColor(Color(red: 0.97, green: 0.93, blue: 0.91))
            }
        }
        .frame(minWidth: 480, minHeight: 360)
        .onAppear { engine.start() }
    }
}

@main
struct NeuroClawApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var engine = Engine.shared

    var body: some Scene {
        WindowGroup("NeuroClaw") {
            ContentView(engine: engine)
        }
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandMenu("Go") {
                Button("Reload") { NotificationCenter.default.post(name: .ncReload, object: nil) }.keyboardShortcut("r")
                Button("Settings") { NotificationCenter.default.post(name: .ncSettings, object: nil) }.keyboardShortcut(",")
            }
        }
    }
}
