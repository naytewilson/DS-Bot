import AppKit

enum Palette {
    static let background = NSColor(srgbRed: 0x0E / 255.0, green: 0x10 / 255.0, blue: 0x12 / 255.0, alpha: 1)
    static let panel = NSColor(srgbRed: 0x17 / 255.0, green: 0x1A / 255.0, blue: 0x1D / 255.0, alpha: 1)
    static let ember = NSColor(srgbRed: 1.0, green: 0x7A / 255.0, blue: 0x1A / 255.0, alpha: 1)
    static let text = NSColor(srgbRed: 0xE6 / 255.0, green: 0xE8 / 255.0, blue: 0xEA / 255.0, alpha: 1)
    static let dim = NSColor(srgbRed: 0x9A / 255.0, green: 0xA0 / 255.0, blue: 0xA6 / 255.0, alpha: 1)
}

/// Native "can't reach the server" view shown over the web view.
@MainActor
final class StatusView: NSView {
    var onRetry: (() -> Void)?
    var onRestartTunnel: (() -> Void)?

    private let reasonLabel = NSTextField(wrappingLabelWithString: "")
    private let outputView = NSTextView()
    private let retryButton = NSButton(title: "Retry", target: nil, action: nil)
    private let tunnelButton = NSButton(title: "Restart tunnel", target: nil, action: nil)

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = Palette.background.cgColor
        build()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        let mark = NSImageView()
        mark.image = NSApp.applicationIconImage
        mark.imageScaling = .scaleProportionallyUpOrDown
        mark.translatesAutoresizingMaskIntoConstraints = false
        mark.widthAnchor.constraint(equalToConstant: 84).isActive = true
        mark.heightAnchor.constraint(equalToConstant: 84).isActive = true

        let title = NSTextField(labelWithString: "ANVIL Crew")
        title.font = .systemFont(ofSize: 22, weight: .semibold)
        title.textColor = Palette.text

        reasonLabel.font = .systemFont(ofSize: 13)
        reasonLabel.textColor = Palette.dim
        reasonLabel.alignment = .center
        reasonLabel.maximumNumberOfLines = 2
        reasonLabel.preferredMaxLayoutWidth = 520

        outputView.isEditable = false
        outputView.isSelectable = true
        outputView.drawsBackground = true
        outputView.backgroundColor = Palette.panel
        outputView.textColor = Palette.text
        outputView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        outputView.textContainerInset = NSSize(width: 10, height: 8)
        outputView.string = "Checking fabric…"

        let scroll = NSScrollView()
        scroll.documentView = outputView
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.wantsLayer = true
        scroll.layer?.cornerRadius = 8
        scroll.layer?.masksToBounds = true
        scroll.layer?.borderWidth = 1
        scroll.layer?.borderColor = NSColor.white.withAlphaComponent(0.08).cgColor
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.widthAnchor.constraint(equalToConstant: 560).isActive = true
        scroll.heightAnchor.constraint(equalToConstant: 150).isActive = true

        retryButton.target = self
        retryButton.action = #selector(retryTapped)
        retryButton.keyEquivalent = "\r"
        retryButton.bezelColor = Palette.ember
        tunnelButton.target = self
        tunnelButton.action = #selector(tunnelTapped)
        let buttons = NSStackView(views: [retryButton, tunnelButton])
        buttons.spacing = 12

        let stack = NSStackView(views: [mark, title, reasonLabel, scroll, buttons])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.setCustomSpacing(4, after: mark)
        stack.setCustomSpacing(20, after: reasonLabel)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    func setReason(_ text: String) { reasonLabel.stringValue = text }

    func setOutput(_ text: String) {
        outputView.string = text.isEmpty ? "(no output)" : text
        outputView.textColor = Palette.text
        outputView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
    }

    func setBusy(_ busy: Bool) {
        retryButton.isEnabled = !busy
        tunnelButton.isEnabled = !busy
    }

    @objc private func retryTapped() { onRetry?() }
    @objc private func tunnelTapped() { onRestartTunnel?() }
}

/// Small monospaced panel for "Fabric Status…".
@MainActor
final class FabricStatusPanel: NSPanel {
    private let textView = NSTextView()

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 620, height: 260),
                   styleMask: [.titled, .closable, .resizable, .utilityWindow],
                   backing: .buffered, defer: false)
        title = "Fabric Status"
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        backgroundColor = Palette.panel
        textView.isEditable = false
        textView.drawsBackground = true
        textView.backgroundColor = Palette.panel
        textView.textColor = Palette.text
        textView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        textView.textContainerInset = NSSize(width: 12, height: 10)
        let scroll = NSScrollView()
        scroll.documentView = textView
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        contentView = scroll
        center()
    }

    func refresh() {
        textView.string = "Checking fabric…"
        Task { [weak self] in
            let r = await Shell.dsbot("status")
            let text = r.stdout.isEmpty ? (r.stderr.isEmpty ? "(no output, exit \(r.status))" : r.stderr) : r.stdout
            self?.textView.string = text
            self?.textView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
            self?.textView.textColor = Palette.text
        }
    }
}
