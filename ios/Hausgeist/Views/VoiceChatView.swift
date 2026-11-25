import SwiftUI
import Speech
import AVFoundation
import Observation

// MARK: - Netzwerk: Antwort als Strom

extension APIClient {
    enum VoiceEvent { case text(String), done(String), failed(String) }

    /// Sprachchat starten: liefert sofort die Auftrags-ID, der Text kommt über stream().
    func voiceStart(_ message: String) async throws -> String {
        struct Body: Encodable { let message: String; let async = true; let stream = true; let voice = true; let conversation_id: String? }
        struct R: Decodable { let job_id: String?; let reply: String?; let conversation_id: String? }
        let r: R = try await request("api/chat", method: "POST", body: Body(message: message, conversation_id: UserDefaults.standard.string(forKey: "conversationId")))
        if let c = r.conversation_id { UserDefaults.standard.set(c, forKey: "conversationId") }
        guard let id = r.job_id else { throw APIError.http(500, r.reply ?? "Keine Antwort") }
        return id
    }

    /// Ereignisse (Server-Sent Events) eines Auftrags.
    func voiceStream(_ jobId: String) -> AsyncThrowingStream<VoiceEvent, Error> {
        AsyncThrowingStream { cont in
            let task = Task {
                do {
                    guard let base = AppConfig.serverURL else { throw APIError.noServer }
                    var req = URLRequest(url: base.appending(path: "api/chat/jobs/\(jobId)/stream"))
                    req.timeoutInterval = 300
                    req.setValue("Bearer \(try await auth.validAccessToken())", forHTTPHeaderField: "Authorization")
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await URLSession.shared.bytes(for: req)
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw APIError.http((response as? HTTPURLResponse)?.statusCode ?? 0, "") }
                    struct E: Decodable { let t: String; let d: String?; let reply: String?; let error: String? }
                    for try await line in bytes.lines {
                        guard line.hasPrefix("data: "), let data = line.dropFirst(6).data(using: .utf8),
                              let e = try? JSONDecoder().decode(E.self, from: data) else { continue }
                        switch e.t {
                        case "text": cont.yield(.text(e.d ?? ""))
                        case "done": cont.yield(.done(e.reply ?? "")); cont.finish(); return
                        default: cont.yield(.failed(e.error ?? "Fehler")); cont.finish(); return
                        }
                    }
                    cont.finish()
                } catch { cont.finish(throwing: error) }
            }
            cont.onTermination = { _ in task.cancel() }
        }
    }
}

// MARK: - Stimme

enum VoicePrefs {
    static var voiceId: String? {
        get { UserDefaults.standard.string(forKey: "voiceId") }
        set { UserDefaults.standard.set(newValue, forKey: "voiceId") }
    }
    static var rate: Float {
        get { let r = UserDefaults.standard.float(forKey: "voiceRate"); return r == 0 ? 0.52 : r }
        set { UserDefaults.standard.set(newValue, forKey: "voiceRate") }
    }
    /// Deutsche Stimmen, beste zuerst (Premium > Erweitert > Standard).
    static var germanVoices: [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix("de") }
            .sorted { ($0.quality.rawValue, $0.name) > ($1.quality.rawValue, $1.name) }
    }
    static var voice: AVSpeechSynthesisVoice? {
        if let id = voiceId, let v = AVSpeechSynthesisVoice(identifier: id) { return v }
        return germanVoices.first ?? AVSpeechSynthesisVoice(language: "de-DE")
    }
}

/// Liest gestreamten Text satzweise vor – der erste Satz klingt, während der Rest noch entsteht.
@MainActor
final class StreamSpeaker: NSObject, AVSpeechSynthesizerDelegate {
    private let synth = AVSpeechSynthesizer()
    private var buffer = ""
    private var pending = 0
    var onIdle: (() -> Void)?
    var isSpeaking: Bool { pending > 0 || synth.isSpeaking }

    override init() { super.init(); synth.delegate = self }

    func feed(_ text: String) {
        buffer += text
        // ganze Sätze abschneiden und vorlesen
        while let r = buffer.range(of: #"[.!?…:](\s|$)|\n"#, options: .regularExpression) {
            let sentence = String(buffer[..<r.upperBound])
            buffer.removeSubrange(..<r.upperBound)
            say(sentence)
        }
    }

    func flush() {
        let rest = buffer; buffer = ""
        say(rest)
        if pending == 0 { onIdle?() }
    }

    func stop() {
        buffer = ""; pending = 0
        synth.stopSpeaking(at: .immediate)
    }

