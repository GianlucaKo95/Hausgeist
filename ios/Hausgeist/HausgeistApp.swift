import SwiftUI

@main
struct HausgeistApp: App {
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

    var body: some View {
        TabView {
            ChatView(me: me)
                .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right") }
            if me?.role != "child" {
                ApprovalsView(onCount: { openApprovals = $0 })
                    .tabItem { Label("Freigaben", systemImage: "checkmark.shield") }
                    .badge(openApprovals)
            }
            SettingsView(me: me, onConnected: { me = $0 })
                .tabItem { Label("Einstellungen", systemImage: "gearshape") }
        }
        .task { await loadMe() }
    }

    private func loadMe() async {
        guard AppConfig.serverURL != nil else { return }
        me = try? await APIClient(auth: auth).me()
    }
}
