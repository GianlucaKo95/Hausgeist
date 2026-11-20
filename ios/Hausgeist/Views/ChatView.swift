import SwiftUI

struct ChatMessage: Identifiable, Equatable {
    enum Sender { case me, ghost, error }
    let id = UUID()
    let sender: Sender
    let text: String
}

struct ChatView: View {
    @Environment(AuthService.self) private var auth
    let me: Me?

    @State private var messages: [ChatMessage] = []
    @State private var input = ""
    @State private var busy = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if messages.isEmpty {
                            emptyState
                        }
                        ForEach(messages) { msg in
                            bubble(msg).id(msg.id)
                        }
                        if busy {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Hausgeist arbeitet …").foregroundStyle(.secondary)
                            }
                            .id("busy")
                        }
                    }
                    .padding()
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: messages) {
                    if let last = messages.last?.id { withAnimation { proxy.scrollTo(last, anchor: .bottom) } }
                }
                .onChange(of: busy) {
                    if busy { withAnimation { proxy.scrollTo("busy", anchor: .bottom) } }
                }
            }
            .safeAreaInset(edge: .bottom) { composer }
            .navigationTitle("Hausgeist")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Neu", systemImage: "square.and.pencil") { Task { await reset() } }
                        .disabled(busy)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(me.map { "Hallo \($0.name)!" } ?? "Hallo!").font(.title2.bold())
            Text("Was soll ich erledigen? Zum Beispiel:").foregroundStyle(.secondary)
            ForEach(examples, id: \.self) { ex in
                Button(ex) { input = ex; focused = true }
                    .buttonStyle(.bordered)
            }
        }
        .padding(.top, 24)
    }

    private var examples: [String] {
        if me?.role == "child" {
            return ["Setz Milch auf die Einkaufsliste", "Welche Termine habe ich diese Woche?"]
        }
        return [
            "Welche Rechnungen sind diesen Monat offen?",
            "Welche Verträge kann ich bald kündigen?",
            "Wann lohnt sich heute die Waschmaschine mit PV-Strom?",
            "Was steht morgen im Familienkalender?",
        ]
    }

    private func bubble(_ msg: ChatMessage) -> some View {
        HStack {
            if msg.sender == .me { Spacer(minLength: 40) }
            Text(LocalizedStringKey(msg.text))
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(background(for: msg.sender), in: RoundedRectangle(cornerRadius: 16))
                .foregroundStyle(msg.sender == .me ? .white : .primary)
            if msg.sender != .me { Spacer(minLength: 40) }
        }
    }

    private func background(for sender: ChatMessage.Sender) -> Color {
        switch sender {
        case .me: return .accentColor
        case .ghost: return Color(.secondarySystemBackground)
        case .error: return Color.red.opacity(0.15)
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Nachricht", text: $input, axis: .vertical)
                .lineLimit(1...6)
                .focused($focused)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
            Button {
                Task { await send() }
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 32))
            }
            .disabled(busy || input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func send() async {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        input = ""
        messages.append(ChatMessage(sender: .me, text: text))
        busy = true
        defer { busy = false }
        do {
            let reply = try await APIClient(auth: auth).chat(text)
            messages.append(ChatMessage(sender: .ghost, text: reply))
        } catch {
            messages.append(ChatMessage(sender: .error, text: error.localizedDescription))
        }
    }

    private func reset() async {
        try? await APIClient(auth: auth).reset()
        messages.removeAll()
    }
}
