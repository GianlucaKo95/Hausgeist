import SwiftUI

struct TvDevice: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let model: String
    let online: Bool
    let pairedAt: String?
}

extension APIClient {
    private struct OKReply: Decodable { let ok: Bool }

    func tvs() async throws -> [TvDevice] {
        if AppConfig.isDemo { return [TvDevice(id: "1", name: "Wohnzimmer", model: "AFTKA", online: true, pairedAt: nil)] }
        struct R: Decodable { let tvs: [TvDevice] }
        let r: R = try await request("api/admin/tvs")
        return r.tvs
    }

    func pairTv(code: String, name: String) async throws {
        if AppConfig.isDemo { return }
        struct R: Decodable { let id: String; let name: String }
        let _: R = try await request("api/admin/tvs/confirm", method: "POST", body: ["code": code, "name": name])
    }

    func renameTv(id: String, name: String) async throws {
        if AppConfig.isDemo { return }
        let _: OKReply = try await request("api/admin/tvs/\(id)", method: "PUT", body: ["name": name])
    }

    func deleteTv(id: String) async throws {
        if AppConfig.isDemo { return }
        let _: OKReply = try await request("api/admin/tvs/\(id)", method: "DELETE")
    }
}

/// Fernseher und Beamer mit Couchpotato koppeln – danach steuert der Hausgeist sie per Sprache.
struct TvView: View {
    @Environment(AuthService.self) private var auth
    @State private var tvs: [TvDevice] = []
    @State private var code = ""
    @State private var name = ""
    @State private var busy = false
    @State private var error: String?
    @State private var info: String?
    @State private var renaming: TvDevice?
    @State private var newName = ""

    var body: some View {
        Form {
            ErrorBanner(text: error)
            Section {
                if tvs.isEmpty {
                    Text("Noch kein Fernseher gekoppelt.").foregroundStyle(.secondary)
                }
                ForEach(tvs) { tv in
                    HStack {
                        Image(systemName: "tv").foregroundStyle(tv.online ? .green : .secondary)
                        VStack(alignment: .leading) {
                            Text(tv.name)
                            Text(tv.online ? "an" : "aus / Standby").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .contextMenu {
                        Button("Umbenennen", systemImage: "pencil") { newName = tv.name; renaming = tv }
                    }
                    .swipeActions {
                        Button("Entfernen", role: .destructive) { Task { await remove(tv) } }
                        Button("Umbenennen") { newName = tv.name; renaming = tv }.tint(.orange)
                    }
                }
            } header: { Text("Fernseher") }

            Section {
                TextField("Code vom Fernseher", text: $code)
                    .keyboardType(.numberPad)
                    .font(.title3.monospacedDigit())
                TextField("Name, z. B. Wohnzimmer oder Kinderzimmer", text: $name)
                Button("Koppeln", systemImage: "link") { Task { await pair() } }
                    .disabled(busy || code.filter(\.isNumber).count != 6)
                if let info { Label(info, systemImage: "checkmark.circle").foregroundStyle(.green) }
            } header: {
                Text("Neuen Fernseher koppeln")
            } footer: {
                Text("In Couchpotato: Einstellungen → Hausgeist → Koppeln. Der Fernseher zeigt einen 6-stelligen Code, der 10 Minuten gilt. Der Name ist das, was du später sagst: „Spiel Pokémon im Kinderzimmer“.")
            }
        }
        .navigationTitle("Fernseher")
        .refreshable { await load() }
        .task { await load() }
        .alert("Umbenennen", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Sichern") { if let tv = renaming { Task { await rename(tv) } } }
            Button("Abbrechen", role: .cancel) {}
        }
    }

    private var api: APIClient { APIClient(auth: auth) }

    private func load() async {
        do { tvs = try await api.tvs(); error = nil }
        catch { self.error = error.localizedDescription }
    }

    private func pair() async {
        busy = true; defer { busy = false }
        do {
            try await api.pairTv(code: code.filter(\.isNumber), name: name.trimmingCharacters(in: .whitespaces))
            info = "Gekoppelt – der Fernseher verbindet sich in ein paar Sekunden."
            code = ""; name = ""; error = nil
            try? await Task.sleep(for: .seconds(3))
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func remove(_ tv: TvDevice) async {
        do { try await api.deleteTv(id: tv.id); await load() } catch { self.error = error.localizedDescription }
    }

    private func rename(_ tv: TvDevice) async {
        do { try await api.renameTv(id: tv.id, name: newName); renaming = nil; await load() }
        catch { self.error = error.localizedDescription }
    }
}
