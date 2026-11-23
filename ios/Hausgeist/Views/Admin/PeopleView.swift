import SwiftUI

struct PeopleView: View {
    @Environment(AuthService.self) private var auth
    @State private var people: [Person] = []
    @State private var error: String?
    @State private var editing: Person?
    @State private var creating = false

    var body: some View {
        List {
            ErrorBanner(text: error)
            Section {
                ForEach(people) { p in
                    Button { editing = p } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(p.name).foregroundStyle(.primary)
                                Text(p.email ?? "kein Login").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(roleName(p.role)).foregroundStyle(.secondary)
                            if p.has_login { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
                        }
                    }
                }
                .buttonStyle(.plain)
            } footer: {
                Text("Wer sich in der App anmelden soll, braucht hier eine E-Mail-Adresse und ein Konto mit derselben Adresse in Supabase (Authentication → Users).")
            }
        }
        .navigationTitle("Haushalt")
        .toolbar { Button("Hinzufügen", systemImage: "plus") { creating = true } }
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $editing) { p in PersonForm(person: p) { await load() } }
        .sheet(isPresented: $creating) { PersonForm(person: nil) { await load() } }
    }

    private func load() async {
        do { people = try await APIClient(auth: auth).people(); error = nil } catch { self.error = error.localizedDescription }
    }
}

struct PersonForm: View {
    @Environment(AuthService.self) private var auth
    @Environment(\.dismiss) private var dismiss
    let person: Person?
    var onSaved: () async -> Void

    @State private var name = ""
    @State private var role = "adult"
    @State private var email = ""
    @State private var limit = 500.0
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                ErrorBanner(text: error)
                Section {
                    TextField("Name", text: $name)
                    Picker("Rolle", selection: $role) {
                        Text("Admin").tag("admin")
                        Text("Erwachsen").tag("adult")
                        Text("Kind").tag("child")
                    }
                    TextField("E-Mail für den Login (optional)", text: $email)
                        .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                if role == "adult" {
                    Section {
                        Stepper(value: $limit, in: 0...10_000, step: 50) {
                            LabeledContent("Freigabe-Limit", value: euro(Int(limit * 100)))
                        }
                    } footer: {
                        Text("Bis zu diesem Betrag darf diese Person Zahlungen und Bestellungen freigeben. Darüber entscheidet der Admin.")
                    }
                }
                if let person {
                    Section {
                        Button("Person entfernen", role: .destructive) { Task { await delete(person) } }
                    }
                }
            }
            .navigationTitle(person == nil ? "Neue Person" : person!.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Sichern") { Task { await save() } }.disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear {
                if let p = person {
                    name = p.name; role = p.role; email = p.email ?? ""; limit = Double(p.approval_limit_cents) / 100
                }
            }
        }
    }

    private func save() async {
        busy = true; defer { busy = false }
        let mail = email.trimmingCharacters(in: .whitespaces)
        do {
            try await APIClient(auth: auth).savePerson(id: person?.id, PersonSave(
                name: name.trimmingCharacters(in: .whitespaces), role: role,
                email: mail.isEmpty ? nil : mail, approval_limit_euro: role == "adult" ? limit : 0))
            await onSaved()
            dismiss()
        } catch { self.error = error.localizedDescription }
    }

    private func delete(_ p: Person) async {
        do {
            try await APIClient(auth: auth).deletePerson(id: p.id)
            await onSaved()
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
