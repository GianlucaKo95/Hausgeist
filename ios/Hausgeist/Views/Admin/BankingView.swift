import SwiftUI

/// Online-Banking (FinTS): Produkt-ID, Bankzugänge und Schalter für echte Überweisungen.
struct OnlineBankingSection: View {
    @Environment(AuthService.self) private var auth
    @State private var settings: AdminSettings?
    @State private var productId = ""
    @State private var live = false
    @State private var confirmLive = false
    @State private var editing: BankLogin?
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
            Text("Zugangsdaten und PIN bleiben auf dem Pi. Freigegeben wird jede Überweisung zusätzlich in der Banking-App (S-pushTAN, BestSign, DKB-App) – der Hausgeist sieht nie eine TAN. Solange „Echte Überweisungen“ aus ist, läuft alles im Testmodus.")
        }
        .task { await load() }
        .sheet(item: $editing) { b in
            BankLoginForm(bank: b, productId: productId) { await load() }
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
    var onSaved: () async -> Void

    @State private var login = ""
    @State private var pin = ""
    @State private var url = ""
    @State private var busy = false
    @State private var testing = false
    @State private var result: BankTestResult?
    @State private var error: String?

    private var hint: String {
        switch bank.bank {
        case "sparkasse_duisburg": return "Anmeldename oder Legitimations-ID aus dem Online-Banking."
        case "deutsche_bank": return "Filiale + Kontonummer + Unterkonto (z. B. 3501234567 00) bzw. dein Login-Name."
        default: return "Dein DKB-Anmeldename."
        }
    }

    private var payload: BankLoginSave {
        BankLoginSave(login: login.trimmingCharacters(in: .whitespaces), pin: pin.isEmpty ? nil : pin,
                      url: url.isEmpty ? nil : url, fints_product_id: productId.isEmpty ? nil : productId)
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
                        Text("Falls die Bank fragt: Freigabe in der Banking-App bestätigen.").font(.caption).foregroundStyle(.secondary)
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

                if !bank.login.isEmpty {
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
            try await APIClient(auth: auth).saveBankLogin(bank: bank.bank, payload)
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
