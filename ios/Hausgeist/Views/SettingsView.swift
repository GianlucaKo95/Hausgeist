import SwiftUI

struct SettingsView: View {
    @Environment(AuthService.self) private var auth
    let me: Me?
    var onConnected: (Me) -> Void = { _ in }

    @State private var server = AppConfig.serverURL?.absoluteString ?? ""
    @State private var status: String?
    @State private var checking = false
    @AppStorage("speakReplies") private var speakReplies = false
    @AppStorage(LocationService.enabledKey) private var shareLocation = false
    /// Nur für Screenshots im Demo-Modus: direkt eine Verwaltungsseite öffnen.
    @State private var demoScreen: String? = AppConfig.isDemo ? AppConfig.launchArg("-admin") : nil

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Angemeldet als", value: me?.name ?? auth.session?.email ?? "—")
                    if let role = me?.role { LabeledContent("Rolle", value: roleName(role)) }
                }
                Section {
                    TextField("http://homeassistant.tailXXXX.ts.net:8099", text: $server)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button {
                        Task { await saveAndCheck() }
                    } label: {
                        if checking { ProgressView() } else { Text("Speichern und testen") }
                    }
                    if let status { Text(status).font(.footnote).foregroundStyle(.secondary) }
                } header: {
                    Text("Server")
                } footer: {
                    Text("Adresse des Hausgeists, z. B. https://homegeist.heimdns.de")
                }
                AdminSection(me: me)
                Section {
                    NavigationLink { MemoriesView() } label: { Label("Was der Hausgeist über mich weiß", systemImage: "brain") }
                } footer: {
                    Text("Der Hausgeist merkt sich beim Chatten Wichtiges über dich und nutzt es in jedem Gespräch. Hier kannst du einzelne Punkte oder alles löschen.")
                }
                Section {
                    Toggle("Standort für Erinnerungen", isOn: $shareLocation)
                        .onChange(of: shareLocation) {
                            if shareLocation { LocationService.shared.start() } else { LocationService.shared.stop() }
                        }
                } header: {
                    Text("Standort")
                } footer: {
                    Text("Für „Erinnere mich, wenn ich das Haus verlasse“ und „Jetzt losfahren zu Termin XY“. Bitte „Immer“ erlauben. Die App meldet nur größere Ortswechsel und das Betreten/Verlassen eurer Orte aus Home Assistant – akkuschonend. Gespeichert wird nur der letzte Standort, auf dem Pi.")
                }
                Section {
                    Toggle("Antworten vorlesen", isOn: $speakReplies)
                } header: {
                    Text("Sprache")
                } footer: {
                    Text("Im Gesprächsmodus (Wellen-Symbol im Chat) liest der Hausgeist immer vor. Mit Siri: „Hey Siri, frag Hausgeist“ – auch im Auto über CarPlay.")
                }
                Section {
                    Button("Abmelden", role: .destructive) {
                        Task {
                            await PushRegistration.unregister(auth: auth)
                            await auth.signOut()
                        }
                    }
                }
            }
            .navigationTitle("Einstellungen")
            .navigationDestination(item: $demoScreen) { screen in
                switch screen {
                case "people": PeopleView()
                case "calendars": CalendarsAdminView()
                case "accounts": AccountsView()
                case "smarthome": SmartHomeView()
                case "routines": RoutinesView()
                case "bring": BringView()
                case "network": NetworkPcView()
                default: MailboxesView(me: me ?? Me(id: "u1", name: "Gianluca", role: "admin"))
                }
            }
        }
    }

    private func roleName(_ r: String) -> String {
        switch r {
        case "admin": return "Admin"
        case "adult": return "Erwachsen"
        case "child": return "Kind"
        default: return r
        }
    }

    private func saveAndCheck() async {
        let trimmed = server.trimmingCharacters(in: .whitespaces)
        guard let url = URL(string: trimmed), url.scheme != nil, url.host() != nil else {
            status = "Ungültige Adresse"
            return
        }
        AppConfig.serverURL = url
        checking = true
        defer { checking = false }
        do {
            let me = try await APIClient(auth: auth).me()
            status = "Verbunden als \(me.name)"
            onConnected(me)
            await PushRegistration.uploadStored()
        } catch {
            status = error.localizedDescription
        }
    }
}
