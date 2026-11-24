import SwiftUI

/// FRITZ!Box und Windows-PC für den IT-Agenten einrichten.
struct NetworkPcView: View {
    @Environment(AuthService.self) private var auth

    @State private var fritzHost = "fritz.box"
    @State private var fritzUser = ""
    @State private var fritzPassword = ""
    @State private var fritzPasswordSet = false

    @State private var pc = PcConfig(name: "PC", host: "", port: 22, user: "", mac: "")
    @State private var publicKey = ""

    @State private var supported = true
    @State private var busy = false
    @State private var error: String?
    @State private var fritzResult: String?
    @State private var pcResult: String?
    @State private var copied = false

    var body: some View {
        Form {
            ErrorBanner(text: error)
            if !supported {
                Text("Bitte das Add-on auf Version 0.12.0 aktualisieren.").foregroundStyle(.secondary)
            } else {
                fritzSection
                pcSection
                setupSection
            }
        }
        .navigationTitle("Netzwerk & PC")
        .toolbar { if supported { Button("Sichern") { Task { await save() } }.disabled(busy) } }
        .task { await load() }
    }

    private var fritzSection: some View {
        Section {
            TextField("Adresse", text: $fritzHost).textInputAutocapitalization(.never).autocorrectionDisabled()
            TextField("FRITZ!Box-Benutzer", text: $fritzUser).textInputAutocapitalization(.never).autocorrectionDisabled()
            SecureField(fritzPasswordSet ? "Kennwort (gespeichert)" : "Kennwort", text: $fritzPassword)
            Button {
                Task { await testFritz() }
            } label: { HStack { Text("Sichern und testen"); if busy { Spacer(); ProgressView() } } }
            .disabled(busy || fritzUser.isEmpty)
            if let fritzResult { Text(fritzResult).font(.footnote) }
        } header: {
            Text("FRITZ!Box")
        } footer: {
            Text("In der FRITZ!Box unter System → FRITZ!Box-Benutzer einen eigenen Benutzer „hausgeist“ mit dem Recht „FRITZ!Box Einstellungen“ anlegen und unter Heimnetz → Netzwerk → Netzwerkeinstellungen „Zugriff für Anwendungen zulassen“ einschalten.")
        }
    }

    private var pcSection: some View {
        Section {
            TextField("Name, z. B. Luca-PC", text: $pc.name)
            TextField("Adresse (IP oder Name im Heimnetz)", text: $pc.host).textInputAutocapitalization(.never).autocorrectionDisabled()
            TextField("Windows-Benutzer", text: $pc.user).textInputAutocapitalization(.never).autocorrectionDisabled()
            TextField("MAC-Adresse (zum Einschalten)", text: $pc.mac).textInputAutocapitalization(.characters).autocorrectionDisabled()
            Stepper("SSH-Port \(pc.port)", value: $pc.port, in: 1...65535)
            Button {
                Task { await testPc() }
            } label: { HStack { Text("Sichern und testen"); if busy { Spacer(); ProgressView() } } }
            .disabled(busy || pc.host.isEmpty || pc.user.isEmpty)
            if let pcResult { Text(pcResult).font(.footnote.monospaced()) }
        } header: {
            Text("Windows-PC")
        } footer: {
            Text("Jeder Befehl am PC wird dir vorher unter „Freigaben“ angezeigt und läuft erst nach deinem Klick. IP- und MAC-Adresse findest du in der FRITZ!Box unter Heimnetz → Netzwerk beim PC.")
        }
    }

    private var setupSection: some View {
        Section {
            Text(publicKey.isEmpty ? "…" : publicKey).font(.caption2.monospaced()).textSelection(.enabled)
            Button(copied ? "Kopiert" : "Einrichtungsbefehl für Windows kopieren", systemImage: copied ? "checkmark" : "doc.on.doc") {
                UIPasteboard.general.string = setupScript
                copied = true
            }
            .disabled(publicKey.isEmpty)
            Button("PC neu kennenlernen", systemImage: "arrow.triangle.2.circlepath", role: .destructive) {
                Task { await forget() }
            }
        } header: {
            Text("Einrichtung am PC (einmalig)")
        } footer: {
            Text("Den kopierten Befehl am PC in „Terminal (Administrator)“ einfügen. Er installiert den Windows-eigenen OpenSSH-Server, startet ihn automatisch und erlaubt nur dem Hausgeist-Schlüssel die Anmeldung. „Neu kennenlernen“ nur nach einer Windows-Neuinstallation – sonst bricht der Hausgeist ab, wenn sich der PC plötzlich anders ausweist.")
        }
    }

    /// PowerShell-Skript für den PC: OpenSSH-Server + Hausgeist-Schlüssel für Administratoren.
    private var setupScript: String {
        """
        Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
        Start-Service sshd; Set-Service -Name sshd -StartupType Automatic
        New-ItemProperty -Path "HKLM:\\SOFTWARE\\OpenSSH" -Name DefaultShell -Value "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -PropertyType String -Force | Out-Null
        $f = "$env:ProgramData\\ssh\\administrators_authorized_keys"
        Add-Content -Force -Path $f -Value '\(publicKey)'
        icacls.exe $f /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null
        if (-not (Get-NetFirewallRule -Name sshd -ErrorAction SilentlyContinue)) { New-NetFirewallRule -Name sshd -DisplayName "OpenSSH Server" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -Profile Private }
        Write-Host "Fertig – Hausgeist kann sich jetzt anmelden."
        """
    }

    private func load() async {
        do {
            let s = try await APIClient(auth: auth).adminSettings()
            supported = s.pc != nil
            if let f = s.fritzbox { fritzHost = f.host; fritzUser = f.user; fritzPasswordSet = f.password_set }
            if let p = s.pc { pc = p }
            publicKey = s.pc_public_key ?? ""
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        busy = true; defer { busy = false }
        do {
            try await APIClient(auth: auth).saveSettings(SettingsPatch(
                fritzbox: FritzSave(host: fritzHost.isEmpty ? "fritz.box" : fritzHost, user: fritzUser,
                                    password: fritzPassword.isEmpty ? nil : fritzPassword),
                pc: pc))
            if !fritzPassword.isEmpty { fritzPasswordSet = true; fritzPassword = "" }
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func testFritz() async {
        await save()
        guard error == nil else { return }
        busy = true; defer { busy = false }
        do {
            let r = try await APIClient(auth: auth).testFritz()
            fritzResult = "✅ \(r.model ?? "FRITZ!Box") · FRITZ!OS \(r.firmware ?? "?") · \(r.devices ?? 0) Geräte online"
        } catch { fritzResult = "❌ \(error.localizedDescription)" }
    }

    private func testPc() async {
        await save()
        guard error == nil else { return }
        busy = true; defer { busy = false }
        do {
            let r = try await APIClient(auth: auth).testPc()
            pcResult = (r.ok ? "✅ " : "❌ ") + (r.message ?? "")
        } catch { pcResult = "❌ \(error.localizedDescription)" }
    }

    private func forget() async {
        do {
            try await APIClient(auth: auth).forgetPcHost()
            pcResult = "Der PC wird beim nächsten Kontakt neu kennengelernt."
        } catch { self.error = error.localizedDescription }
    }
}
