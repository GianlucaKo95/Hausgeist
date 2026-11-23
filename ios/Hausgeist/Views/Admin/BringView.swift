import SwiftUI

/// Bring!-Listen aus Home Assistant der Einkaufsliste zuordnen.
struct BringView: View {
    @Environment(AuthService.self) private var auth
    @State private var lists: [BringListConfig] = []
    @State private var todos: [HAEntity] = []
    @State private var loaded = false
    @State private var supported = true
    @State private var error: String?
    @State private var saved = false

    var body: some View {
        List {
            ErrorBanner(text: error)
            if !supported {
                Text("Bitte das Add-on auf Version 0.9.2 aktualisieren.").foregroundStyle(.secondary)
            } else if loaded && todos.isEmpty {
                Section {
                    Text("In Home Assistant ist noch keine Bring!-Liste vorhanden.")
                } footer: {
                    Text("In Home Assistant unter Einstellungen → Geräte & Dienste → Integration hinzufügen → „Bring!“ mit deinem Bring!-Konto anmelden. Danach erscheinen deine Listen hier.")
                }
            } else {
                ForEach($lists) { $l in
                    Section {
                        TextField("Name", text: $l.name)
                        Picker("Liste", selection: $l.entity_id) {
                            ForEach(todos) { t in Text(t.name).tag(t.entity_id) }
                        }
                        TextField("Läden, z. B. Rewe, Aldi, dm", text: Binding(
                            get: { l.stores.joined(separator: ", ") },
                            set: { l.stores = $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }))
                        Toggle("Standardliste", isOn: Binding(
                            get: { l.default },
                            set: { on in for i in lists.indices { lists[i].default = on && lists[i].entity_id == l.entity_id } }))
                        Button("Entfernen", role: .destructive) { lists.removeAll { $0.entity_id == l.entity_id } }
                    }
                }
                Section {
                    Menu {
                        ForEach(todos.filter { t in !lists.contains { $0.entity_id == t.entity_id } }) { t in
                            Button(t.name) {
                                lists.append(BringListConfig(name: t.name.replacingOccurrences(of: " (Bring!)", with: ""),
                                                             entity_id: t.entity_id, stores: [], default: lists.isEmpty))
                            }
                        }
                    } label: { Label("Bring!-Liste hinzufügen", systemImage: "plus") }
                } footer: {
                    Text("Was ohne Laden oder für einen der genannten Läden auf die Einkaufsliste kommt, landet direkt in Bring! – auch per Siri oder aus dem Chat. Abgehakt wird in der Bring!-App oder über den Hausgeist. Alles andere (z. B. Baumarkt) bleibt in der Hausgeist-Liste.")
                }
            }
        }
        .navigationTitle("Einkaufslisten")
        .toolbar {
            if supported && !todos.isEmpty {
                Button(saved ? "Gesichert" : "Sichern") { Task { await save() } }
            }
        }
        .task { await load() }
    }

    private func load() async {
        let api = APIClient(auth: auth)
        do {
            let s = try await api.adminSettings()
            supported = s.bring_lists != nil
            lists = s.bring_lists ?? []
            todos = try await api.haEntities().filter { $0.domain == "todo" }
            error = nil
        } catch { self.error = error.localizedDescription }
        loaded = true
    }

    private func save() async {
        if lists.contains(where: { $0.name.trimmingCharacters(in: .whitespaces).isEmpty }) {
            error = "Bitte jeder Liste einen Namen geben."
            return
        }
        do {
            try await APIClient(auth: auth).saveSettings(SettingsPatch(bring_lists: lists))
            error = nil
            saved = true
            try? await Task.sleep(for: .seconds(2))
            saved = false
        } catch { self.error = error.localizedDescription }
    }
}
