// InkBoard Helper — a tiny background app so macOS can grant Calendar, Location,
// Automation (Mail) and Downloads access, which command-line tools cannot request.
// Usage: open -g -j -a "InkBoard Helper" --args <events|location|mail|notes> <output.json> [days]
import AppKit
import CoreLocation
import EventKit
import Foundation

let args = CommandLine.arguments
let cmd = args.count > 1 ? args[1] : "events"
let outPath = args.count > 2 ? args[2] : NSString(string: "~/.inkboard/state/\(cmd).json").expandingTildeInPath
let extra = args.count > 3 ? args[3] : ""
let iso = ISO8601DateFormatter()

func finish(_ obj: Any) {
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("{}".utf8)
    try? FileManager.default.createDirectory(atPath: (outPath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try? data.write(to: URL(fileURLWithPath: outPath + ".tmp"))
    try? FileManager.default.removeItem(atPath: outPath)
    try? FileManager.default.moveItem(atPath: outPath + ".tmp", toPath: outPath)
    exit(0)
}
func fail(_ msg: String) { finish(["error": msg]) }

// ------------------------------------------------------------ calendar
func runEvents() {
    let store = EKEventStore()
    let days = Double(extra) ?? 8
    let handler: (Bool, Error?) -> Void = { granted, err in
        guard granted else { fail("calendar access denied: \(err?.localizedDescription ?? "")"); return }
        let start = Date().addingTimeInterval(-12 * 3600), end = Date().addingTimeInterval(days * 86400)
        let cals = store.calendars(for: .event)
        let pred = store.predicateForEvents(withStart: start, end: end, calendars: cals)
        let evs = store.events(matching: pred).sorted { $0.startDate < $1.startDate }.prefix(300).map { e -> [String: Any] in
            var d: [String: Any] = ["title": e.title ?? "", "start": iso.string(from: e.startDate), "end": iso.string(from: e.endDate),
                                    "allDay": e.isAllDay, "calendar": e.calendar.title, "account": e.calendar.source.title]
            if let l = e.location, !l.isEmpty { d["location"] = l }
            if e.availability == .free { d["free"] = true }
            return d
        }
        finish(["events": Array(evs), "calendars": cals.map { "\($0.source.title)/\($0.title)" }])
    }
    if #available(macOS 14.0, *) { store.requestFullAccessToEvents(completion: handler) }
    else { store.requestAccess(to: .event, completion: handler) }
}

// ------------------------------------------------------------ location
final class Loc: NSObject, CLLocationManagerDelegate {
    let m = CLLocationManager()
    var best: CLLocation?
    func start() {
        m.delegate = self
        m.desiredAccuracy = kCLLocationAccuracyBest
        m.requestWhenInUseAuthorization()
        m.startUpdatingLocation()
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) { self.done() }
    }
    func locationManager(_ m: CLLocationManager, didUpdateLocations locs: [CLLocation]) {
        for l in locs where best == nil || l.horizontalAccuracy < best!.horizontalAccuracy { best = l }
        if let b = best, b.horizontalAccuracy <= 65 { done() }
    }
    func locationManager(_ m: CLLocationManager, didFailWithError e: Error) {
        if (e as? CLError)?.code == .denied { fail("location access denied") }
    }
    func done() {
        guard let b = best else { fail("no location fix"); return }
        finish(["lat": b.coordinate.latitude, "lon": b.coordinate.longitude, "accuracy": b.horizontalAccuracy, "at": iso.string(from: b.timestamp)])
    }
}
let loc = Loc()

// ------------------------------------------------------------ mail (Apple Mail via Apple Events)
func runMail() {
    let days = Int(extra) ?? 3
    // The AppleScript lives next to the app (~/.inkboard/mail.applescript) so it can be tuned without
    // rebuilding — a rebuild changes the ad-hoc signature and macOS forgets every permission.
    let file = (Bundle.main.bundlePath as NSString).deletingLastPathComponent + "/mail.applescript"
    guard let tpl = try? String(contentsOfFile: file, encoding: .utf8) else { fail("missing \(file)"); return }
    let src = tpl.replacingOccurrences(of: "{{DAYS}}", with: String(days))
    var err: NSDictionary?
    guard let script = NSAppleScript(source: src) else { fail("script compile failed"); return }
    let res = script.executeAndReturnError(&err)
    if let e = err { fail("mail: \(e[NSAppleScript.errorMessage] ?? e)"); return }
    let text = res.stringValue ?? ""
    let mails = text.components(separatedBy: "\u{1e}").compactMap { rec -> [String: Any]? in
        let f = rec.components(separatedBy: "\u{1f}")
        guard f.count >= 6, !f[0].isEmpty else { return nil }
        return ["id": f[0], "sender": f[1], "subject": f[2], "received": f[3], "read": f[4] == "true",
                "snippet": f[5].replacingOccurrences(of: "\r", with: "\n").components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")]
    }
    finish(["mails": mails])
}

// ------------------------------------------------------------ research notes (Downloads)
func runNotes() {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let roots = extra.isEmpty ? ["\(home)/Downloads"] : extra.components(separatedBy: ":")
    let skip = ["node_modules", ".git", "eink-dashboard", "WhalePartner", "01_个人重要资料", "07_音视频媒体", "08_安装包应用与压缩包", "09_书籍娱乐生活", "Library"]
    let cutoff = Date().addingTimeInterval(-21 * 86400)
    var found: [(String, Date)] = []
    for root in roots {
        guard let en = FileManager.default.enumerator(at: URL(fileURLWithPath: root), includingPropertiesForKeys: [.contentModificationDateKey, .isDirectoryKey], options: [.skipsHiddenFiles]) else { continue }
        for case let url as URL in en {
            if skip.contains(url.lastPathComponent) { en.skipDescendants(); continue }
            if en.level > 3 { en.skipDescendants(); continue }
            guard ["md", "txt", "tex"].contains(url.pathExtension.lowercased()) else { continue }
            let mtime = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            if mtime > cutoff { found.append((url.path, mtime)) }
        }
    }
    found.sort { $0.1 > $1.1 }
    let notes = found.prefix(12).compactMap { (path, mtime) -> [String: Any]? in
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        return ["name": (path as NSString).lastPathComponent, "path": path.replacingOccurrences(of: home, with: "~"), "mtime": iso.string(from: mtime), "excerpt": String(text.prefix(1500))]
    }
    finish(["notes": notes])
}

NSApplication.shared.setActivationPolicy(.prohibited)
switch cmd {
case "events": runEvents()
case "location": loc.start()
case "mail": runMail()
case "notes": runNotes()
default: fail("unknown command \(cmd)")
}
DispatchQueue.main.asyncAfter(deadline: .now() + 120) { fail("timeout") }
RunLoop.main.run()
