import AppKit

// A task-owned GUI with no accounts, network requests, or user documents.
final class VerificationApp: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var editor: NSTextView!
    let output = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("saved.txt")

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "Quit Verification", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let fileItem = NSMenuItem()
        menu.addItem(fileItem)
        let fileMenu = NSMenu(title: "File")
        fileItem.submenu = fileMenu
        let saveItem = NSMenuItem(title: "Save", action: #selector(save(_:)), keyEquivalent: "s")
        saveItem.target = self
        fileMenu.addItem(saveItem)
        fileMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let editItem = NSMenuItem()
        menu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        NSApp.mainMenu = menu

        window = NSWindow(contentRect: NSRect(x: 240, y: 240, width: 640, height: 380),
            styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "LCU Auto Verification"
        let scroll = NSScrollView(frame: NSRect(x: 20, y: 70, width: 600, height: 290))
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        editor = NSTextView(frame: scroll.bounds)
        editor.isRichText = false
        editor.font = NSFont.monospacedSystemFont(ofSize: 18, weight: .regular)
        editor.string = "LCU_AUTO_FIXTURE_BEFORE\n"
        editor.setAccessibilityIdentifier("lcu-auto-editor")
        scroll.documentView = editor
        window.contentView?.addSubview(scroll)
        let button = NSButton(title: "Save verification text", target: self, action: #selector(save(_:)))
        button.frame = NSRect(x: 20, y: 20, width: 240, height: 32)
        button.bezelStyle = .rounded
        button.setAccessibilityIdentifier("lcu-auto-save")
        window.contentView?.addSubview(button)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(editor)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func save(_ sender: Any?) {
        do { try editor.string.write(to: output, atomically: true, encoding: .utf8) }
        catch { NSLog("Verification save failed: %@", error.localizedDescription) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let application = NSApplication.shared
let delegate = VerificationApp()
application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()