    private func say(_ s: String) {
        let text = Speaker.plain(s)
        guard text.rangeOfCharacter(from: .letters.union(.decimalDigits)) != nil else { return }
        let u = AVSpeechUtterance(string: text)
        u.voice = VoicePrefs.voice
        u.rate = VoicePrefs.rate
        u.postUtteranceDelay = 0.05
        pending += 1
        synth.speak(u)
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        Task { @MainActor in
            self.pending = max(0, self.pending - 1)
            if self.pending == 0 && self.buffer.isEmpty { self.onIdle?() }
        }
    }
}

// MARK: - Sprachchat

/// Mikrofon-Puffer direkt aus dem Audio-Thread an die Erkennung (ohne Umweg über den Hauptthread).
final class AudioSink: @unchecked Sendable {
    private let lock = NSLock()
    private var _request: SFSpeechAudioBufferRecognitionRequest?
    private var _muted = false
    private var _level: Float = 0
    var request: SFSpeechAudioBufferRecognitionRequest? { get { lock.withLock { _request } } set { lock.withLock { _request = newValue } } }
    var muted: Bool { get { lock.withLock { _muted } } set { lock.withLock { _muted = newValue } } }
    var level: Float { lock.withLock { _level } }
    func push(_ buf: AVAudioPCMBuffer) {
        var sum: Float = 0
        if let ch = buf.floatChannelData?[0] { for i in 0..<Int(buf.frameLength) { sum += ch[i] * ch[i] } }
        let rms = sqrt(sum / Float(max(buf.frameLength, 1)))
        lock.withLock {
            _level = _level * 0.6 + min(1, rms * 12) * 0.4
            if !_muted { _request?.append(buf) }
        }
    }
}

@Observable
@MainActor
final class VoiceSession {
    enum Phase: Equatable { case idle, listening, thinking, speaking, error(String) }

    var phase: Phase = .idle
    var heard = ""
    var answer = ""
    var level: Float = 0
    var muted = false
    /// Ausgetauschte Nachrichten – landen nach dem Beenden im normalen Chat.
    var turns: [ChatMessage] = []

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "de-DE"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest? { didSet { sink.request = request } }
    private let sink = AudioSink()
    private var levelTimer: Task<Void, Never>?
    private var task: SFSpeechRecognitionTask?
    private var lastChange = Date()
    private var silenceTimer: Task<Void, Never>?
    private var replyTask: Task<Void, Never>?
    private let speaker = StreamSpeaker()
    private let api: APIClient
    private var active = false

    init(api: APIClient) {
        self.api = api
        speaker.onIdle = { [weak self] in
            guard let self, self.active, self.phase == .speaking else { return }
            self.listen()
        }
    }

