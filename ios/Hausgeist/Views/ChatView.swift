import SwiftUI
import VisionKit
import PhotosUI
import UniformTypeIdentifiers

struct ChatMessage: Identifiable, Equatable {
    enum Sender { case me, ghost, error }
    let id = UUID()
    let sender: Sender
    let text: String
}

struct ChatView: View {
    @Environment(AuthService.self) private var auth
    let me: Me?

    @State private var messages: [ChatMessage] = AppConfig.isDemo ? DemoData.chat : []
    @State private var input = ""
    @State private var busy = false
    @FocusState private var focused: Bool

    @State private var attachments: [ChatAttachment] = []
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showScanner = false
    @State private var showFiles = false
    @State private var attachError: String?

    @State private var speech = SpeechInput()
    @State private var conversation = false
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
                    Button {
                        Task { await toggleConversation() }
                    } label: {
                        Label(conversation ? "Gespräch beenden" : "Gesprächsmodus",
                              systemImage: conversation ? "waveform.circle.fill" : "waveform.circle")
                    }
                    .tint(conversation ? .red : .accentColor)
                }
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
            "Erinner mich morgen um 8 an den Müll",
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
        HStack(alignment: .bottom, spacing: 8) {
            Menu {
                if VNDocumentCameraViewControllerSupported {
                    Button("Dokument scannen", systemImage: "doc.viewfinder") { showScanner = true }
                }
                Button("Foto auswählen", systemImage: "photo.on.rectangle") { showPhotos = true }
                Button("Datei (PDF) auswählen", systemImage: "folder") { showFiles = true }
            } label: {
                Image(systemName: "plus.circle.fill").font(.system(size: 30))
            }
            .disabled(busy || me?.role == "child")
            .accessibilityLabel("Anhang hinzufügen")
            TextField("Nachricht", text: $input, axis: .vertical)
                .lineLimit(1...6)
                .focused($focused)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
            Button {
                Task { await toggleDictation() }
            } label: {
                Image(systemName: speech.isListening && !conversation ? "mic.circle.fill" : "mic.circle")
                    .font(.system(size: 30))
                    .foregroundStyle(speech.isListening && !conversation ? Color.red : Color.accentColor)
            }
            .disabled(busy || conversation)
            .accessibilityLabel(speech.isListening ? "Diktat beenden" : "Sprechen")
            Button {
                speech.stop()
                Task { await send() }
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 32))
            }
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
        let shown = ([text] + files.map { "📎 \($0.name)" }).filter { !$0.isEmpty }.joined(separator: "\n")
        messages.append(ChatMessage(sender: .me, text: shown))
        busy = true
        defer { busy = false }
        do {
            let reply = try await APIClient(auth: auth).chat(text, attachments: files)
            messages.append(ChatMessage(sender: .ghost, text: reply))
            if speakReplies || conversation { await speakAndWait(reply) }
        } catch {
            messages.append(ChatMessage(sender: .error, text: error.localizedDescription))
        }
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
        try? await APIClient(auth: auth).reset()
        messages.removeAll()
    }
}
