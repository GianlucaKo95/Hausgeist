import SwiftUI

struct CalendarsAdminView: View {
    @Environment(AuthService.self) private var auth

    @State private var icloudUser = ""
    @State private var icloudPassword = ""
    @State private var passwordSet = false
    @State private var calendars: [CalendarOwner] = []
    @State private var feeds: [CalendarFeed] = []
    @State private var haCalendars: [HaCalendar] = []
    @State private var people: [Person] = []
    @State private var haCalendarEntities: [HAEntity] = []
    @State private var error: String?
    @State private var info: String?
    @State private var busy = false
    @State private var addingFeed = false
    @State private var newFeedName = ""
    @State private var newFeedURL = ""

    var body: some View {
        Form {
            ErrorBanner(text: error)
            if let info { Section { Label(info, systemImage: "checkmark.circle").foregroundStyle(.green) } }

            Section {
                TextField("Apple-ID", text: $icloudUser)
                    .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField(passwordSet ? "App-Passwort (unverändert lassen)" : "App-spezifisches Passwort", text: $icloudPassword)
                Button { Task { await connect() } } label: {
                    HStack { Text("Verbinden und Kalender laden"); if busy { Spacer(); ProgressView() } }
                }
                .disabled(busy || icloudUser.isEmpty || (!passwordSet && icloudPassword.isEmpty))
            } header: {
                Text("Apple-Kalender")
            } footer: {
                Text("Das App-Passwort erstellst du unter account.apple.com → Anmeldung und Sicherheit → App-spezifische Passwörter. Es gilt nur für den Kalenderzugriff.")
            }

            if !calendars.isEmpty {
                Section {
                    ForEach($calendars, id: \.name) { $cal in
                        OwnerPicker(title: cal.name, owner: $cal.owner, people: people)
                    }
                } header: {
                    Text("Wem gehört welcher Kalender?")
                } footer: {
                    Text("In eigene und gemeinsame Kalender trägt der Hausgeist direkt ein, in Kalender anderer nur nach Freigabe.")
                }
            }

            Section {
                ForEach($feeds) { $feed in
                    VStack(alignment: .leading) {
                        Text(feed.name)
                        Text(feed.url).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        OwnerPicker(title: "Gehört", owner: $feed.owner, people: people)
                    }
                }
                .onDelete { feeds.remove(atOffsets: $0) }
                Button("Abo hinzufügen", systemImage: "plus") { addingFeed = true }
            } header: {
                Text("Kalender-Abos (ICS)")
            } footer: {
                Text("Zum Beispiel der Abfuhrkalender der Wirtschaftsbetriebe Duisburg – den Abo-Link findest du beim Abfuhrkalender deiner Straße.")
            }

            if !haCalendarEntities.isEmpty {
                Section("Kalender aus Home Assistant") {
                    ForEach(haCalendarEntities) { e in
                        Toggle(e.name, isOn: Binding(
                            get: { haCalendars.contains { $0.entity_id == e.entity_id } },
                            set: { on in
                                if on { haCalendars.append(HaCalendar(name: e.name, entity_id: e.entity_id, owner: "shared")) }
                                else { haCalendars.removeAll { $0.entity_id == e.entity_id } }
                            }))
                    }
                }
            }

            Section {
                Button("Sichern") { Task { await save() } }.disabled(busy)
            }
        }
        .navigationTitle("Kalender")
        .task { await load() }
        .alert("Kalender-Abo", isPresented: $addingFeed) {
            TextField("Name, z. B. Abfall", text: $newFeedName)
            TextField("https://… oder webcal://…", text: $newFeedURL)
                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
            Button("Hinzufügen") {
                let n = newFeedName.trimmingCharacters(in: .whitespaces), u = newFeedURL.trimmingCharacters(in: .whitespaces)
                if !n.isEmpty && !u.isEmpty { feeds.append(CalendarFeed(name: n, url: u, owner: "shared")) }
                newFeedName = ""; newFeedURL = ""
            }
            Button("Abbrechen", role: .cancel) { newFeedName = ""; newFeedURL = "" }
        }
    }

    private func load() async {
        let api = APIClient(auth: auth)
        do {
            let s = try await api.adminSettings()
            icloudUser = s.icloud_user; passwordSet = s.icloud_password_set
            calendars = s.calendars; feeds = s.calendar_feeds; haCalendars = s.ha_calendars
            people = (try? await api.people()) ?? []
            haCalendarEntities = ((try? await api.haEntities()) ?? []).filter { $0.domain == "calendar" }
        } catch { self.error = error.localizedDescription }
    }

    private func connect() async {
        busy = true; defer { busy = false }
        error = nil; info = nil
        do {
            let names = try await APIClient(auth: auth).testICloud(user: icloudUser, password: icloudPassword)
            // Bekannte Zuordnungen behalten, neue Kalender zunächst als gemeinsam
            calendars = names.map { n in calendars.first { $0.name == n } ?? CalendarOwner(name: n, owner: "shared") }
            // Funktionierende Zugangsdaten sofort speichern – sonst arbeitet der Hausgeist mit den alten weiter.
            try await APIClient(auth: auth).saveSettings(SettingsPatch(
                icloud_user: icloudUser, icloud_app_password: icloudPassword.isEmpty ? nil : icloudPassword,
                calendars: calendars))
            if !icloudPassword.isEmpty { passwordSet = true; icloudPassword = "" }
            info = "\(names.count) Kalender gefunden und Zugang gespeichert – jetzt noch Besitzer festlegen und sichern."
        } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        busy = true; defer { busy = false }
        error = nil
        do {
            try await APIClient(auth: auth).saveSettings(SettingsPatch(
                icloud_user: icloudUser, icloud_app_password: icloudPassword.isEmpty ? nil : icloudPassword,
                calendars: calendars, calendar_feeds: feeds, ha_calendars: haCalendars))
            if !icloudPassword.isEmpty { passwordSet = true; icloudPassword = "" }
            info = "Gespeichert"
        } catch { self.error = error.localizedDescription }
    }
}