    func start() async {
        guard await SpeechInput.requestPermissions() else { phase = .error("Bitte Mikrofon und Spracherkennung in den Einstellungen erlauben."); return }
        do {
            let s = AVAudioSession.sharedInstance()
            // .voiceChat: Echo-Unterdrückung – der Hausgeist hört sich nicht selbst und du kannst ihn unterbrechen
            try s.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP, .duckOthers])
            try s.setActive(true)
            try startEngine()
        } catch { phase = .error(error.localizedDescription); return }
        active = true
        listen()
    }

    func stop() {
        active = false
        silenceTimer?.cancel(); replyTask?.cancel(); levelTimer?.cancel()
        speaker.stop()
        task?.cancel(); task = nil
        request?.endAudio(); request = nil
        if engine.isRunning { engine.stop(); engine.inputNode.removeTap(onBus: 0) }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        phase = .idle
    }

    func toggleMute() { muted.toggle(); sink.muted = muted; if muted { heard = "" } }

    private func yieldToUser() {
        replyTask?.cancel()
        speaker.stop()
        if !answer.isEmpty { turns.append(ChatMessage(sender: .ghost, text: answer + " …")) }
        answer = ""
        phase = .listening
    }

    /// Antippen während er spricht: unterbrechen und zuhören.
    func interrupt() {
        guard phase == .speaking || phase == .thinking else { return }
        replyTask?.cancel()
        speaker.stop()
        if !answer.isEmpty { turns.append(ChatMessage(sender: .ghost, text: answer + " …")) }
        listen()
    }

    private func startEngine() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        let sink = self.sink
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buf, _ in sink.push(buf) }
        engine.prepare()
        try engine.start()
        // Pegel für die Animation
        levelTimer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(50))
                guard let self else { return }
                self.level = self.sink.level
            }
        }
    }

    /// bargeIn: schon während er spricht mithören – sagst du etwas, hört er auf und lässt dich reden.
    private func listen(bargeIn: Bool = false) {
        guard active else { return }
        task?.cancel(); request?.endAudio()
        heard = ""
        if !bargeIn { answer = ""; phase = .listening }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.taskHint = .dictation
        if recognizer?.supportsOnDeviceRecognition == true { req.requiresOnDeviceRecognition = true }
        request = req
        lastChange = Date()
        task = recognizer?.recognitionTask(with: req) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            Task { @MainActor in
                guard let self, self.request === req else { return }
                if let text, text != self.heard {
                    self.heard = text; self.lastChange = Date()
                    // Unterbrechen per Stimme: ab zwei Wörtern, während er spricht
                    if self.phase == .speaking && text.split(separator: " ").count >= 2 { self.yieldToUser() }
                }
                if error != nil && self.phase == .listening && self.heard.isEmpty { self.listen() } // Erkennung neu starten (Zeitlimit)
            }
        }
        silenceTimer?.cancel()
        silenceTimer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
                guard let self else { return }
                let text = self.heard.trimmingCharacters(in: .whitespacesAndNewlines)
                // Ende der Äußerung: 1,2 s Ruhe nach dem letzten erkannten Wort
                if self.phase == .listening, !text.isEmpty, Date().timeIntervalSince(self.lastChange) > 1.2 {
                    self.send(text); return
                }
            }
        }
    }

    private func send(_ text: String) {
        silenceTimer?.cancel()
        request?.endAudio(); request = nil; task?.cancel(); task = nil
        let lower = text.lowercased()
        if ["stopp", "stop", "tschüss", "danke das war's", "danke das wars", "ende"].contains(where: { lower == $0 || lower.hasPrefix($0 + " ") }) {
            turns.append(ChatMessage(sender: .me, text: text))
            phase = .idle
            speaker.onIdle = nil
            speaker.feed("Bis später!"); speaker.flush()
            active = false
            return
        }
        turns.append(ChatMessage(sender: .me, text: text))
        phase = .thinking
        answer = ""
        replyTask = Task { [weak self] in
            guard let self else { return }
            do {
                let id = try await api.voiceStart(text)
                for try await e in api.voiceStream(id) {
                    if Task.isCancelled { return }
                    switch e {
                    case .text(let d):
                        if phase == .thinking { phase = .speaking; listen(bargeIn: true) }
                        answer += d
                        speaker.feed(d)
                    case .done(let reply):
                        if phase == .thinking { phase = .speaking; speaker.feed(reply) }
                        turns.append(ChatMessage(sender: .ghost, text: reply))
                        answer = reply
                        speaker.flush()
                    case .failed(let msg):
                        turns.append(ChatMessage(sender: .error, text: msg))
                        phase = .speaking
                        speaker.feed("Das hat nicht geklappt: \(msg)"); speaker.flush()
                    }
                }
            } catch {
                if Task.isCancelled { return }
                phase = .speaking
                speaker.feed("Ich erreiche den Hausgeist gerade nicht."); speaker.flush()
            }
        }
    }
}

struct VoiceChatView: View {
    @Environment(AuthService.self) private var auth
    @Environment(\.dismiss) private var dismiss
    var onClose: ([ChatMessage]) -> Void
    @State private var session: VoiceSession?
    @State private var showVoices = false

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.05, green: 0.07, blue: 0.12), .black], startPoint: .top, endPoint: .bottom).ignoresSafeArea()
            VStack(spacing: 24) {
                HStack {
                    Button { showVoices = true } label: { Image(systemName: "person.wave.2").font(.title3) }
                    Spacer()
                    Text(status).font(.headline).foregroundStyle(.white.opacity(0.8))
                    Spacer()
                    Color.clear.frame(width: 24)
                }
                .padding(.horizontal).padding(.top, 8)

                Spacer()
                Orb(phase: session?.phase ?? .idle, level: session?.level ?? 0)
                    .frame(width: 220, height: 220)
                    .onTapGesture { session?.interrupt() }
                Spacer()

                VStack(spacing: 10) {
                    if let s = session, !s.heard.isEmpty, s.phase == .listening {
                        Text(s.heard).foregroundStyle(.white.opacity(0.7))
                    }
                    if let s = session, !s.answer.isEmpty, s.phase != .listening {
                        Text(Speaker.plain(s.answer)).foregroundStyle(.white)
                    }
                    if case .error(let msg) = session?.phase { Text(msg).foregroundStyle(.red) }
                }
                .font(.title3)
                .multilineTextAlignment(.center)
                .lineLimit(5)
                .padding(.horizontal, 24)
                .frame(minHeight: 120)

                HStack(spacing: 48) {
                    Button { session?.toggleMute() } label: {
                        Image(systemName: session?.muted == true ? "mic.slash.fill" : "mic.fill")
                            .font(.title2).frame(width: 64, height: 64)
                            .background(.white.opacity(session?.muted == true ? 0.3 : 0.12), in: Circle())
                    }
                    Button { close() } label: {
                        Image(systemName: "xmark").font(.title2.bold()).frame(width: 64, height: 64)
                            .background(.red.opacity(0.85), in: Circle())
                    }
                }
                .foregroundStyle(.white)
                .padding(.bottom, 24)
            }
        }
        .preferredColorScheme(.dark)
        .task {
            UIApplication.shared.isIdleTimerDisabled = true
            let s = VoiceSession(api: APIClient(auth: auth))
            session = s
            await s.start()
        }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false; session?.stop() }
        .sheet(isPresented: $showVoices) { VoicePicker() }
    }

    private var status: String {
        switch session?.phase ?? .idle {
        case .idle: return "Sprachchat"
        case .listening: return session?.muted == true ? "Stumm" : "Ich höre zu"
        case .thinking: return "Denke nach …"
        case .speaking: return "Tippen zum Unterbrechen"
        case .error: return "Fehler"
        }
    }

    private func close() {
        let turns = session?.turns ?? []
        session?.stop()
        onClose(turns)
        dismiss()
    }
}

