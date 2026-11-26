import SwiftUI

// MARK: - Daten

struct Overview: Decodable {
    struct Event: Decodable, Hashable {
        let title: String
        let start: String
        let end: String?
        let all_day: Bool
        let location: String?
        let calendar: String
    }
    struct Figure: Decodable, Hashable {
        let value: Double
        let unit: String?
    }
    struct Recent: Decodable, Hashable, Identifiable {
        let id: String
        let title: String
        let category: String?
        let updated_at: String
    }
    let approvals: Int
    let events: [Event]?
    let energy: [String: Figure]?
    let recent: [Recent]
}

extension APIClient {
    func overview() async throws -> Overview {
        if AppConfig.isDemo { return DemoData.overview }
        return try await request("api/overview")
    }
}

// MARK: - Startseite

/// „Zuhause“: was heute ansteht, was auf eine Entscheidung wartet, wie es ums Haus steht.
struct HomeView: View {
    @Environment(AuthService.self) private var auth
    let me: Me?
    var onVoice: () -> Void
    var onChat: () -> Void
    var onApprovals: () -> Void
    var onConversation: (String) -> Void

    @State private var data: Overview?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    hero
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }

                if let error {
                    Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.secondary) }
                }

                if let n = data?.approvals, n > 0 {
                    Section {
                        Button(action: onApprovals) {
                            HStack(spacing: 12) {
                                Image(systemName: "checkmark.shield")
                                    .foregroundStyle(.tint)
                                    .frame(width: 24)
                                Text(n == 1 ? "1 Freigabe wartet auf dich" : "\(n) Freigaben warten auf dich")
                                    .foregroundStyle(.primary)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.footnote.weight(.medium))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }

                if let events = data?.events {
                    Section("Als Nächstes") {
                        if events.isEmpty {
                            Text("Keine Termine in den nächsten zwei Tagen")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(events, id: \.self) { e in eventRow(e) }
                    }
                }

                if let energy = data?.energy, !energy.isEmpty {
                    Section("Energie") { energyGrid(energy) }
                }

                if let recent = data?.recent, !recent.isEmpty {
                    Section("Zuletzt besprochen") {
                        ForEach(recent) { c in
                            Button { onConversation(c.id) } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: ConversationsView.icon(c.category ?? "Allgemein"))
                                        .foregroundStyle(.secondary)
                                        .frame(width: 24)
                                    Text(c.title)
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)
                                    Spacer()
                                    Text(relative(c.updated_at))
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Zuhause")
            .refreshable { await load() }
            .task { await load() }
        }
    }

    // Der eine farbige Moment: der Geist in seinem Nachtblau
    private var hero: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .bottom, spacing: 16) {
                Ghost(width: 40)
                VStack(alignment: .leading, spacing: 4) {
                    Text(Date.now.formatted(.dateTime.weekday(.wide).day().month(.wide)))
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.7))
                    Text("Was soll ich erledigen?")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.white)
                }
            }
            HStack(spacing: 12) {
                Button(action: onVoice) {
                    Label("Sprechen", systemImage: "waveform")
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .foregroundStyle(HGColor.night)
                        .background(.white, in: RoundedRectangle(cornerRadius: 12))
                }
                Button(action: onChat) {
                    Label("Schreiben", systemImage: "square.and.pencil")
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .foregroundStyle(.white)
                        .background(.white.opacity(0.14), in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .font(.body.weight(.medium))
            .buttonStyle(.plain)
        }
        .padding(20)
        .background(HGColor.night, in: RoundedRectangle(cornerRadius: 20))
    }

    private func eventRow(_ e: Overview.Event) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(when(e))
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 92, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(e.title).lineLimit(2)
                Text([e.location, e.calendar].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    private func energyGrid(_ energy: [String: Overview.Figure]) -> some View {
        let order: [(String, String)] = [("pv_power", "Solar"), ("battery_soc", "Speicher"), ("house_power", "Haus"), ("grid_power", "Netz")]
        let items = order.compactMap { key, label in energy[key].map { (label, $0) } }
        return Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
            ForEach(Array(stride(from: 0, to: items.count, by: 2)), id: \.self) { i in
                GridRow {
                    figure(items[i])
                    if i + 1 < items.count { figure(items[i + 1]) } else { Color.clear.gridCellUnsizedAxes([.horizontal, .vertical]) }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func figure(_ item: (String, Overview.Figure)) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(item.0).font(.footnote).foregroundStyle(.secondary)
            Text(format(item.1)).font(.title3.weight(.medium).monospacedDigit())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Formatierung

    private func format(_ f: Overview.Figure) -> String {
        let unit = f.unit ?? ""
        if unit == "W", abs(f.value) >= 1000 {
            return (f.value / 1000).formatted(.number.precision(.fractionLength(1))) + " kW"
        }
        if unit == "%" { return Int(f.value.rounded()).formatted() + " %" }
        return f.value.formatted(.number.precision(.fractionLength(0))) + (unit.isEmpty ? "" : " \(unit)")
    }

    private func parse(_ s: String) -> Date? {
        if let d = ISO8601DateFormatter.flexible.date(from: s) ?? ISO8601DateFormatter().date(from: s) { return d }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: String(s.prefix(10)))
    }

    private func when(_ e: Overview.Event) -> String {
        guard let d = parse(e.start) else { return "" }
        let cal = Calendar.current
        let day: String = cal.isDateInToday(d) ? "Heute" : cal.isDateInTomorrow(d) ? "Morgen" : d.formatted(.dateTime.weekday(.abbreviated))
        if e.all_day { return day }
        return "\(day) \(d.formatted(date: .omitted, time: .shortened))"
    }

    private func relative(_ s: String) -> String {
        guard let d = parse(s) else { return "" }
        return d.formatted(.relative(presentation: .named))
    }

    private func load() async {
        guard AppConfig.serverURL != nil || AppConfig.isDemo else {
            error = "Noch kein Server eingetragen – unter Einstellungen"
            return
        }
        do {
            data = try await APIClient(auth: auth).overview()
            error = nil
        } catch {
            self.error = "Übersicht nicht erreichbar – Add-on aktuell?"
        }
    }
}
