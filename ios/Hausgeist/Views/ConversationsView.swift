import SwiftUI

/// Liste früherer Gespräche – antippen öffnet und setzt das Gespräch fort.
struct ConversationsView: View {
    @Environment(AuthService.self) private var auth
    @Environment(\.dismiss) private var dismiss
    var onOpen: (String, [ChatMessage]) -> Void

    @State private var items: [APIClient.ConversationInfo] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var opening: String?

    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).foregroundStyle(.red) }
                if loaded && items.isEmpty && error == nil {
                    ContentUnavailableView("Noch keine Gespräche", systemImage: "bubble.left.and.bubble.right",
                                           description: Text("Gespräche erscheinen hier, sobald du dem Hausgeist schreibst."))
                }
                ForEach(items) { c in
                    Button { Task { await open(c) } } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(c.title).foregroundStyle(.primary).lineLimit(2)
                                Text(subtitle(c)).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if opening == c.id { ProgressView() }
                            else if c.current { Image(systemName: "checkmark").foregroundStyle(.tint) }
                        }
                    }
                    .buttonStyle(.plain)
                    .swipeActions {
                        Button("Löschen", systemImage: "trash", role: .destructive) { Task { await delete(c) } }
                    }
                }
            }
            .navigationTitle("Verlauf")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Schließen") { dismiss() } } }
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func subtitle(_ c: APIClient.ConversationInfo) -> String {
        let when = c.date.map { $0.formatted(.relative(presentation: .named)) } ?? ""
        return "\(when) · \(c.messages) Nachrichten"
    }

    private func load() async {
        do {
            items = try await APIClient(auth: auth).conversations()
            error = nil
        } catch { self.error = error.localizedDescription }
        loaded = true
    }

    private func open(_ c: APIClient.ConversationInfo) async {
        opening = c.id; defer { opening = nil }
        let api = APIClient(auth: auth)
        do {
            let msgs = try await api.conversationMessages(c.id)
            try await api.openConversation(c.id)
            onOpen(c.id, msgs)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }

    private func delete(_ c: APIClient.ConversationInfo) async {
        do {
            try await APIClient(auth: auth).deleteConversation(c.id)
            items.removeAll { $0.id == c.id }
            if c.current { UserDefaults.standard.removeObject(forKey: "conversationId") }
        } catch { self.error = error.localizedDescription }
    }
}
