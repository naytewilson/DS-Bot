import AppKit
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var crew: CrewController!
    private var statusPanel: FabricStatusPanel?

    func applicationDidFinishLaunching(_ notification: Notification) {
        crew = CrewController()
        buildMenus()
        buildWindow()
        NSApp.activate()
        crew.start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    // MARK: Window

    private func buildWindow() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
                         // No .fullSizeContentView: the page keeps its own header clear of the
                         // traffic lights, and the transparent title bar shows the window colour.
                         styleMask: [.titled, .closable, .miniaturizable, .resizable],
                         backing: .buffered, defer: false)
        w.title = "ANVIL Crew"
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.isReleasedWhenClosed = false
        w.backgroundColor = Palette.background
        w.minSize = NSSize(width: 900, height: 600)
        w.contentView = crew.container
        if !w.setFrameUsingName("ANVILCrewMain") { w.center() }
        w.setFrameAutosaveName("ANVILCrewMain")
        w.makeKeyAndOrderFront(nil)
        window = w
    }

    // MARK: Menus

    private func item(_ title: String, _ action: Selector?, _ key: String = "",
                      mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.keyEquivalentModifierMask = key.isEmpty ? [] : mods
        i.target = target
        return i
    }

    private func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
        let menu = NSMenu(title: title)
        items.forEach { menu.addItem($0) }
        let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        holder.submenu = menu
        return holder
    }

    private func buildMenus() {
        let sep = { NSMenuItem.separator() }
        let name = "ANVIL Crew"

        let app = submenu(name, [
            item("About \(name)", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            sep(),
            item("Hide \(name)", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", mods: [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            sep(),
            item("Quit \(name)", #selector(NSApplication.terminate(_:)), "q"),
        ])

        let edit = submenu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", mods: [.command, .shift]),
            sep(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])

        let view = submenu("View", [
            item("Reload", #selector(reload), "r", target: self),
            item("Hard Reload", #selector(hardReload), "r", mods: [.command, .shift], target: self),
            sep(),
            item("Actual Size", #selector(zoomReset), "0", target: self),
            item("Zoom In", #selector(zoomIn), "+", target: self),
            item("Zoom Out", #selector(zoomOut), "-", target: self),
            sep(),
            item("Toggle Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", mods: [.command, .control]),
        ])

        let fabric = submenu("Fabric", [
            item("Open in Browser", #selector(openInBrowser), target: self),
            item("Copy Phone Link", #selector(copyPhoneLink), target: self),
            sep(),
            item("Fabric Status…", #selector(showFabricStatus), target: self),
        ])

        let windowMenu = submenu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            sep(),
            item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
        ])

        let main = NSMenu()
        [app, edit, view, fabric, windowMenu].forEach { main.addItem($0) }
        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu.submenu
    }

    // MARK: Actions

    @objc private func reload() { crew.reload() }
    @objc private func hardReload() { crew.hardReload() }
    @objc private func zoomReset() { crew.webView.pageZoom = 1.0 }
    @objc private func zoomIn() { crew.webView.pageZoom = min(3.0, crew.webView.pageZoom + 0.1) }
    @objc private func zoomOut() { crew.webView.pageZoom = max(0.3, crew.webView.pageZoom - 0.1) }

    @objc private func openInBrowser() {
        Task {
            let r = await Shell.dsbot("url")
            if r.ok, let url = URL(string: r.stdout), url.scheme == "http" {
                NSWorkspace.shared.open(url)
            } else {
                fail("Could not get the login URL", r.errorLine)
            }
        }
    }

    @objc private func copyPhoneLink() {
        Task {
            let r = await Shell.dsbot("phone")
            guard r.ok, !r.stdout.isEmpty else { return fail("Could not get the phone link", r.errorLine) }
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(r.stdout, forType: .string)
            // Ask clipboard managers not to record the secret.
            pb.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
        }
    }

    @objc private func showFabricStatus() {
        let panel = statusPanel ?? FabricStatusPanel()
        statusPanel = panel
        panel.refresh()
        panel.makeKeyAndOrderFront(nil)
    }

    private func fail(_ title: String, _ detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window)
    }
}
