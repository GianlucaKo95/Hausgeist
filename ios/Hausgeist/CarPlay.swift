import CarPlay
import UIKit

/// Sprachgespräch mit dem Hausgeist – für CarPlay (startet direkt mit Zuhören, ohne Bildschirmbedienung).
@MainActor
final class CarVoiceSession {
    enum State: String { case idle, listening, thinking, speaking }

    var onState: ((State) -> Void)?
    private let speech = SpeechInput()
    private var loop: Task<Void, Never>?
    private(set) var state: State = .idle { didSet { onState?(state) } }

    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in await self?.run() }
    }

    func stop() {
        loop?.cancel()
        loop = nil
        speech.stop()
        Speaker.shared.stop()
        state = .idle
    }

    private func run() async {
        guard await SpeechInput.requestPermissions() else {
            await say("Bitte erlaube Mikrofon und Spracherkennung in der Hausgeist-App auf dem iPhone.")
            stop()
            return
        }
        await say("Hallo, was kann ich für dich tun?")
        while !Task.isCancelled {
            guard let text = await listen() else { continue }
            let lower = text.lowercased()
            if ["stopp", "stop", "ende", "danke das wars", "danke, das war's", "tschüss", "das wars"].contains(where: { lower.hasPrefix($0) }) {
                await say("Bis später!")
                stop()
                return
            }
            state = .thinking
            let reply = await ask(text)
            await say(reply)
        }
    }

    /// Zuhören, bis nach dem Sprechen 1,5 s Pause ist.
    private func listen() async -> String? {
        do { try speech.start() } catch { try? await Task.sleep(for: .seconds(1)); return nil }
        state = .listening
        let started = Date()
        while !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(300))
            let t = speech.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty && Date().timeIntervalSince(speech.lastChange) > 1.5 { speech.stop(); return t }
            if t.isEmpty && Date().timeIntervalSince(started) > 30 { speech.stop(); return nil } // Stille: neu starten
        }
        speech.stop()
        return nil
    }

    private func ask(_ text: String) async -> String {
        let api = APIClient(auth: AuthService())
        do {
            let r = try await api.chatStart(text)
            if let reply = r.reply { return reply }
            guard let id = r.jobId else { return "Keine Antwort erhalten." }
            for _ in 0..<12 { // bis zu 5 Minuten
                let s = try await api.chatJob(id, wait: 25)
                if s.status == "done" { return s.reply ?? "" }
                if s.status == "error" { return "Das hat nicht geklappt: \(s.error ?? "")" }
            }
            return "Das dauert länger – ich schicke dir die Antwort als Mitteilung."
        } catch {
            return "Ich erreiche den Hausgeist gerade nicht."
        }
    }

    private func say(_ text: String) async {
        state = .speaking
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            Speaker.shared.speak(text) { c.resume() }
        }
    }
}

/// CarPlay-Oberfläche: nur die Sprachsteuerungs-Ansicht (Kategorie „sprachbasierte Konversations-App“).
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var interfaceController: CPInterfaceController?
    @MainActor private lazy var session = CarVoiceSession()

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene,
                                  didConnect interfaceController: CPInterfaceController) {
        self.interfaceController = interfaceController
        let states = [
            CPVoiceControlState(identifier: "idle", titleVariants: ["Hausgeist", "Bereit"], image: UIImage(systemName: "house.fill"), repeats: false),
            CPVoiceControlState(identifier: "listening", titleVariants: ["Ich höre zu …", "Sprich jetzt"], image: UIImage(systemName: "waveform"), repeats: true),
            CPVoiceControlState(identifier: "thinking", titleVariants: ["Einen Moment …", "Hausgeist denkt nach"], image: UIImage(systemName: "ellipsis.circle"), repeats: true),
            CPVoiceControlState(identifier: "speaking", titleVariants: ["Hausgeist antwortet"], image: UIImage(systemName: "speaker.wave.2.fill"), repeats: true),
        ]
        let template = CPVoiceControlTemplate(voiceControlStates: states)
        interfaceController.setRootTemplate(template, animated: false, completion: nil)
        Task { @MainActor in
            session.onState = { state in template.activateVoiceControlState(withIdentifier: state.rawValue) }
            session.start()
        }
    }

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene,
                                  didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        Task { @MainActor in session.stop() }
        self.interfaceController = nil
    }
}
