// Prints the Mac's current location as JSON using CoreLocation (Wi-Fi positioning).
import CoreLocation
import Foundation

final class D: NSObject, CLLocationManagerDelegate {
    let m = CLLocationManager()
    override init() {
        super.init()
        m.delegate = self
        m.desiredAccuracy = kCLLocationAccuracyBest
    }
    func start() {
        if m.authorizationStatus == .notDetermined { m.requestWhenInUseAuthorization() }
        m.startUpdatingLocation()
    }
    var best: CLLocation?
    func locationManager(_ m: CLLocationManager, didUpdateLocations locs: [CLLocation]) {
        for l in locs where best == nil || l.horizontalAccuracy < best!.horizontalAccuracy { best = l }
        if let b = best, b.horizontalAccuracy <= 50 { finish() }
    }
    func locationManager(_ m: CLLocationManager, didFailWithError e: Error) {
        FileHandle.standardError.write("error: \(e.localizedDescription)\n".data(using: .utf8)!)
    }
    func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        FileHandle.standardError.write("auth: \(m.authorizationStatus.rawValue)\n".data(using: .utf8)!)
    }
    func finish() {
        guard let b = best else { exit(2) }
        print("{\"lat\":\(b.coordinate.latitude),\"lon\":\(b.coordinate.longitude),\"accuracy\":\(b.horizontalAccuracy)}")
        exit(0)
    }
}
let d = D()
d.start()
DispatchQueue.main.asyncAfter(deadline: .now() + 40) { d.finish() }
RunLoop.main.run()