/// Leuchtende Kugel: atmet beim Zuhören mit der Stimme, pulsiert beim Sprechen.
private struct Orb: View {
    let phase: VoiceSession.Phase
    let level: Float

    var body: some View {
        TimelineView(.animation) { ctx in
            let time = ctx.date.timeIntervalSinceReferenceDate
            let pulse: Double = switch phase {
            case .listening: 1 + Double(level) * 0.35
            case .thinking: 1 + 0.05 * sin(time * 4)
            case .speaking: 1 + 0.08 * sin(time * 7) + 0.04 * sin(time * 13)
            default: 1
            }
            ZStack {
                Circle().fill(RadialGradient(colors: [colors.0, colors.1.opacity(0.0)], center: .center, startRadius: 10, endRadius: 140))
                    .scaleEffect(pulse * 1.25).blur(radius: 20)
                Circle().fill(AngularGradient(colors: [colors.0, colors.1, colors.0], center: .center, angle: .degrees(time * 40)))
                    .scaleEffect(pulse).blur(radius: 2)
                    .overlay(Circle().stroke(.white.opacity(0.25), lineWidth: 1).scaleEffect(pulse))
            }
        }
        .animation(.easeOut(duration: 0.15), value: level)
        .accessibilityLabel("Sprachchat")
    }

    private var colors: (Color, Color) {
        switch phase {
        case .listening: return (.cyan, .blue)
        case .thinking: return (.purple, .indigo)
        case .speaking: return (.mint, .teal)
        case .error: return (.red, .orange)
        case .idle: return (.gray, .gray)
        }
    }
}

/// Stimme auswählen – Premium-Stimmen klingen deutlich natürlicher.
struct VoicePicker: View {
    @Environment(\.dismiss) private var dismiss
    @State private var selected = VoicePrefs.voice?.identifier ?? ""
    @State private var rate = VoicePrefs.rate
    private let synth = AVSpeechSynthesizer()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(VoicePrefs.germanVoices, id: \.identifier) { v in
                        Button {
                            selected = v.identifier; VoicePrefs.voiceId = v.identifier
                            synth.stopSpeaking(at: .immediate)
                            let u = AVSpeechUtterance(string: "Hallo, ich bin dein Hausgeist."); u.voice = v; u.rate = rate
                            synth.speak(u)
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(v.name).foregroundStyle(.primary)
                                    Text(quality(v)).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if v.identifier == selected { Image(systemName: "checkmark") }
                            }
                        }
                    }
                } header: { Text("Stimme") } footer: {
                    Text("Natürlichere Stimmen laden: Einstellungen → Bedienungshilfen → Gesprochene Inhalte → Stimmen → Deutsch → z. B. „Anna (Premium)“ oder „Helena (Premium)“. Danach erscheinen sie hier.")
                }
                Section("Tempo") {
                    Slider(value: $rate, in: 0.42...0.62) { Text("Tempo") }
                        .onChange(of: rate) { VoicePrefs.rate = rate }
                }
            }
            .navigationTitle("Stimme").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fertig") { dismiss() } } }
        }
    }

    private func quality(_ v: AVSpeechSynthesisVoice) -> String {
        switch v.quality {
        case .premium: return "Premium"
        case .enhanced: return "Erweitert"
        default: return "Standard"
        }
    }
}
