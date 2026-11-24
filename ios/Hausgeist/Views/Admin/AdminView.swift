import SwiftUI

/// Einstieg in die Verwaltung. Erwachsene sehen nur ihre eigenen Postfächer.
struct AdminSection: View {
    let me: Me?

    var body: some View {
        if let me, me.role != "child" {
            Section {
                if me.role == "admin" {
                    NavigationLink { PeopleView() } label: { Label("Haushalt", systemImage: "person.3") }
                }
                NavigationLink { MailboxesView(me: me) } label: {
                    Label(me.role == "admin" ? "Postfächer" : "Meine Postfächer", systemImage: "envelope")
                }
                if me.role == "admin" {
                    NavigationLink { CalendarsAdminView() } label: { Label("Kalender", systemImage: "calendar") }
                    NavigationLink { AccountsView() } label: { Label("Konten & Empfänger", systemImage: "eurosign.bank.building") }
                    NavigationLink { SmartHomeView() } label: { Label("Smart Home", systemImage: "house") }
                    NavigationLink { BringView() } label: { Label("Einkaufslisten (Bring!)", systemImage: "cart") }
                    NavigationLink { NetworkPcView() } label: { Label("Netzwerk & PC", systemImage: "desktopcomputer") }
                    NavigationLink { TvView() } label: { Label("Fernseher (Couchpotato)", systemImage: "tv") }
                    NavigationLink { PlannerView() } label: { Label("Familienplaner", systemImage: "calendar.badge.checkmark") }
                    NavigationLink { RoutinesView() } label: { Label("Routinen & Ablage", systemImage: "clock.arrow.circlepath") }
                }
            } header: {
                Text("Verwaltung")
            } footer: {
                Text("Passwörter werden nur auf dem Home-Assistant-Server gespeichert und nie wieder angezeigt.")
            }
        }
    }
}

/// Kleine Helfer für alle Verwaltungs-Formulare.
struct ErrorBanner: View {
    let text: String?
    var body: some View {
        if let text {
            Section { Label(text, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
        }
    }
}

/// Uhrzeit als "HH:mm"-Text ↔ Date für den DatePicker.
func timeBinding(_ text: Binding<String>) -> Binding<Date> {
    Binding<Date>(
        get: {
            let parts = text.wrappedValue.split(separator: ":").compactMap { Int($0) }
            var c = DateComponents()
            c.hour = parts.first ?? 7
            c.minute = parts.count > 1 ? parts[1] : 0
            return Calendar.current.date(from: c) ?? Date()
        },
        set: { date in
            let c = Calendar.current.dateComponents([.hour, .minute], from: date)
            text.wrappedValue = String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
        }
    )
}

func roleName(_ r: String) -> String {
    switch r {
    case "admin": return "Admin"
    case "adult": return "Erwachsen"
    case "child": return "Kind"
    default: return r
    }
}

/// Besitzer-Auswahl für Kalender: "Gemeinsam" oder eine Person.
struct OwnerPicker: View {
    let title: String
    @Binding var owner: String
    let people: [Person]

    var body: some View {
        Picker(title, selection: $owner) {
            Text("Gemeinsam").tag("shared")
            ForEach(people) { p in Text(p.name).tag(p.name) }
        }
    }
}
