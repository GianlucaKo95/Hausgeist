import SwiftUI

struct ApprovalsView: View {
    @Environment(AuthService.self) private var auth
    var onCount: (Int) -> Void

    @State private var list: ApprovalList?
    @State private var error: String?
    @State private var info: String?
    @State private var pendingPayment: PaymentApproval?
    @State private var pendingAction: ActionApproval?
    @State private var working: String?

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
                if let list {
                    if list.payments.isEmpty && list.actions.isEmpty {
                        ContentUnavailableView("Alles erledigt", systemImage: "checkmark.seal",
                                               description: Text("Keine offenen Freigaben."))
                    }
                    if !list.payments.isEmpty {
                        Section("Zahlungen") {
                            ForEach(list.payments) { p in paymentRow(p) }
                        }
                    }
                    if !list.actions.isEmpty {
                        Section("Weitere Aktionen") {
                            ForEach(list.actions) { a in actionRow(a) }
                        }
                    }
                } else if error == nil {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            .navigationTitle("Freigaben")
            .refreshable { await load() }
            .task { await load() }
            .alert("Hausgeist", isPresented: Binding(get: { info != nil }, set: { if !$0 { info = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(info ?? "") }
            .confirmationDialog("Zahlung freigeben?", isPresented: Binding(get: { pendingPayment != nil }, set: { if !$0 { pendingPayment = nil } }), titleVisibility: .visible, presenting: pendingPayment) { p in
                Button("\(euro(p.amount_cents)) an \(p.issuer) freigeben") { Task { await decide(payment: p, approve: true) } }
                Button("Abbrechen", role: .cancel) {}
            } message: { p in
                Text("IBAN \(p.iban)\nVon Konto: \(p.account ?? "—")")
            }
            .confirmationDialog("Aktion freigeben?", isPresented: Binding(get: { pendingAction != nil }, set: { if !$0 { pendingAction = nil } }), titleVisibility: .visible, presenting: pendingAction) { a in
                Button("Freigeben") { Task { await decide(action: a, approve: true) } }
                Button("Abbrechen", role: .cancel) {}
            } message: { a in Text(a.summary) }
        }
    }

    private func paymentRow(_ p: PaymentApproval) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(p.issuer).font(.headline)
                Spacer()
                Text(euro(p.amount_cents)).font(.headline.monospacedDigit())
            }
            payeeBadge(p.payee_status)
            Group {
                Text("IBAN \(p.iban)")
                if let due = p.due_date { Text("Fällig \(germanDate(due))") }
                if let acc = p.account { Text("Von Konto: \(acc)") }
                if let r = p.recipient_name { Text("Rechnung an: \(r)") }
                if let ref = p.reference { Text("Zweck: \(ref)") }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            if let note = p.note {
                Label(note, systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(.orange)
            }
            decisionButtons(enabled: p.can_decide, id: p.id,
                            approve: { pendingPayment = p },
                            reject: { Task { await decide(payment: p, approve: false) } })
            if !p.can_decide {
                Text("Das darf nur der Admin freigeben.").font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private func actionRow(_ a: ActionApproval) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(kindTitle(a.kind), systemImage: kindIcon(a.kind)).font(.headline)
            Text(a.summary).font(.subheadline).foregroundStyle(.secondary)
            decisionButtons(enabled: a.can_decide, id: a.id,
                            approve: { pendingAction = a },
                            reject: { Task { await decide(action: a, approve: false) } })
            if !a.can_decide {
                Text("Darüber entscheidet jemand anderes.").font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private func decisionButtons(enabled: Bool, id: String, approve: @escaping () -> Void, reject: @escaping () -> Void) -> some View {
        HStack {
            Button("Ablehnen", role: .destructive, action: reject)
                .buttonStyle(.bordered)
            Spacer()
            if working == id { ProgressView() }
            Button("Freigeben", action: approve)
                .buttonStyle(.borderedProminent)
        }
        .disabled(!enabled || working != nil)
        .padding(.top, 4)
    }

    private func payeeBadge(_ status: String) -> some View {
        let (text, color): (String, Color) = switch status {
        case "known": ("Bekannte IBAN", .green)
        case "iban_changed": ("IBAN GEÄNDERT", .red)
        default: ("Neuer Empfänger", .orange)
        }
        return Text(text)
            .font(.caption.bold())
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }

    private func kindTitle(_ k: String) -> String {
        switch k {
        case "send_mail": return "Mail senden"
        case "order": return "Bestellung"
        case "ha_service": return "Gerät schalten"
        case "calendar_event": return "Termin eintragen"
        default: return k
        }
    }

    private func kindIcon(_ k: String) -> String {
        switch k {
        case "send_mail": return "envelope"
        case "order": return "cart"
        case "ha_service": return "lock.shield"
        case "calendar_event": return "calendar"
        default: return "questionmark.circle"
        }
    }

    private func load() async {
        do {
            let l = try await APIClient(auth: auth).approvals()
            list = l
            error = nil
            onCount(l.payments.filter(\.can_decide).count + l.actions.filter(\.can_decide).count)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func decide(payment p: PaymentApproval, approve: Bool) async {
        working = p.id
        defer { working = nil }
        do {
            let r = try await APIClient(auth: auth).decide(payment: p.id, approve: approve)
            info = r.message
        } catch { info = error.localizedDescription }
        await load()
    }

    private func decide(action a: ActionApproval, approve: Bool) async {
        working = a.id
        defer { working = nil }
        do {
            let r = try await APIClient(auth: auth).decide(action: a.id, approve: approve)
            info = r.message
        } catch { info = error.localizedDescription }
        await load()
    }
}

func euro(_ cents: Int) -> String {
    (Double(cents) / 100).formatted(.currency(code: "EUR").locale(Locale(identifier: "de_DE")))
}

func germanDate(_ iso: String) -> String {
    let parts = iso.prefix(10).split(separator: "-")
    guard parts.count == 3 else { return iso }
    return "\(parts[2]).\(parts[1]).\(parts[0])"
}
