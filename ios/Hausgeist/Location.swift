import CoreLocation
import UIKit

/// Standort für Orts-Erinnerungen und „Jetzt losfahren“ – direkt aus der App, ohne VPN.
/// Akkuschonend: nur größere Ortswechsel (ca. 500 m) und Geofences für eure Orte aus Home Assistant.
@MainActor
final class LocationService: NSObject, CLLocationManagerDelegate {
    static let shared = LocationService()
    static let enabledKey = "shareLocation"

    private let manager = CLLocationManager()
    private var lastSent: Date = .distantPast

    var isEnabled: Bool { UserDefaults.standard.bool(forKey: Self.enabledKey) }
    var authorization: CLAuthorizationStatus { manager.authorizationStatus }

    override init() {
        super.init()
        manager.delegate = self
        manager.allowsBackgroundLocationUpdates = true
        manager.pausesLocationUpdatesAutomatically = true
    }

    /// Beim App-Start und nach dem Einschalten in den Einstellungen.
    func start() {
        guard isEnabled, !AppConfig.isDemo else { return }
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse: manager.requestAlwaysAuthorization()
        default: break
        }
        manager.startMonitoringSignificantLocationChanges()
        Task { await refreshRegions() }
    }

    func stop() {
        manager.stopMonitoringSignificantLocationChanges()
        for r in manager.monitoredRegions { manager.stopMonitoring(for: r) }
        Task { try? await APIClient(auth: AuthService()).clearLocation() }
    }

    /// Orte (Zonen) vom Hausgeist holen und als Geofences überwachen (iOS erlaubt max. 20).
    func refreshRegions() async {
        guard isEnabled, AppConfig.serverURL != nil, CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }
        guard let list = try? await APIClient(auth: AuthService()).places() else { return }
        for r in manager.monitoredRegions { manager.stopMonitoring(for: r) }
        for p in list.prefix(19) {
            let region = CLCircularRegion(center: CLLocationCoordinate2D(latitude: p.lat, longitude: p.lon),
                                          radius: max(100, min(p.radius, manager.maximumRegionMonitoringDistance)),
                                          identifier: p.name)
            region.notifyOnEntry = true
            region.notifyOnExit = true
            manager.startMonitoring(for: region)
        }
    }

    // MARK: Delegate

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            if manager.authorizationStatus == .authorizedWhenInUse && self.isEnabled { manager.requestAlwaysAuthorization() }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        Task { @MainActor in await self.send(loc) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        Task { @MainActor in await self.sendZone(region.identifier, event: "enter") }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        Task { @MainActor in await self.sendZone(region.identifier, event: "leave") }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}

    // MARK: Senden (auch im Hintergrund)

    private func send(_ loc: CLLocation) async {
        guard isEnabled, AppConfig.serverURL != nil, Date().timeIntervalSince(lastSent) > 60 else { return }
        lastSent = Date()
        let bg = UIApplication.shared.beginBackgroundTask(withName: "Hausgeist-Standort")
        defer { UIApplication.shared.endBackgroundTask(bg) }
        try? await APIClient(auth: AuthService()).sendLocation(lat: loc.coordinate.latitude, lon: loc.coordinate.longitude,
                                                              accuracy: loc.horizontalAccuracy)
    }

    private func sendZone(_ zone: String, event: String) async {
        guard isEnabled, AppConfig.serverURL != nil else { return }
        let bg = UIApplication.shared.beginBackgroundTask(withName: "Hausgeist-Ort")
        defer { UIApplication.shared.endBackgroundTask(bg) }
        try? await APIClient(auth: AuthService()).sendZoneEvent(zone: zone, event: event)
    }
}
