import AppKit
import WebKit

/// Owns the web view, sign-in flow, unreachable state and all WebKit delegates.
@MainActor
final class CrewController: NSObject {
    static let defaultBase = "http://127.0.0.1:3080/"
    static let tunnelLabel = "com.anvil.dsh-fabric-tunnel"

    let baseURL: URL
    let webView: WKWebView
    let statusView = StatusView()
    let container = NSView()

    private var lastTokenAttempt: Date?
    private var retryTimer: Timer?
    private var statusRefreshInFlight = false
    private var downloadTargets: [ObjectIdentifier: URL] = [:]

    override init() {
        let env = ProcessInfo.processInfo.environment["ANVIL_CREW_URL"]
        baseURL = env.flatMap(URL.init(string:)) ?? URL(string: Self.defaultBase)!

        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.applicationNameForUserAgent = "ANVILCrew/\(version)"
        // Inspect Element in the context menu (private pref, guarded so a missing key cannot throw).
        if config.preferences.responds(to: NSSelectorFromString("_setDeveloperExtrasEnabled:")) {
            config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        }
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()

        webView.isInspectable = true
        webView.allowsBackForwardNavigationGestures = false
        webView.underPageBackgroundColor = Palette.background
        // No white flash before first paint.
        if webView.responds(to: NSSelectorFromString("_setDrawsBackground:")) {
            webView.setValue(false, forKey: "drawsBackground")
        }
        webView.navigationDelegate = self
        webView.uiDelegate = self

        container.wantsLayer = true
        container.layer?.backgroundColor = Palette.background.cgColor
        for v in [webView, statusView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(v)
            NSLayoutConstraint.activate([
                v.leadingAnchor.constraint(equalTo: container.leadingAnchor),
                v.trailingAnchor.constraint(equalTo: container.trailingAnchor),
                v.topAnchor.constraint(equalTo: container.topAnchor),
                v.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            ])
        }
        statusView.isHidden = true
        statusView.onRetry = { [weak self] in self?.retry() }
        statusView.onRestartTunnel = { [weak self] in self?.restartTunnel() }
    }

    // MARK: Loading

    func start() { load(baseURL) }

    func load(_ url: URL, ignoreCache: Bool = false) {
        var req = URLRequest(url: url)
        if ignoreCache { req.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData }
        webView.load(req)
    }

    func reload() {
        if !statusView.isHidden || webView.url == nil { load(baseURL) } else { webView.reload() }
    }

    func hardReload() {
        lastTokenAttempt = nil
        load(baseURL, ignoreCache: true)
    }

    func retry() {
        load(baseURL)
    }

    // MARK: Sign-in

    private func handleUnauthorized() {
        if let last = lastTokenAttempt, Date().timeIntervalSince(last) < 30 {
            showStatus(reason: "The server still answers 401 after sign-in. Retrying automatically.")
            return
        }
        lastTokenAttempt = Date()
        Task { [weak self] in
            let r = await Shell.dsbot("url")
            guard let self else { return }
            guard r.ok, let url = URL(string: r.stdout), self.isLocal(url) else {
                self.showStatus(reason: r.ok ? "dsbot returned an unusable sign-in URL." : "Sign-in failed: \(r.errorLine)")
                return
            }
            self.load(url)
        }
    }

    // MARK: Status view

