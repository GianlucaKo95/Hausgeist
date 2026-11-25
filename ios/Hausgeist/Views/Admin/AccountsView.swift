import SwiftUI

/// Hinterlegte Bankzugänge (für Namen und Auswahl) – wird beim Öffnen der Konten geladen.
@MainActor private var knownBanks: [BankLogin] = []

@MainActor private func bankName(_ id: String) -> String {
    if let b = knownBanks.first(where: { $0.bank == id }) { return b.name }
    if id.hasPrefix("blz_") { return "BLZ \(id.dropFirst(4))" }
    return id
}

private func formatIBAN(_ s: String) -> String {
    let clean = s.replacingOccurrences(of: " ", with: "").uppercased()
    return stride(from: 0, to: clean.count, by: 4).map { i -> String in
        let start = clean.index(clean.startIndex, offsetBy: i)
        let end = clean.index(start, offsetBy: min(4, clean.count - i))
        return String(clean[start..<end])
    }.joined(separator: " ")
}

struct AccountsView: View {
    @Environment(AuthService.self) private var auth
    @State private var accounts: [BankAccount] = []
    @State private var payees: [Payee] = []
    @State private var people: [Person] = []
    @State private var error: String?
    @State private var editing: BankAccount?
    @State private var creating = false
    @State private var addingPayee = false

    var body: some View {
        List {
            ErrorBanner(text: error)
            Section {
                ForEach(accounts) { a in
                    Button { editing = a } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(a.label).foregroundStyle(.primary)
                                if a.is_default { Text("Standard").font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 2).background(.blue.opacity(0.15), in: Capsule()) }
                            }
                            Text("\(bankName(a.bank)) · \(formatIBAN(a.iban))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .buttonStyle(.plain)
                Button("Konto hinzufügen", systemImage: "plus") { creating = true }
            } header: {
                Text("Eigene Konten")
            } footer: {
                Text("Aus diesen Konten schlägt der Hausgeist das passende Zahlerkonto vor.")
            }

            OnlineBankingSection()

            Section {
                ForEach(payees) { p in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(p.name)
                        ForEach(p.ibans, id: \.self) { Text(formatIBAN($0)).font(.caption).foregroundStyle(.secondary) }
                    }
                }
                .onDelete { idx in
                    let ids = idx.map { payees[$0].id }
                    Task { for id in ids { try? await APIClient(auth: auth).deletePayee(id: id) }; await load() }
                }
                Button("Empfänger hinzufügen", systemImage: "plus") { addingPayee = true }
            } header: {
                Text("Geprüfte Zahlungsempfänger")
            } footer: {
                Text("Rechnungen an diese IBANs gelten als bekannt. Neue oder geänderte IBANs gibt immer nur der Admin frei.")
            }
        }
        .navigationTitle("Konten & Empfänger")
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $editing) { a in AccountForm(account: a, people: people) { await load() } }
        .sheet(isPresented: $creating) { AccountForm(account: nil, people: people) { await load() } }
        .sheet(isPresented: $addingPayee) { PayeeForm(accounts: accounts) { await load() } }
    }

    private func load() async {
        let api = APIClient(auth: auth)
        do {
            knownBanks = (try? await api.adminSettings().banks) ?? knownBanks
            accounts = try await api.accounts()
            payees = try await api.payees()
            people = (try? await api.people()) ?? []
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

struct AccountForm: View {
    @Environment(AuthService.self) private var auth
    @Environment(\.dismiss) private var dismiss
    let account: BankAccount?
    let people: [Person]
    var onSaved: () async -> Void

    @State private var label = ""
    @State private var bank = ""
    @State private var iban = ""
    @State private var holder = ""
    @State private var matchNames = ""
    @State private var isDefault = false
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                ErrorBanner(text: error)
                Section {
                    TextField("Bezeichnung, z. B. Sparkasse Giro", text: $label)
                    Picker("Bankzugang", selection: $bank) {
                        Text("Automatisch (aus der IBAN)").tag("")
                        ForEach(knownBanks) { Text($0.name).tag($0.bank) }
                        if !bank.isEmpty && !knownBanks.contains(where: { $0.bank == bank }) { Text(bankName(bank)).tag(bank) }
                    }
                    TextField("IBAN", text: $iban).textInputAutocapitalization(.characters).autocorrectionDisabled()
                    Picker("Inhaber", selection: $holder) {
                        Text("—").tag("")
                        ForEach(people.filter { $0.role != "child" }) { Text($0.name).tag($0.id) }
                    }
                    Toggle("Standardkonto", isOn: $isDefault)
                }
                Section {
                    TextField("z. B. KoeVen GbR, Köhni", text: $matchNames)
                } header: {
                    Text("Bezahlt Rechnungen an")
                } footer: {
                    Text("Namen durch Komma trennen. Steht einer davon als Rechnungsempfänger auf der Rechnung, wird dieses Konto vorgeschlagen.")
                }
                if let account {
                    Section { Button("Konto entfernen", role: .destructive) { Task { await delete(account) } } }
                }
            }
            .navigationTitle(account?.label ?? "Neues Konto")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Sichern") { Task { await save() } }.disabled(busy || label.isEmpty || iban.isEmpty)
                }
            }
            .onAppear {
                if let a = account {
                    label = a.label; bank = a.bank; iban = formatIBAN(a.iban); holder = a.holder_id ?? ""
                    matchNames = a.match_names.joined(separator: ", "); isDefault = a.is_default
                }
            }
        }
    }

    private func save() async {
        busy = true; defer { busy = false }
        let names = matchNames.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        do {
            try await APIClient(auth: auth).saveAccount(id: account?.id, BankAccountSave(
                label: label, bank: bank, iban: iban, holder_id: holder.isEmpty ? nil : holder, match_names: names, is_default: isDefault))
            await onSaved()
            dismiss()
        } catch { self.error = error.localizedDescription }
    }

    private func delete(_ a: BankAccount) async {
        do {
            try await APIClient(auth: auth).deleteAccount(id: a.id)
            await onSaved()
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

struct PayeeForm: View {
    @Environment(AuthService.self) private var auth
    @Environment(\.dismiss) private var dismiss
    let accounts: [BankAccount]
    var onSaved: () async -> Void

    @State private var name = ""
    @State private var iban = ""
    @State private var account = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                ErrorBanner(text: error)
                Section {
                    TextField("Name, z. B. Stadtwerke Duisburg", text: $name)
                    TextField("IBAN", text: $iban).textInputAutocapitalization(.characters).autocorrectionDisabled()
                    Picker("Bezahlen von", selection: $account) {
                        Text("automatisch").tag("")
                        ForEach(accounts) { Text($0.label).tag($0.id) }
                    }
                } footer: {
                    Text("Nur IBANs eintragen, die du selbst geprüft hast – z. B. vom Vertrag oder aus dem Kundenportal.")
                }
            }
            .navigationTitle("Neuer Empfänger")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Sichern") {
                        Task {
                            do {
                                try await APIClient(auth: auth).savePayee(PayeeSave(name: name, iban: iban, default_account_id: account.isEmpty ? nil : account))
                                await onSaved()
                                dismiss()
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                    .disabled(name.isEmpty || iban.isEmpty)
                }
            }
        }
    }
}
