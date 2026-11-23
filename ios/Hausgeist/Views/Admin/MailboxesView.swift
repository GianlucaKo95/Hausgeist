import SwiftUI

struct MailProvider: Identifiable, Hashable {
    var id: String { name }
    let name: String
    let imap: String
    let smtp: String
    let smtpPort: Int
    let hint: String?

    static let all: [MailProvider] = [
        MailProvider(name: "Gmail", imap: "imap.gmail.com", smtp: "smtp.gmail.com", smtpPort: 587,
                     hint: "Braucht ein App-Passwort (Google-Konto → Sicherheit → App-Passwörter)."),
        MailProvider(name: "iCloud", imap: "imap.mail.me.com", smtp: "smtp.mail.me.com", smtpPort: 587,
                     hint: "Braucht ein app-spezifisches Passwort (account.apple.com)."),
        MailProvider(name: "GMX", imap: "imap.gmx.net", smtp: "mail.gmx.net", smtpPort: 587,
                     hint: "IMAP muss in den GMX-Einstellungen aktiviert sein."),
        MailProvider(name: "WEB.DE", imap: "imap.web.de", smtp: "smtp.web.de", smtpPort: 587,
                     hint: "IMAP muss in den WEB.DE-Einstellungen aktiviert sein."),
        MailProvider(name: "IONOS", imap: "imap.ionos.de", smtp: "smtp.ionos.de", smtpPort: 587, hint: nil),
        MailProvider(name: "Strato", imap: "imap.strato.de", smtp: "smtp.strato.de", smtpPort: 465, hint: nil),
        MailProvider(name: "T-Online", imap: "secureimap.t-online.de", smtp: "securesmtp.t-online.de", smtpPort: 465,
                     hint: "Braucht das E-Mail-Passwort aus dem Kundencenter."),
        MailProvider(name: "Outlook / Hotmail", imap: "outlook.office365.com", smtp: "smtp.office365.com", smtpPort: 587,
                     hint: "Microsoft erlaubt die Anmeldung mit Passwort teils nicht mehr – dann klappt der Test nicht."),
    ]
}

struct MailboxesView: View {
    @Environment(AuthService.self) private var auth
    let me: Me
    @State private var boxes: [Mailbox] = []
    @State private var people: [Person] = []
    @State private var error: String?
    @State private var editing: Mailbox?
    @State private var creating = false

