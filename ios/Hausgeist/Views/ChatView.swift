import SwiftUI
import VisionKit
import PhotosUI
import UniformTypeIdentifiers

struct ChatMessage: Identifiable, Equatable, Codable {
    enum Sender: String, Codable { case me, ghost, error }
    var id = UUID()
    let sender: Sender
    let text: String
}

/// Chatverlauf und offene Aufträge überleben das Beenden der App.
enum ChatStore {
    /// Pro App-Start nur einmal: frischer Chat (alte Gespräche bleiben im Verlauf).
    @MainActor static var startedFresh = false

    private static let historyKey = "chatHistory"
    private static let jobsKey = "pendingChatJobs"

    static func load() -> [ChatMessage] {
        guard let d = UserDefaults.standard.data(forKey: historyKey),
              let m = try? JSONDecoder().decode([ChatMessage].self, from: d) else { return [] }
        return m
    }
    static func save(_ messages: [ChatMessage]) {
        let tail = Array(messages.suffix(100))
        if let d = try? JSONEncoder().encode(tail) { UserDefaults.standard.set(d, forKey: historyKey) }
    }
    static var pendingJobs: [String] {
        get { UserDefaults.standard.stringArray(forKey: jobsKey) ?? [] }
        set { UserDefaults.standard.set(Array(Set(newValue)), forKey: jobsKey) }
    }
}

struct ChatView: View {
    @Environment(AuthService.self) private var auth
    let me: Me?

    @State private var messages: [ChatMessage] = AppConfig.isDemo ? DemoData.chat : ChatStore.load()
    @Environment(\.scenePhase) private var scenePhase
    @State private var input = ""
    @State private var busy = false
    @FocusState private var focused: Bool

    @State private var attachments: [ChatAttachment] = []
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showScanner = false
    @State private var showFiles = false
    @State private var attachError: String?
    @State private var showHistory = false

