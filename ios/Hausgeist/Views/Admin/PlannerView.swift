import SwiftUI

struct PlannerDevice: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let pairedAt: String?
    let lastSeen: String?
}

extension APIClient {
    private struct PlannerOK: Decodable { let ok: Bool }

    func plannerDevices() async throws -> [PlannerDevice] {
        if AppConfig.isDemo { return [PlannerDevice(id: "1", name: "Küchentablet", pairedAt: nil, lastSeen: nil)] }
        struct R: Decodable { let devices: [PlannerDevice] }
        let r: R = try await request("api/admin/planner")
        return r.devices
    }

    func pairPlanner(code: String, name: String) async throws {
        if AppConfig.isDemo { return }
        let _: PlannerDevice = try await request("api/admin/planner/confirm", method: "POST", body: ["code": code, "name": name])
    }

    func renamePlanner(id: String, name: String) async throws {
        if AppConfig.isDemo { return }
        let _: PlannerOK = try await request("api/admin/planner/\(id)", method: "PUT", body: ["name": name])
    }

    func deletePlanner(id: String) async throws {
        if AppConfig.isDemo { return }
        let _: PlannerOK = try await request("api/admin/planner/\(id)", method: "DELETE")
    }
}

/// Familienplaner (Daily Nest Plans) als gemeinsamer Familienaccount koppeln.
struct PlannerView: View {
    @Environment(AuthService.self) private var auth
    @State private var devices: [PlannerDevice] = []
    @State private var code = ""
    @State private var name = ""
    @State private var busy = false
    @State private var error: String?
    @State private var info: String?
    @State private var renaming: PlannerDevice?
    @State private var newName = ""

    var body: some View {
        Form {
            ErrorBanner(text: error)
            Section {
                if devices.isEmpty {
                    Text("Noch kein Gerät gekoppelt.").foregroundStyle(.secondary)
                }
                ForEach(devices) { d in
                    VStack(alignment: .leading) {
                        Text(d.name)
                        Text(seen(d)).font(.caption).foregroundStyle(.secondary)
                    }
                    .swipeActions {
                        Button("Entfernen", role: .destructive) { Task { await remove(d) } }
                        Button("Umbenennen") { newName = d.name; renaming = d }.tint(.orange)
                    }
                }
            } header: { Text("Gekoppelte Geräte") } footer: {
                Text("Wischen zum Umbenennen oder Entfernen – ein entferntes Gerät verliert sofort den Zugang.")
            }

            Section {
                TextField("Code aus dem Familienplaner", text: $code)
                    .keyboardType(.numberPad)
                    .font(.title3.monospacedDigit())
                TextField("Name, z. B. Küchentablet", text: $name)
                Button("Koppeln", systemImage: "link") { Task { await pair() } }
                    .disabled(busy || code.filter(\.isNumber).count != 6)
                if let info { Label(info, systemImage: "checkmark.circle").foregroundStyle(.green) }
            } header: {
                Text("Neues Gerät koppeln")
            } footer: {
                Text("Im Familienplaner: Einstellungen → Hausgeist → Verbinden. Er zeigt einen 6-stelligen Code (10 Minuten gültig).\n\nDer Familienplaner nutzt einen gemeinsamen Familienaccount: Kalender (alle sehen und beschreiben), Bring!-Liste, Haussteuerung ohne Schlösser/Alarm/Tore und Fernseher. Keine Freigaben, keine Finanzen, keine Mail.")
            }
        }
        .navigationTitle("Familienplaner")
        .refreshable { await load() }
        .task { await load() }
        .alert("Umbenennen", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Sichern") { if let d = renaming { Task { await rename(d) } } }
            Button("Abbrechen", role: .cancel) {}
        }
    }

    private var api: APIClient { APIClient(auth: auth) }

    private func seen(_ d: PlannerDevice) -> String {
        guard let s = d.lastSeen, let date = ISO8601DateFormatter.flexible.date(from: s) ?? ISO8601DateFormatter().date(from: s) else { return "noch nicht benutzt" }
        return "zuletzt aktiv " + date.formatted(.relative(presentation: .named))
    }

    private func load() async {
        do { devices = try await api.plannerDevices(); error = nil }
        catch { self.error = error.localizedDescription }
    }

    private func pair() async {
        busy = true; defer { busy = false }
        do {
            try await api.pairPlanner(code: code.filter(\.isNumber), name: name.trimmingCharacters(in: .whitespaces))
            info = "Gekoppelt – der Familienplaner ist in ein paar Sekunden verbunden."
            code = ""; name = ""; error = nil
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func remove(_ d: PlannerDevice) async {
        do { try await api.deletePlanner(id: d.id); await load() } catch { self.error = error.localizedDescription }
    }

    private func rename(_ d: PlannerDevice) async {
        do { try await api.renamePlanner(id: d.id, name: newName); renaming = nil; await load() }
        catch { self.error = error.localizedDescription }
    }
}