    var body: some View {
        List {
            ErrorBanner(text: error)
            if boxes.isEmpty && error == nil {
                ContentUnavailableView("Noch keine Postfächer", systemImage: "envelope",
                                       description: Text("Der Hausgeist liest Rechnungen, Verträge und Termine aus deinen Postfächern."))
            }
            ForEach(boxes) { b in
                Button { editing = b } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(b.name).foregroundStyle(.primary)
                        Text("\(b.user) · \(b.visibility == "shared" ? "gemeinsam" : "privat") · \(b.scope == "business" ? "geschäftlich" : "privat")")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle(me.role == "admin" ? "Postfächer" : "Meine Postfächer")
        .toolbar { Button("Hinzufügen", systemImage: "plus") { creating = true } }
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $editing) { b in MailboxForm(me: me, box: b, people: people) { await load() } }
        .sheet(isPresented: $creating) { MailboxForm(me: me, box: nil, people: people) { await load() } }
    }

    private func load() async {
        let api = APIClient(auth: auth)
        do {
            boxes = try await api.mailboxes()
            people = (try? await api.people()) ?? []
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

struct MailboxForm: View {
    @Environment(AuthService.self) private var auth
    @Environment(\.dismiss) private var dismiss
    let me: Me
    let box: Mailbox?
    let people: [Person]
    var onSaved: () async -> Void

    @State private var name = ""
    @State private var user = ""
    @State private var password = ""
    @State private var host = ""
    @State private var port = 993
    @State private var tls = true
    @State private var smtpHost = ""
    @State private var smtpPort = 587
    @State private var fromName = ""
    @State private var ownerId = ""
    @State private var visibility = "private"
    @State private var scope = "private"
    @State private var hint: String?
    @State private var testResult: String?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                ErrorBanner(text: error)
                if box == nil {
                    Section("Anbieter") {
                        Menu {
                            ForEach(MailProvider.all) { p in Button(p.name) { apply(p) } }
                        } label: {
                            Label("Vorlage wählen", systemImage: "wand.and.stars")
                        }
                        if let hint { Text(hint).font(.footnote).foregroundStyle(.secondary) }
                    }
                }
                Section("Konto") {
                    TextField("Name im Hausgeist, z. B. Privat", text: $name)
                    TextField("E-Mail / Benutzername", text: $user)
                        .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField(box?.password_set == true ? "Passwort (unverändert lassen)" : "Passwort", text: $password)
                    TextField("Absendername (optional)", text: $fromName)
                }
                Section("Posteingang (IMAP)") {
                    TextField("Server", text: $host).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Stepper("Port \(port)", value: $port, in: 1...65535)
                    Toggle("SSL/TLS", isOn: $tls)
                }
                Section {
                    TextField("Server (optional)", text: $smtpHost).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Stepper("Port \(smtpPort)", value: $smtpPort, in: 1...65535)
                } header: {
                    Text("Senden (SMTP)")
                } footer: {
                    Text("Nur nötig, wenn der Hausgeist nach deiner Freigabe Mails verschicken soll.")
                }
                Section("Zugriff") {
                    if me.role == "admin" {
                        Picker("Besitzer", selection: $ownerId) {
                            Text("Niemand (Haushalt)").tag("")
                            ForEach(people.filter { $0.role != "child" }) { p in Text(p.name).tag(p.id) }
                        }
                    }
                    Picker("Sichtbar für", selection: $visibility) {
                        Text("Nur Besitzer").tag("private")
                        Text("Alle Erwachsenen").tag("shared")
                    }
                    Picker("Art", selection: $scope) {
                        Text("Privat").tag("private")
                        Text("Geschäftlich (KoeVen)").tag("business")
                    }
                }
                Section {
                    Button { Task { await test() } } label: {
                        HStack { Text("Verbindung testen"); if busy { Spacer(); ProgressView() } }
                    }
                    .disabled(busy || host.isEmpty || user.isEmpty)
                    if let testResult { Text(testResult).font(.footnote) }
                }
                if let box {
                    Section { Button("Postfach entfernen", role: .destructive) { Task { await delete(box) } } }
                }
            }
            .navigationTitle(box?.name ?? "Neues Postfach")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Sichern") { Task { await save() } }
                        .disabled(busy || name.isEmpty || host.isEmpty || user.isEmpty || (box == nil && password.isEmpty))
                }
            }
            .onAppear(perform: fill)
        }
    }

    private func fill() {
        guard let b = box else {
            ownerId = me.role == "admin" ? (people.first { $0.name == me.name }?.id ?? "") : ""
            return
        }
        name = b.name; user = b.user; host = b.host; port = b.port; tls = b.tls
        smtpHost = b.smtp_host ?? ""; smtpPort = b.smtp_port ?? 587; fromName = b.from_name ?? ""
        ownerId = b.owner_id ?? ""; visibility = b.visibility; scope = b.scope
    }

    private func apply(_ p: MailProvider) {
        host = p.imap; port = 993; tls = true; smtpHost = p.smtp; smtpPort = p.smtpPort; hint = p.hint
        if name.isEmpty { name = p.name }
    }

    private var payload: MailboxSave {
        MailboxSave(original_name: box?.name, name: name.trimmingCharacters(in: .whitespaces), host: host.trimmingCharacters(in: .whitespaces),
                    port: port, tls: tls, user: user.trimmingCharacters(in: .whitespaces),
                    password: password.isEmpty ? nil : password, folder: nil,
                    smtp_host: smtpHost.isEmpty ? nil : smtpHost.trimmingCharacters(in: .whitespaces),
                    smtp_port: smtpHost.isEmpty ? nil : smtpPort, from_name: fromName.isEmpty ? nil : fromName,
                    owner_id: ownerId.isEmpty ? nil : ownerId, visibility: visibility, scope: scope)
    }

    private func test() async {
        busy = true; defer { busy = false }
        do {
            let r = try await APIClient(auth: auth).testMailbox(payload)
            testResult = "✅ Posteingang ok (\(r.folders.count) Ordner) · Senden: \(r.smtp)"
        } catch { testResult = "❌ \(error.localizedDescription)" }
    }

    private func save() async {
        busy = true; defer { busy = false }
        do {
            try await APIClient(auth: auth).saveMailbox(payload)
            await onSaved()
            dismiss()
        } catch { self.error = error.localizedDescription }
    }

    private func delete(_ b: Mailbox) async {
        do {
            try await APIClient(auth: auth).deleteMailbox(name: b.name)
            await onSaved()
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
