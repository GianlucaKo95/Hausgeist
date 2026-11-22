import UIKit
import UserNotifications

extension Notification.Name {
    /// Tipp auf eine Freigabe-Mitteilung → Freigaben-Tab öffnen.
    static let hgOpenApprovals = Notification.Name("hgOpenApprovals")
}

/// Push-Nachrichten direkt vom Hausgeist (statt über die Home-Assistant-App).
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        // Freigeben/Ablehnen direkt in der Mitteilung – nur mit entsperrtem iPhone.
        let approve = UNNotificationAction(identifier: "APPROVE", title: "Freigeben", options: [.authenticationRequired])
        let reject = UNNotificationAction(identifier: "REJECT", title: "Ablehnen", options: [.destructive, .authenticationRequired])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "HG_DECISION", actions: [approve, reject], intentIdentifiers: [], options: []),
        ])
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in await PushRegistration.upload(token: token) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("Push-Registrierung fehlgeschlagen: \(error.localizedDescription)")
    }

    // Auch im Vordergrund anzeigen
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let actions = response.notification.request.content.userInfo["hg_actions"] as? [String] ?? []
        let id = response.actionIdentifier
        Task { @MainActor in
            if (id == "APPROVE" || id == "REJECT") && actions.count == 2 {
                let action = id == "APPROVE" ? actions[0] : actions[1]
                let message: String
                do {
                    message = try await APIClient(auth: AuthService()).pushAction(action).message
                } catch {
                    message = "Konnte nicht ausgeführt werden – bitte in der App prüfen. (\(error.localizedDescription))"
                }
                let content = UNMutableNotificationContent()
                content.title = "Hausgeist"
                content.body = message
                try? await UNUserNotificationCenter.current().add(
                    UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
            } else if !actions.isEmpty {
                NotificationCenter.default.post(name: .hgOpenApprovals, object: nil)
            }
            completionHandler()
        }
    }
}

@MainActor
enum PushRegistration {
    private static let key = "pushToken"

    static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    /// Erlaubnis einholen und beim System registrieren (bei jedem Start, wie von Apple empfohlen).
    static func requestAndRegister() async {
        guard !AppConfig.isDemo else { return }
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        guard granted else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    static func upload(token: String) async {
        UserDefaults.standard.set(token, forKey: key)
        let auth = AuthService()
        guard auth.isSignedIn, AppConfig.serverURL != nil else { return }
        try? await APIClient(auth: auth).registerDevice(token: token, environment: environment)
    }

    /// Nach dem Eintragen der Serveradresse erneut melden.
    static func uploadStored() async {
        if let t = UserDefaults.standard.string(forKey: key) { await upload(token: t) }
    }

    /// Beim Abmelden: Gerät beim Server austragen.
    static func unregister(auth: AuthService) async {
        guard let t = UserDefaults.standard.string(forKey: key), AppConfig.serverURL != nil else { return }
        try? await APIClient(auth: auth).unregisterDevice(token: t)
    }
}
