import SwiftUI

/// Was der Hausgeist sich über dich gemerkt hat – gilt in allen Gesprächen.
struct MemoriesView: View {
    @Environment(AuthService.self) private var auth
    @State private var items: [APIClient.MemoryItem] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var confirmAll = false

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if loaded && items.isEmpty && error == nil {
                ContentUnavailableView("Noch nichts gemerkt", systemImage: "brain",
                                       description: Text("Der Hausgeist merkt sich beim Chatten, was er über dich wissen sollte – z. B. dein Auto, Vorlieben oder Pläne."))
            }
            ForEach(items) { m in
                Text(m.text)
                    .swipeActions { Button("Vergessen", systemImage: "trash", role: .destructive) { Task { await delete(m) } } }
            }
        }
        .navigationTitle("Gedächtnis")
        .toolbar {
            if !items.isEmpty {
                Button("Alles vergessen", role: .destructive) { confirmAll = true }
            }
        }
        .confirmationDialog("Alles vergessen?", isPresented: $confirmAll, titleVisibility: .visible) {
            Button("Alles vergessen", role: .destructive) { Task { await deleteAll() } }
        } message: {
            Text("Der Hausgeist weiß danach nichts mehr aus früheren Gesprächen. Der Gesprächsverlauf selbst bleibt erhalten.")
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do { items = try await APIClient(auth: auth).memories(); error = nil }
        catch { self.error = error.localizedDescription }
        loaded = true
    }

    private func delete(_ m: APIClient.MemoryItem) async {
        do { try await APIClient(auth: auth).deleteMemory(m.id); items.removeAll { $0.id == m.id } }
        catch { self.error = error.localizedDescription }
    }

    private func deleteAll() async {
        do { try await APIClient(auth: auth).deleteAllMemories(); items = [] }
        catch { self.error = error.localizedDescription }
    }
}
