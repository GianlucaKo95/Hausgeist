import SwiftUI

struct RoutinesView: View {
    @Environment(AuthService.self) private var auth
    @State private var dailyBrief = "07:30"
    @State private var briefOn = true
    @State private var eveningCheck = "18:00"
    @State private var calendarInsights = true
    @State private var departures = true
    @State private var bufferMin = 10
    @State private var travelMode = "car"
    @State private var mailTriage = true
    @State private var mailTimes = "07:00, 12:00, 15:00, 19:00"
    @State private var weeklyOffers = true
    @State private var paperlessURL = ""
    @State private var paperlessToken = ""
    @State private var tokenSet = false
    @State private var pushEnabled = false
    @State private var error: String?
    @State private var info: String?
    @State private var loaded = false

    var body: some View {
        Form {
            ErrorBanner(text: error)
            if let info { Section { Label(info, systemImage: "checkmark.circle").foregroundStyle(.green) } }

            Section {
                Toggle("Tagesbriefing", isOn: $briefOn)
                if briefOn {
                    DatePicker("Uhrzeit", selection: timeBinding($dailyBrief), displayedComponents: .hourAndMinute)
                }
                Toggle("Mail-Überblick", isOn: $mailTriage)
                if mailTriage {
                    LabeledContent("Uhrzeiten") {
                        TextField("07:00, 12:00", text: $mailTimes).multilineTextAlignment(.trailing).keyboardType(.numbersAndPunctuation)
                    }
                }
            } header: {
                Text("Morgens")
            } footer: {
                Text("Fristen, Termine des Tages, fällige Aufgaben, offene Freigaben und wichtige Mails.")
            }

            Section {
                Toggle("Aus dem Kalender vorausdenken", isOn: $calendarInsights)
                if calendarInsights {
                    DatePicker("Abendliche Prüfung", selection: timeBinding($eveningCheck), displayedComponents: .hourAndMinute)
                }
            } footer: {
                Text("Erinnert z. B. am Vorabend an die Mülltonne oder vor Geburtstagen an Geschenke.")
            }

            Section {
                Toggle("Rechtzeitig losfahren", isOn: $departures)
                if departures {
                    Picker("Unterwegs", selection: $travelMode) {
                        Text("Auto").tag("car"); Text("Fahrrad").tag("bike"); Text("zu Fuß").tag("foot")
                    }
                    Stepper("Puffer \(bufferMin) Min.", value: $bufferMin, in: 0...60, step: 5)
                }
            } header: {
                Text("Termine")
            } footer: {
                Text("Vor Terminen mit Ort meldet sich der Hausgeist, wann du losmusst – nach Fahrzeit von deinem aktuellen Standort (Standort in den Einstellungen einschalten).")
            }

            Section {
                Toggle("Prospekt-Angebote am Montag", isOn: $weeklyOffers)
            } header: {
                Text("Einkauf")
            }

            Section {
                TextField("http://…:8000", text: $paperlessURL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField(tokenSet ? "API-Token (unverändert lassen)" : "API-Token", text: $paperlessToken)
            } header: {
                Text("Paperless-ngx")
            } footer: {
                Text("Optional: Rechnungen, Verträge und Scans werden dort abgelegt. Das Token findest du in Paperless unter Profil.")
            }

            Section {
                LabeledContent("Push über die Hausgeist-App", value: pushEnabled ? "aktiv" : "nicht eingerichtet")
            } footer: {
                if !pushEnabled { Text("Dafür in der Add-on-Konfiguration den APNs-Schlüssel eintragen (einmalig).") }
            }
        }
        .navigationTitle("Routinen & Ablage")
        .toolbar { Button("Sichern") { Task { await save() } }.disabled(!loaded) }
        .task { await load() }
    }

    private func load() async {
        do {
            let s = try await APIClient(auth: auth).adminSettings()
            briefOn = !s.daily_brief.isEmpty
            dailyBrief = s.daily_brief.isEmpty ? "07:30" : s.daily_brief
            eveningCheck = s.evening_check.isEmpty ? "18:00" : s.evening_check
            calendarInsights = s.calendar_insights; mailTriage = s.mail_triage; weeklyOffers = s.weekly_offers
            if let t = s.mail_check_times { mailTimes = t.joined(separator: ", ") }
            departures = s.departure_alerts ?? true; bufferMin = s.departure_buffer_min ?? 10; travelMode = s.travel_mode ?? "car"
            paperlessURL = s.paperless_url; tokenSet = s.paperless_token_set; pushEnabled = s.push_enabled
            loaded = true
        } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        do {
            try await APIClient(auth: auth).saveSettings(SettingsPatch(
                daily_brief: briefOn ? dailyBrief : "", evening_check: eveningCheck,
                mail_triage: mailTriage, weekly_offers: weeklyOffers, calendar_insights: calendarInsights,
                paperless_url: paperlessURL.trimmingCharacters(in: .whitespaces),
                paperless_token: paperlessToken.isEmpty ? nil : paperlessToken,
                departure_alerts: departures, departure_buffer_min: bufferMin, travel_mode: travelMode,
                mail_check_times: mailTimes.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }))
            if !paperlessToken.isEmpty { tokenSet = true; paperlessToken = "" }
            info = "Gespeichert"
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}