    func showStatus(reason: String) {
        statusView.setReason(reason)
        statusView.isHidden = false
        if retryTimer == nil {
            retryTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.retry() }
            }
        }
        refreshStatusOutput()
    }

    private func hideStatus() {
        guard !statusView.isHidden else { return }
        statusView.isHidden = true
        retryTimer?.invalidate()
        retryTimer = nil
    }

    private func refreshStatusOutput() {
        guard !statusRefreshInFlight else { return }
        statusRefreshInFlight = true
        Task { [weak self] in
            let r = await Shell.dsbot("status")
            guard let self else { return }
            self.statusRefreshInFlight = false
            let text = r.stdout.isEmpty ? (r.stderr.isEmpty ? "dsbot status: no output (exit \(r.status))" : r.stderr) : r.stdout
            self.statusView.setOutput(text)
        }
    }

    func restartTunnel() {
        statusView.setBusy(true)
        let target = "gui/\(getuid())/\(Self.tunnelLabel)"
        Task { [weak self] in
            let r = await Shell.run("/bin/launchctl", ["kickstart", "-k", target], timeout: 15)
            if !r.ok { self?.statusView.setReason("Restart tunnel failed: \(r.errorLine)") }
            try? await Task.sleep(for: .seconds(2))
            self?.statusView.setBusy(false)
            self?.retry()
        }
    }

    // MARK: Helpers

    private func isLocal(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return host == "127.0.0.1" || host == "localhost"
    }

    private func isOwnOrigin(_ url: URL) -> Bool {
        url.scheme == baseURL.scheme && url.host == baseURL.host && (url.port ?? 80) == (baseURL.port ?? 80)
    }

    private func friendly(_ error: Error) -> String {
        let ns = error as NSError
        let hostPort = "\(baseURL.host ?? "?"):\(baseURL.port ?? 80)"
        switch ns.code {
        case NSURLErrorCannotConnectToHost: return "Connection refused at \(hostPort). The tunnel may be down."
        case NSURLErrorTimedOut: return "Timed out connecting to \(hostPort)."
        case NSURLErrorNetworkConnectionLost: return "Connection to \(hostPort) was lost."
        default: return ns.localizedDescription
        }
    }

    private func sheet(_ alert: NSAlert) async -> NSApplication.ModalResponse {
        if let w = webView.window { return await alert.beginSheetModal(for: w) }
        return alert.runModal()
    }

    private func uniqueDownloadURL(_ name: String) -> URL {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory() + "/Downloads")
        let safe = name.replacingOccurrences(of: "/", with: "_").trimmingCharacters(in: .whitespaces)
        let base = safe.isEmpty ? "download" : safe
        var candidate = dir.appendingPathComponent(base)
        let stem = candidate.deletingPathExtension().lastPathComponent
        let ext = candidate.pathExtension
        var n = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = dir.appendingPathComponent(ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)")
            n += 1
        }
        return candidate
    }
}

// MARK: - WKNavigationDelegate

extension CrewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        if navigationAction.shouldPerformDownload { return .download }
        guard let url = navigationAction.request.url else { return .allow }
        let scheme = url.scheme?.lowercased() ?? ""
        let isMain = navigationAction.targetFrame?.isMainFrame ?? true
        guard isMain else { return .allow }
        if ["about", "blob", "data"].contains(scheme) { return .allow }
        if ["http", "https"].contains(scheme) {
            if isLocal(url) { return .allow }
            NSWorkspace.shared.open(url)
            return .cancel
        }
        if ["mailto", "tel", "facetime", "sms"].contains(scheme) {
            NSWorkspace.shared.open(url)
        }
        return .cancel
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        guard navigationResponse.isForMainFrame else { return .allow }
        if let http = navigationResponse.response as? HTTPURLResponse {
            if http.statusCode == 401 {
                handleUnauthorized()
                return .cancel
            }
            if [502, 503, 504].contains(http.statusCode) {
                showStatus(reason: "The server answered HTTP \(http.statusCode).")
                return .cancel
            }
            if http.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") == true {
                return .download
            }
            hideStatus()
        }
        return navigationResponse.canShowMIMEType ? .allow : .download
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleFailure(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleFailure(error)
    }

    private func handleFailure(_ error: Error) {
        let ns = error as NSError
        // Cancelled (our own policy decisions) and "frame load interrupted" (downloads) are not failures.
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return }
        showStatus(reason: friendly(error))
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

// MARK: - WKUIDelegate

extension CrewController: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if isOwnOrigin(url) {
            webView.load(navigationAction.request)
        } else if ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        _ = await sheet(alert)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async -> Bool {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        return await sheet(alert) == .alertFirstButtonReturn
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        let alert = NSAlert()
        alert.messageText = prompt
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        return await sheet(alert) == .alertFirstButtonReturn ? field.stringValue : nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        let response: NSApplication.ModalResponse
        if let w = webView.window { response = await panel.beginSheetModal(for: w) } else { response = panel.runModal() }
        return response == .OK ? panel.urls : nil
    }

    // Async form of webView(_:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:).
    func webView(_ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin,
                 initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
        var comps = URLComponents()
        comps.scheme = origin.protocol
        comps.host = origin.host
        comps.port = origin.port == 0 ? nil : origin.port
        guard type == .microphone, let url = comps.url, isOwnOrigin(url) else { return .deny }
        return .grant
    }
}

// MARK: - WKDownloadDelegate

extension CrewController: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String) async -> URL? {
        let url = uniqueDownloadURL(suggestedFilename)
        downloadTargets[ObjectIdentifier(download)] = url
        return url
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let url = downloadTargets.removeValue(forKey: ObjectIdentifier(download)) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadTargets.removeValue(forKey: ObjectIdentifier(download))
        let alert = NSAlert()
        alert.messageText = "Download failed"
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "OK")
        Task { _ = await self.sheet(alert) }
    }
}
