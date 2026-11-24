import SwiftUI

/// Bring!-Konto verbinden und Listen der Einkaufsliste zuordnen.
/// Direkt bei Bring! angemeldet sind Änderungen sofort sichtbar (Home Assistant fragt nur alle 90 s ab).
struct BringView: View {
    @Environment(AuthService.self) private var auth
    @State private var lists: [BringListConfig] = []
    @State private var email = ""
    @State private var password = ""
    @State private var passwordSet = false
    @State private var remote: [BringRemoteList] = []
    @State private var loaded = false
    @State private var supported = true
    @State private var busy = false
    @State private var error: String?
    @State private var info: String?

    private var connected: Bool { passwordSet && !remote.isEmpty }

    var body: some View {
        List {
            ErrorBanner(text: error)
            if !supported {
                Text("Bitte das Add-on auf Version 0.14.0 aktualisieren.").foregroundStyle(.secondary)
            } else {
                accountSection
                if !remote.isEmpty { listsSection }
            }
        }
        .navigationTitle("Einkaufslisten")
        .toolbar { if supported && !remote.isEmpty { Button("Sichern") { Task { await save() } }.disabled(busy) } }
        .task { await load() }
    }

    private var accountSection: some View {
        Section {
            TextField("E-Mail des Bring!-Kontos", text: $email)
                .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
            SecureField(passwordSet ? "Passwort (gespeichert)" : "Passwort", text: $password)
            Button {
                Task { await connect() }
            } label: {
                HStack { Text(connected ? "Neu verbinden" : "Mit Bring! verbinden"); if busy { Spacer(); ProgressView() } }
            }
            .disabled(busy || email.isEmpty || (password.isEmpty && !passwordSet))
            if let info { Text(info).font(.footnote).foregroundStyle(.secondary) }
        } header: {
            Text("Bring!-Konto")
        } footer: {
            Text("Hast du dich bei Bring! mit Google oder Apple angemeldet, lege in der Bring!-App unter Einstellungen → Konto ein Passwort fest. Das Passwort bleibt auf dem Pi.")
        }
    }

    private var listsSection: some View {
        Group {
            ForEach($lists) { $l in
                Section {
                    TextField("Name", text: $l.name)
                    Picker("Bring!-Liste", selection: Binding(
                        get: { l.list_uuid ?? "" },
                        set: { l.list_uuid = $0; l.entity_id = nil })) {
                        if l.list_uuid == nil { Text("bitte wählen").tag("") }
                        ForEach(remote) { r in Text(r.name).tag(r.listUuid) }
                    }
                    TextField("Läden, z. B. Rewe, Aldi, dm", text: Binding(
                        get: { l.stores.joined(separator: ", ") },
                        set: { l.stores = $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }))
                    Toggle("Standardliste", isOn: Binding(
                        get: { l.default },
                        set: { on in for i in lists.indices { lists[i].default = on && lists[i].id == l.id } }))
                    Button("Entfernen", role: .destructive) { lists.removeAll { $0.id == l.id } }
                }
            }
            Section {
                Menu {
                    ForEach(remote.filter { r in !lists.contains { $0.list_uuid == r.listUuid } }) { r in
                        Button(r.name) {
                            lists.append(BringListConfig(name: r.name, list_uuid: r.listUuid, entity_id: nil, stores: [], default: lists.isEmpty))
                        }
                    }
                } label: { Label("Bring!-Liste hinzufügen", systemImage: "plus") }
            } footer: {
                Text("Was ohne Laden oder für einen der genannten Läden auf die Einkaufsliste kommt, landet sofort in Bring! – auch per Siri oder aus dem Chat. Alles andere (z. B. Baumarkt) bleibt in der Hausgeist-Liste.")
            }
        }
    }

    private func load() async {
        do {
            let s = try await APIClient(auth: auth).adminSettings()
            supported = s.bring != nil
            lists = s.bring_lists ?? []
            email = s.bring?.email ?? ""
            passwordSet = s.bring?.password_set ?? false
            if passwordSet { remote = (try? await APIClient(auth: auth).testBring(email: email, password: nil)) ?? [] }
            error = nil
        } catch { self.error = error.localizedDescription }
        loaded = true
    }

    private func connect() async {
        busy = true; defer { busy = false }
        do {
            let api = APIClient(auth: auth)
            remote = try await api.testBring(email: email, password: password.isEmpty ? nil : password)
            try await api.saveSettings(SettingsPatch(bring: BringAccountSave(email: email, password: password.isEmpty ? nil : password)))
            if !password.isEmpty { passwordSet = true; password = "" }
            // Alte Home-Assistant-Zuordnungen auf Bring!-Listen gleichen Namens umstellen
            for i in lists.indices where lists[i].list_uuid == nil {
                if let r = remote.first(where: { $0.name.lowercased() == lists[i].name.lowercased() }) {
                    lists[i].list_uuid = r.listUuid; lists[i].entity_id = nil
                }
            }
            if lists.isEmpty, let first = remote.first {
                lists = [BringListConfig(name: first.name, list_uuid: first.listUuid, entity_id: nil, stores: [], default: true)]
            }
            info = "Verbunden – \(remote.count) Liste(n) gefunden. Zuordnung prüfen und sichern."
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        if lists.contains(where: { $0.name.trimmingCharacters(in: .whitespaces).isEmpty || ($0.list_uuid == nil && $0.entity_id == nil) }) {
            error = "Bitte jeder Liste einen Namen und eine Bring!-Liste geben."
            return
        }
        busy = true; defer { busy = false }
        do {
            try await APIClient(auth: auth).saveSettings(SettingsPatch(bring_lists: lists))
            info = "Gespeichert"
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}
