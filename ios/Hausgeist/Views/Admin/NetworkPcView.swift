import SwiftUI

/// FRITZ!Box und Windows-PC für den IT-Agenten einrichten.
struct NetworkPcView: View {
    @Environment(AuthService.self) private var auth

    @State private var fritzHost = "fritz.box"
    @State private var fritzUser = ""
    @State private var fritzPassword = ""
    @State private var fritzPasswordSet = false

    @State private var pcs: [PcConfig] = []
    @State private var found: [DiscoveredPc] = []
    @State private var searching = false
    @State private var editing: PcConfig?
    @State private var editingIndex: Int?
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
                Text("Bitte das Add-on auf Version 0.17.0 aktualisieren.").foregroundStyle(.secondary)
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
        Group {
            Section {
                ForEach(Array(pcs.enumerated()), id: \.element.id) { i, p in
                    Button { editingIndex = i; editing = p } label: {
                        HStack {
                            Image(systemName: p.name.lowercased().contains("laptop") ? "laptopcomputer" : "desktopcomputer")
                            VStack(alignment: .leading) {
                                Text(p.name).foregroundStyle(.primary)
                                Text("\(p.host) · \(p.user)").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                    .buttonStyle(.plain)
                    .swipeActions { Button("Entfernen", role: .destructive) { pcs.remove(at: i); Task { await save() } } }
                }
                Button {
                    Task { await discover() }
                } label: {
                    HStack { Label("Im Heimnetz suchen", systemImage: "magnifyingglass"); if searching { Spacer(); ProgressView() } }
                }
                .disabled(searching || fritzUser.isEmpty)
                Button("Computer von Hand hinzufügen", systemImage: "plus") {
                    editingIndex = nil
                    editing = PcConfig(name: pcs.isEmpty ? "PC" : "Laptop", host: "", port: 22, user: pcs.first?.user ?? "", mac: "")
                }
                if let pcResult { Text(pcResult).font(.footnote.monospaced()) }
            } header: {
                Text("Computer")
            } footer: {
                Text("Jeder Befehl am Computer wird dir vorher unter „Freigaben“ angezeigt und läuft erst nach deinem Klick. Im Chat sprichst du sie mit Namen an, z. B. „Installiere VLC auf dem Laptop“.")
            }

            if !found.isEmpty {
                Section {
                    ForEach(found) { c in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.name)
                                Text("\(c.ip) · \(c.active ? "an" : "aus")\(c.windows == true ? " · Windows" : "")").font(.caption).foregroundStyle(.secondary)
                                Text(status(c)).font(.caption).foregroundStyle(c.ssh || c.configuredAs != nil ? .green : .orange)
                            }
                            Spacer()
                            if c.configuredAs == nil {
                                Button("Hinzufügen") {
                                    editingIndex = nil
                                    editing = PcConfig(name: suggestedName(c), host: c.ip, port: 22, user: pcs.first?.user ?? "", mac: c.mac)
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                    }
                } header: {
                    Text("Gefunden")
                } footer: {
                    Text("„Noch nicht bereit“: am Computer einmal den Einrichtungsbefehl (unten) ausführen, dann erneut suchen. Ausgeschaltete Computer zeigt die FRITZ!Box auch an.")
                }
            }
        }
        .sheet(item: $editing) { p in
            PcEditSheet(pc: p) { saved in
                if let i = editingIndex, pcs.indices.contains(i) { pcs[i] = saved } else { pcs.append(saved) }
                Task { await save(); await testPc(saved.name) }
            }
        }
    }

    private func status(_ c: DiscoveredPc) -> String {
        if let n = c.configuredAs { return "eingerichtet als „\(n)“" }
        if !c.active { return "aus – zum Prüfen einschalten" }
        return c.ssh ? "bereit zum Hinzufügen" : "noch nicht bereit (Einrichtungsbefehl fehlt)"
    }

    private func suggestedName(_ c: DiscoveredPc) -> String {
        let n = c.name.lowercased()
        if n.contains("laptop") || n.contains("book") || n.contains("notebook") || c.connection.contains("802.11") { return pcs.contains { $0.name == "Laptop" } ? c.name : "Laptop" }
        return pcs.contains { $0.name == "PC" } ? c.name : "PC"
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
        if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host "Bitte in 'Terminal (Administrator)' ausführen." -ForegroundColor Red; return }
        Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
        Start-Service sshd; Set-Service -Name sshd -StartupType Automatic
        New-ItemProperty -Path "HKLM:\\SOFTWARE\\OpenSSH" -Name DefaultShell -Value "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -PropertyType String -Force | Out-Null
        $f = "$env:ProgramData\\ssh\\administrators_authorized_keys"
        Add-Content -Force -Path $f -Value '\(publicKey)'
        icacls.exe $f /inheritance:r /grant "*S-1-5-32-544:F" /grant "*S-1-5-18:F" | Out-Null
        if (-not (Get-NetFirewallRule -Name sshd -ErrorAction SilentlyContinue)) { New-NetFirewallRule -Name sshd -DisplayName "OpenSSH Server" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -Profile Private }
        Write-Host "Fertig – Hausgeist kann sich jetzt anmelden."
        """
    }

    private func load() async {
        do {
            let s = try await APIClient(auth: auth).adminSettings()
            supported = s.pcs != nil
            if let f = s.fritzbox { fritzHost = f.host; fritzUser = f.user; fritzPasswordSet = f.password_set }
            pcs = s.pcs ?? ((s.pc?.host.isEmpty == false) ? [s.pc!] : [])
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
                pcs: pcs))
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

    private func testPc(_ name: String) async {
        busy = true; defer { busy = false }
        do {
            let r = try await APIClient(auth: auth).testPc(name: name)
            pcResult = "\(name): " + (r.ok ? "✅ " : "❌ ") + (r.message ?? "")
        } catch { pcResult = "\(name): ❌ \(error.localizedDescription)" }
    }

    private func discover() async {
        await save()
        searching = true; defer { searching = false }
        do { found = try await APIClient(auth: auth).discoverPcs(); error = nil }
        catch { self.error = error.localizedDescription }
    }

    private func forget() async {
        do {
            try await APIClient(auth: auth).forgetPcHost()
            pcResult = "Der PC wird beim nächsten Kontakt neu kennengelernt."
        } catch { self.error = error.localizedDescription }
    }
}


/// Computer bearbeiten (Name, Adresse, Windows-Benutzer, MAC).
struct PcEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State var pc: PcConfig
    var onSave: (PcConfig) -> Void

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name, z. B. PC oder Laptop", text: $pc.name)
                TextField("Adresse (IP oder Name im Heimnetz)", text: $pc.host).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("Windows-Benutzer", text: $pc.user).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("MAC-Adresse (zum Einschalten)", text: $pc.mac).textInputAutocapitalization(.characters).autocorrectionDisabled()
                Stepper("SSH-Port \(pc.port)", value: $pc.port, in: 1...65535)
            }
            .navigationTitle(pc.name.isEmpty ? "Computer" : pc.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Sichern") { onSave(pc); dismiss() }
                        .disabled(pc.name.isEmpty || pc.host.isEmpty || pc.user.isEmpty)
                }
            }
        }
    }
}
