import AppIntents

/// „Hey Siri, frag Hausgeist …“ – funktioniert auch über CarPlay und die Apple Watch.
struct AskHausgeistIntent: AppIntent {
    static var title: LocalizedStringResource = "Hausgeist fragen"
    static var description = IntentDescription("Stellt dem Hausgeist eine Frage oder gibt ihm einen Auftrag.")
    static var openAppWhenRun = false

    @Parameter(title: "Anliegen", requestValueDialog: IntentDialog("Was soll ich für dich tun?"))
    var question: String

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        let auth = AuthService()
        guard auth.isSignedIn else {
            return .result(value: "", dialog: "Bitte melde dich zuerst in der Hausgeist-App an.")
        }
        guard AppConfig.serverURL != nil || AppConfig.isDemo else {
            return .result(value: "", dialog: "Bitte trag in der Hausgeist-App die Serveradresse ein.")
        }
        // Dauert es länger als 20 Sekunden, kommt die Antwort als Mitteilung.
        let reply = try await APIClient(auth: auth).chat(question, pushIfSlow: true)
        let spoken = Speaker.plain(reply)
        return .result(value: reply, dialog: "\(spoken)")
    }
}

struct HausgeistShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskHausgeistIntent(),
            phrases: [
                "Frag \(.applicationName)",
                "\(.applicationName) fragen",
                "Sag \(.applicationName) Bescheid",
            ],
            shortTitle: "Hausgeist fragen",
            systemImageName: "house.lodge"
        )
    }
}
