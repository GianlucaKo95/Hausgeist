import SwiftUI
import Combine

@main
struct HausgeistApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var auth = AuthService()

    var body: some Scene {
        WindowGroup {
            Group {
                if auth.isSignedIn {
                    RootView()
                } else {
                    LoginView()
                }
            }
            .environment(auth)
        }
    }
}

struct RootView: View {
    @Environment(AuthService.self) private var auth
    @State private var me: Me?
    @State private var openApprovals = 0
    @State private var tab = AppConfig.initialTab

    var body: some View {
        TabView(selection: $tab) {
            ChatView(me: me)
                .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right") }
                .tag("chat")
            if me?.role != "child" {
                ApprovalsView(onCount: { openApprovals = $0 })
                    .tabItem { Label("Freigaben", systemImage: "checkmark.shield") }
                    .badge(openApprovals)
                    .tag("approvals")
            }
            SettingsView(me: me, onConnected: { me = $0 })
                .tabItem { Label("Einstellungen", systemImage: "gearshape") }
                .tag("settings")
        }
        .task {
            await loadMe()
            await PushRegistration.requestAndRegister()
        }
        .onReceive(NotificationCenter.default.publisher(for: .hgOpenApprovals)) { _ in
            tab = "approvals"
        }
        // Widget „Mit Hausgeist sprechen“
        .onOpenURL { url in
            guard url.scheme == "hausgeist", url.host == "voice" else { return }
            tab = "chat"
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(300))
                NotificationCenter.default.post(name: .hgOpenVoice, object: nil)
            }
        }
    }

    private func loadMe() async {
        guard AppConfig.serverURL != nil || AppConfig.isDemo else { return }
        me = try? await APIClient(auth: auth).me()
    }
}