    @State private var speech = SpeechInput()
    @State private var conversation = false
    @State private var showVoice = false
    @AppStorage("speakReplies") private var speakReplies = false

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
                                GhostWorking(width: 12)
                                Text("Hausgeist arbeitet …").foregroundStyle(.secondary)
                            }
                            .font(.subheadline)
                            .padding(.vertical, 4)
                            .id("busy")
                        }
                    }
                    .padding()
                }
                .scrollDismissesKeyboard(.immediately)
                .contentShape(Rectangle())
                .onTapGesture { focused = false }
                .onChange(of: messages) {
                    if let last = messages.last?.id { withAnimation { proxy.scrollTo(last, anchor: .bottom) } }
                }
                .onChange(of: busy) {
                    if busy { withAnimation { proxy.scrollTo("busy", anchor: .bottom) } }
                }
            }
            .safeAreaInset(edge: .bottom) { composer }
            .safeAreaInset(edge: .top) {
                if conversation {
                    HStack(spacing: 8) {
                        Image(systemName: speech.isListening ? "ear" : (busy ? "hourglass" : "speaker.wave.2"))
                        Text(speech.isListening ? (speech.transcript.isEmpty ? "Ich höre zu …" : speech.transcript)
                             : (busy ? "Hausgeist denkt nach …" : "Hausgeist spricht …"))
                            .lineLimit(2)
                        Spacer()
                    }
                    .font(.subheadline)
                    .padding(10)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal)
                }
            }
            .task(id: conversation) { await conversationLoop() }
            .task {
                if AppConfig.isDemo && AppConfig.launchArg("-history") != nil { showHistory = true }
                // Beim Start der App immer ein neues Gespräch – frühere findest du unter „Verlauf“.
                if !ChatStore.startedFresh && !AppConfig.isDemo {
                    ChatStore.startedFresh = true
                    if !messages.isEmpty { await reset() }
                    return
                }
                await resumePending()
            }
            .sheet(isPresented: $showHistory) {
                ConversationsView { _, msgs in
                    Speaker.shared.stop()
                    messages = msgs
                }
            }
            .onChange(of: scenePhase) { if scenePhase == .active { Task { await resumePending() } } }
            .onChange(of: messages) { if !AppConfig.isDemo { ChatStore.save(messages) } }
            .onChange(of: speech.transcript) {
                if !conversation && speech.isListening { input = speech.transcript }
            }
            .onDisappear {
                speech.stop()
                Speaker.shared.stop()
                conversation = false
            }
            .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: 5, matching: .images)
            .onChange(of: photoItems) { Task { await loadPhotos() } }
            .onReceive(NotificationCenter.default.publisher(for: .hgOpenVoice)) { _ in
                if !busy { showVoice = true }
            }
            .fullScreenCover(isPresented: $showVoice) {
                VoiceChatView { turns in messages.append(contentsOf: turns) }
            }
            .fullScreenCover(isPresented: $showScanner) {
                DocumentScanner(onFinish: { pages in
                    showScanner = false
                    guard !pages.isEmpty else { return }
                    add(ChatAttachment(name: AttachmentTools.timestampName("Scan", ext: "pdf"), mime: "application/pdf", data: AttachmentTools.pdf(from: pages)))
                }, onCancel: { showScanner = false })
                .ignoresSafeArea()
            }
            .fileImporter(isPresented: $showFiles, allowedContentTypes: [.pdf, .jpeg, .png], allowsMultipleSelection: true) { result in
                importFiles(result)
            }
            .alert("Anhang", isPresented: Binding(get: { attachError != nil }, set: { if !$0 { attachError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(attachError ?? "") }
            .navigationTitle("Hausgeist")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showVoice = true } label: {
                        Label("Sprachchat", systemImage: "waveform.circle")
                    }
                    .disabled(busy)
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button("Verlauf", systemImage: "clock.arrow.circlepath") { showHistory = true }
                        .disabled(busy)
                    Button("Neu", systemImage: "square.and.pencil") { Task { await reset() } }
                        .disabled(busy)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 0) {
            Ghost(width: 32, fill: Color.accentColor, eyes: Color(.systemBackground))
                .padding(.bottom, 16)
            Text("Was soll ich erledigen?")
                .font(.title2.weight(.semibold))
            Text("Zum Beispiel")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.top, 4)
                .padding(.bottom, 8)
            VStack(spacing: 0) {
                ForEach(examples, id: \.self) { ex in
                    Button {
                        input = ex
                        focused = true
                    } label: {
                        HStack(spacing: 12) {
                            Text(ex)
                                .foregroundStyle(.primary)
                                .multilineTextAlignment(.leading)
                            Spacer(minLength: 8)
                            Image(systemName: "arrow.up.left")
                                .font(.footnote)
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if ex != examples.last { Divider() }
                }
            }
            Button {
                showHistory = true
            } label: {
                Label("Früheres Gespräch fortsetzen", systemImage: "clock.arrow.circlepath")
                    .font(.subheadline)
            }
            .padding(.top, 16)
        }
        .padding(.top, 32)
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
            "Erinner mich morgen um 8 an den Müll",
        ]
    }

    private func bubble(_ msg: ChatMessage) -> some View {
        HStack {
            if msg.sender == .me { Spacer(minLength: 40) }
            Text(LocalizedStringKey(msg.text))
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(background(for: msg.sender), in: RoundedRectangle(cornerRadius: 16))
                .foregroundStyle(msg.sender == .me ? .white : .primary)
                .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 16))
                .contextMenu {
                    Button("Kopieren", systemImage: "doc.on.doc") { UIPasteboard.general.string = Self.plain(msg.text) }
                    ShareLink(item: Self.plain(msg.text)) { Label("Teilen", systemImage: "square.and.arrow.up") }
                    if msg.sender == .ghost {
                        Button("Vorlesen", systemImage: "speaker.wave.2") { Task { await speakAndWait(msg.text) } }
                    }
                }
            if msg.sender != .me { Spacer(minLength: 40) }
        }
    }

    /// Markdown-Zeichen (**fett** usw.) fürs Kopieren entfernen.
    static func plain(_ markdown: String) -> String {
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        guard let a = try? AttributedString(markdown: markdown, options: opts) else { return markdown }
        return String(a.characters)
    }

    private func background(for sender: ChatMessage.Sender) -> Color {
        switch sender {
        case .me: return .accentColor
        case .ghost: return Color(.secondarySystemBackground)
        case .error: return Color.red.opacity(0.15)
        }
    }

    private var composer: some View {
        VStack(spacing: 6) {
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(attachments) { a in
                            HStack(spacing: 4) {
                                Image(systemName: a.icon)
                                Text(a.name).lineLimit(1)
                                Button {
                                    attachments.removeAll { $0.id == a.id }
                                } label: {
                                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                                }
                                .accessibilityLabel("Anhang entfernen")
                            }
                            .font(.footnote)
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(Color(.secondarySystemBackground), in: Capsule())
                        }
                    }
                    .padding(.horizontal)
                }
            }
            inputRow
        }
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: 4) {
            Menu {
                if VNDocumentCameraViewControllerSupported {
                    Button("Dokument scannen", systemImage: "doc.viewfinder") { showScanner = true }
                }
                Button("Foto auswählen", systemImage: "photo.on.rectangle") { showPhotos = true }
                Button("Datei (PDF) auswählen", systemImage: "folder") { showFiles = true }
            } label: {
                Image(systemName: "plus.circle.fill").font(.system(size: 28))
                    .frame(width: 44, height: 44)
            }
            .disabled(busy || me?.role == "child")
            .accessibilityLabel("Anhang hinzufügen")
            TextField("Nachricht", text: $input, axis: .vertical)
                .lineLimit(1...6)
                .focused($focused)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(minHeight: 44)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 22))
                .padding(.horizontal, 4)
            if focused && !speech.isListening {
                // Beim Tippen: Tastatur einklappen statt Mikrofon
                Button { focused = false } label: {
                    Image(systemName: "keyboard.chevron.compact.down")
                        .font(.system(size: 22))
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Tastatur ausblenden")
            } else {
                Button {
                    Task { await toggleDictation() }
                } label: {
                    Image(systemName: speech.isListening && !conversation ? "mic.circle.fill" : "mic.circle")
                        .font(.system(size: 28))
                        .frame(width: 44, height: 44)
                        .foregroundStyle(speech.isListening && !conversation ? Color.red : Color.accentColor)
                }
                .disabled(busy || conversation)
                .accessibilityLabel(speech.isListening ? "Diktat beenden" : "Sprechen")
            }
            Button {
                speech.stop()
                Task { await send() }
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 28))
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Senden")
            .disabled(busy || (input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty))
        }
        .padding(.horizontal)
    }

    private var VNDocumentCameraViewControllerSupported: Bool { VNDocumentCameraViewController.isSupported }

    private func add(_ a: ChatAttachment) {
        guard attachments.count < 5 else { attachError = "Höchstens 5 Anhänge pro Nachricht."; return }
        guard a.data.count <= 10_000_000 else { attachError = "\(a.name) ist größer als 10 MB."; return }
        attachments.append(a)
    }

    private func loadPhotos() async {
        let items = photoItems
        photoItems = []
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data),
                  let jpeg = AttachmentTools.jpeg(from: image) else {
                attachError = "Ein Foto konnte nicht geladen werden."
                continue
            }
            add(ChatAttachment(name: AttachmentTools.timestampName("Foto", ext: "jpg"), mime: "image/jpeg", data: jpeg))
        }
    }

    private func importFiles(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let e):
            attachError = e.localizedDescription
        case .success(let urls):
            for url in urls {
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                guard let data = try? Data(contentsOf: url) else { attachError = "\(url.lastPathComponent) konnte nicht gelesen werden."; continue }
                let ext = url.pathExtension.lowercased()
                let mime = ext == "pdf" ? "application/pdf" : (ext == "png" ? "image/png" : "image/jpeg")
                add(ChatAttachment(name: url.lastPathComponent, mime: mime, data: data))
            }
        }
    }

    private func send() async {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = attachments
        guard !text.isEmpty || !files.isEmpty else { return }
        input = ""
        attachments = []
        let shown = ([text] + files.map { "Anhang: \($0.name)" }).filter { !$0.isEmpty }.joined(separator: "\n")
        messages.append(ChatMessage(sender: .me, text: shown))
        busy = true
        defer { busy = false }
        // Ein paar Sekunden Schonfrist, falls die App gleich in den Hintergrund geht.
        let bg = UIApplication.shared.beginBackgroundTask(withName: "Hausgeist-Chat")
        defer { UIApplication.shared.endBackgroundTask(bg) }
        do {
            let r = try await APIClient(auth: auth).chatStart(text, attachments: files)
            if let reply = r.reply {
                await show(reply)
            } else if let id = r.jobId {
                ChatStore.pendingJobs.append(id)
                await follow(id)
            }
        } catch {
            // Abbruch durch den Hintergrund: Der Pi arbeitet weiter – Antwort kommt per Push bzw. beim Zurückkehren.
            if scenePhase != .active || Self.isInterruption(error) { return }
            messages.append(ChatMessage(sender: .error, text: error.localizedDescription))
        }
    }

    private func show(_ reply: String) async {
        messages.append(ChatMessage(sender: .ghost, text: reply))
        if speakReplies || conversation { await speakAndWait(reply) }
    }

    /// Wartet per Long-Polling auf einen Auftrag, bis er fertig ist oder die App in den Hintergrund geht.
    private func follow(_ id: String) async {
        let api = APIClient(auth: auth)
        while !Task.isCancelled {
            do {
                let s = try await api.chatJob(id, wait: 25)
                switch s.status {
                case "done":
                    ChatStore.pendingJobs.removeAll { $0 == id }
                    await show(s.reply ?? "")
                    return
                case "error":
                    ChatStore.pendingJobs.removeAll { $0 == id }
                    messages.append(ChatMessage(sender: .error, text: s.error ?? "Unbekannter Fehler"))
                    return
                default:
                    continue
                }
            } catch APIError.http(404, _) {
                ChatStore.pendingJobs.removeAll { $0 == id }
                return
            } catch {
                return // Hintergrund/Netz weg: beim nächsten Öffnen weiter
            }
        }
    }

    /// Beim Öffnen: offene Aufträge (lokal gemerkt oder auf dem Pi bekannt) abholen.
    private func resumePending() async {
        guard !AppConfig.isDemo, AppConfig.serverURL != nil, !busy else { return }
        let api = APIClient(auth: auth)
        var ids = ChatStore.pendingJobs
        if let open = try? await api.openChatJobs() { ids.append(contentsOf: open) }
        ids = Array(Set(ids))
        guard !ids.isEmpty else { return }
        busy = true
        defer { busy = false }
        for id in ids { await follow(id) }
    }

    private static func isInterruption(_ error: Error) -> Bool {
        guard let e = error as? URLError else { return false }
        return [.cancelled, .networkConnectionLost, .notConnectedToInternet, .timedOut, .backgroundSessionWasDisconnected].contains(e.code)
    }

    // MARK: Sprache

    private func toggleDictation() async {
        if speech.isListening { speech.stop(); return }
        guard await SpeechInput.requestPermissions() else {
            attachError = "Bitte erlaube Mikrofon und Spracherkennung in den Einstellungen."
            return
        }
        Speaker.shared.stop()
        do { try speech.start() } catch { attachError = error.localizedDescription }
    }

    private func toggleConversation() async {
        if conversation {
            conversation = false
            speech.stop()
            Speaker.shared.stop()
            return
        }
        guard await SpeechInput.requestPermissions() else {
            attachError = "Bitte erlaube Mikrofon und Spracherkennung in den Einstellungen."
            return
        }
        conversation = true
    }

    private func speakAndWait(_ text: String) async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            Speaker.shared.speak(text) { c.resume() }
        }
    }

    /// Gesprächsmodus: zuhören → nach 1,5 s Pause senden → Antwort vorlesen → wieder zuhören.
    private func conversationLoop() async {
        guard conversation else { return }
        while conversation && !Task.isCancelled {
            if !speech.isListening && !busy && !Speaker.shared.isSpeaking {
                do { try speech.start() } catch {
                    attachError = error.localizedDescription
                    conversation = false
                    return
                }
            }
            try? await Task.sleep(for: .milliseconds(300))
            let text = speech.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            if speech.isListening && !text.isEmpty && Date().timeIntervalSince(speech.lastChange) > 1.5 {
                speech.stop()
                let lower = text.lowercased()
                if ["stopp", "stop", "ende", "danke das wars", "danke, das war's", "tschüss"].contains(where: { lower.hasPrefix($0) }) {
                    conversation = false
                    Speaker.shared.speak("Bis später!")
                    return
                }
                input = text
                await send()
            }
        }
        speech.stop()
    }

    private func reset() async {
        Speaker.shared.stop()
        messages.removeAll()
        ChatStore.pendingJobs = []
        UserDefaults.standard.removeObject(forKey: "conversationId")
        try? await APIClient(auth: auth).reset()
    }
}
