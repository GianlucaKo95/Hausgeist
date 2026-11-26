import SwiftUI

/// Online-Banking (FinTS): Produkt-ID, Bankzugänge und Schalter für echte Überweisungen.
struct OnlineBankingSection: View {
    @Environment(AuthService.self) private var auth
    @State private var settings: AdminSettings?
    @State private var productId = ""
    @State private var live = false
    @State private var confirmLive = false
    @State private var editing: BankLogin?
    @State private var adding = false
    @State private var error: String?

    var body: some View {
        Section {
            ErrorBanner(text: error)
            if let settings, let banks = settings.banks {
                LabeledContent("Produkt-ID") {
                    TextField("aus der FinTS-Registrierung", text: $productId)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await save(SettingsPatch(fints_product_id: productId)) } }
                }
                ForEach(banks) { b in
                    Button { editing = b } label: {
                        HStack {
                            Text(b.name).foregroundStyle(.primary)
                            Spacer()
                            Text(b.login.isEmpty ? "nicht eingerichtet" : b.login)
                                .font(.callout).foregroundStyle(b.login.isEmpty ? .secondary : .primary)
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                    .buttonStyle(.plain)
                }
                Button("Bank hinzufügen", systemImage: "plus") { adding = true }
                Toggle("Echte Überweisungen", isOn: Binding(
                    get: { live },
                    set: { on in
                        if on { confirmLive = true } else { Task { await setLive(false) } }
                    }))
            } else if settings != nil {
                Text("Bitte das Add-on auf Version 0.9.0 aktualisieren.").foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
        } header: {
            Text("Online-Banking (FinTS)")
        } footer: {
            Text("Jede deutsche Bank mit Online-Banking (FinTS) lässt sich hinzufügen. Zugangsdaten und PIN bleiben auf dem Pi. Freigegeben wird jede Überweisung zusätzlich in der Banking-App der Bank – der Hausgeist sieht nie eine TAN. Solange „Echte Überweisungen“ aus ist, läuft alles im Testmodus.")
        }
        .task { await load() }
        .sheet(item: $editing) { b in
            BankLoginForm(bank: b, productId: productId, isNew: !(settings?.banks ?? []).contains { $0.bank == b.bank }) { await load() }
        }
        .sheet(isPresented: $adding) {
            BankSearchView { picked in
                adding = false
                editing = BankLogin(bank: "blz_\(picked.blz)", name: picked.name, default_url: picked.url, login: "", url: "", pin_set: false, blz: picked.blz)
            }
        }
        .alert("Echte Überweisungen einschalten?", isPresented: $confirmLive) {
            Button("Einschalten", role: .destructive) { Task { await setLive(true) } }
            Button("Abbrechen", role: .cancel) {}
        } message: {
            Text("Freigegebene Rechnungen werden dann wirklich überwiesen. Jede Zahlung musst du zusätzlich in der Banking-App bestätigen.")
        }
    }

    private func load() async {
        do {
            let s = try await APIClient(auth: auth).adminSettings()
            settings = s
            productId = s.fints_product_id ?? ""
            live = s.payment_mode == "fints"
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func save(_ patch: SettingsPatch) async {
        do {
            try await APIClient(auth: auth).saveSettings(patch)
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func setLive(_ on: Bool) async {
        do {
            try await APIClient(auth: auth).saveSettings(SettingsPatch(payment_mode: on ? "fints" : "dryrun", fints_product_id: productId))
            live = on
            error = nil
        } catch {
            live = false
            self.error = error.localizedDescription
        }
    }
}

struct BankLoginForm: View {
    @Environment(AuthService.self) private var auth
    @Environment(\.dismiss) private var dismiss
    let bank: BankLogin
    let productId: String
    var isNew = false
    var onSaved: () async -> Void

    @State private var login = ""
    @State private var pin = ""
    @State private var url = ""
    @State private var busy = false
    @State private var testing = false
    @State private var result: BankTestResult?
    @State private var error: String?

    private var hint: String {
        let n = bank.name.lowercased()
        if n.contains("sparkasse") { return "Anmeldename oder Legitimations-ID aus dem Online-Banking." }
        if n.contains("deutsche bank") { return "Filiale + Kontonummer + Unterkonto (z. B. 3501234567 00) bzw. dein Login-Name." }
        if n.contains("volksbank") || n.contains("raiffeisen") { return "VR-NetKey oder Alias aus dem Online-Banking." }
        if n.contains("comdirect") || n.contains("commerzbank") { return "Teilnehmernummer bzw. Zugangsnummer." }
        return "Der Anmeldename, mit dem du dich im Online-Banking anmeldest."
    }

    private var payload: BankLoginSave {
        BankLoginSave(login: login.trimmingCharacters(in: .whitespaces), pin: pin.isEmpty ? nil : pin,
                      url: url.isEmpty ? nil : url, fints_product_id: productId.isEmpty ? nil : productId,
                      name: bank.name, blz: bank.blz)
    }

    var body: some View {
        NavigationStack {
            Form {
                ErrorBanner(text: error)
                Section {
                    TextField("Anmeldename", text: $login)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField(bank.pin_set ? "PIN (gespeichert)" : "PIN", text: $pin)
                } footer: { Text(hint) }

                Section {
                    Button {
                        Task { await test() }
                    } label: {
                        HStack { Text("Verbindung testen"); if testing { Spacer(); ProgressView() } }
                    }
                    .disabled(testing || login.isEmpty || (pin.isEmpty && !bank.pin_set))
                    if testing {
                        Text("Falls die Bank fragt: Freigabe in der Banking-App bestätigen").font(.caption).foregroundStyle(.secondary)
                    }
                    if let result {
                        ForEach(result.accounts, id: \.self) { a in
                            VStack(alignment: .leading) {
                                Text(a.name ?? "Konto")
                                Text(a.iban).font(.caption.monospaced()).foregroundStyle(.secondary)
                            }
                        }
                        if !result.tanMethods.isEmpty {
                            LabeledContent("TAN-Verfahren", value: result.tanMethods.joined(separator: ", "))
                        }
                    }
                }

                Section("Erweitert") {
                    TextField(bank.default_url, text: $url)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .font(.callout)
                }

                if !isNew {
                    Section {
                        Button("Bankzugang entfernen", role: .destructive) { Task { await remove() } }
                    }
                }
            }
            .navigationTitle(bank.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Sichern") { Task { await save() } }
                        .disabled(busy || login.isEmpty || (pin.isEmpty && !bank.pin_set))
                }
            }
            .onAppear {
                login = bank.login
                url = bank.url
            }
        }
    }

    private func test() async {
        testing = true; defer { testing = false }
        do {
            result = try await APIClient(auth: auth).testBank(bank: bank.bank, payload)
            error = nil
        } catch {
            result = nil
            self.error = error.localizedDescription
        }
    }

    private func save() async {
        busy = true; defer { busy = false }
        do {
            if isNew { try await APIClient(auth: auth).createBankLogin(payload) }
            else { try await APIClient(auth: auth).saveBankLogin(bank: bank.bank, payload) }
            await onSaved()
            dismiss()
        } catch { self.error = error.localizedDescription }
    }

    private func remove() async {
        do {
            try await APIClient(auth: auth).deleteBankLogin(bank: bank.bank)
            await onSaved()
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}


/// Bank suchen: Name, Ort, Bankleitzahl oder einfach die IBAN eintippen.
struct BankSearchView: View {
    @Environment(AuthService.self) private var auth
    @Environment(\.dismiss) private var dismiss
    var onPick: (DirectoryBank) -> Void
    @State private var query = ""
    @State private var results: [DirectoryBank] = []
    @State private var searching = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                ErrorBanner(text: error)
                ForEach(results) { b in
                    Button { onPick(b) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(b.name).foregroundStyle(.primary)
                            Text("\(b.location) · BLZ \(b.blz)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                if !searching && results.isEmpty && query.count >= 2 {
                    Text("Keine Bank mit Online-Banking-Zugang (FinTS) gefunden").foregroundStyle(.secondary)
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Name, Ort, Bankleitzahl oder IBAN")
            .task(id: query) {
                guard query.trimmingCharacters(in: .whitespaces).count >= 2 else { results = []; return }
                try? await Task.sleep(for: .milliseconds(300))
                if Task.isCancelled { return }
                searching = true; defer { searching = false }
                do { results = try await APIClient(auth: auth).searchBanks(query); error = nil }
                catch { self.error = error.localizedDescription }
            }
            .navigationTitle("Bank hinzufügen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } } }
        }
    }
}
