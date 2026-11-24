import SwiftUI

private let domainNames: [String: String] = [
    "light": "Licht", "switch": "Schalter", "climate": "Heizung/Klima", "cover": "Rollläden/Tore",
    "lock": "Schlösser", "sensor": "Sensoren", "binary_sensor": "Melder", "fan": "Lüfter", "media_player": "Medien",
    "vacuum": "Saugroboter", "scene": "Szenen", "script": "Skripte", "input_boolean": "Helfer", "button": "Tasten",
    "alarm_control_panel": "Alarmanlage", "water_heater": "Warmwasser", "valve": "Ventile", "siren": "Sirenen",
]
private let sensitive: Set<String> = ["lock", "alarm_control_panel", "cover", "siren", "valve"]

struct SmartHomeView: View {
    @Environment(AuthService.self) private var auth
    @State private var entities: [HAEntity] = []
    @State private var allowed: Set<String> = []
    @State private var patterns: [String] = []
    @State private var energy = EnergySensors()
    @State private var detecting = false
    @State private var search = ""
    @State private var error: String?
    @State private var info: String?
    @State private var busy = false

    private var filtered: [HAEntity] {
        let q = search.lowercased()
        return entities.filter { q.isEmpty || $0.name.lowercased().contains(q) || $0.entity_id.contains(q) }
    }

    private var domains: [String] {
        Array(Set(filtered.map(\.domain))).sorted { (domainNames[$0] ?? $0) < (domainNames[$1] ?? $1) }
    }

    private var sensors: [HAEntity] { entities.filter { $0.domain == "sensor" } }

    var body: some View {
        Form {
            ErrorBanner(text: error)
            if let info { Section { Label(info, systemImage: "checkmark.circle").foregroundStyle(.green) } }

            Section {
                energyPicker("PV-Leistung", \.pv_power)
                energyPicker("Speicher-Ladestand", \.battery_soc)
                energyPicker("Speicher-Leistung", \.battery_power)
                energyPicker("Netz (Bezug/Einspeisung)", \.grid_power)
                energyPicker("Hausverbrauch", \.house_power)
                Button {
                    Task { await detect() }
                } label: {
                    HStack { Label("Automatisch erkennen", systemImage: "wand.and.stars"); if detecting { Spacer(); ProgressView() } }
                }
                .disabled(detecting)
            } header: {
                Text("Energie")
            } footer: {
                Text("Damit plant der Hausgeist Verbraucher bei PV-Überschuss und warnt bei vollem Speicher. „Automatisch erkennen“ nutzt dein Energie-Dashboard in Home Assistant und die Gerätenamen – danach prüfen und sichern.")
            }

            if !patterns.isEmpty {
                Section("Regeln aus der Konfiguration") {
                    ForEach(patterns, id: \.self) { Text($0).font(.body.monospaced()) }
                        .onDelete { patterns.remove(atOffsets: $0) }
                }
            }

            ForEach(domains, id: \.self) { domain in
                Section {
                    ForEach(filtered.filter { $0.domain == domain }) { e in
                        Toggle(isOn: Binding(
                            get: { allowed.contains(e.entity_id) || patterns.contains { matches(e.entity_id, $0) } },
                            set: { on in if on { allowed.insert(e.entity_id) } else { allowed.remove(e.entity_id) } })) {
                            VStack(alignment: .leading) {
                                Text(e.name)
                                Text("\(e.entity_id) · \(e.state)\(e.unit.map { " \($0)" } ?? "")").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .disabled(patterns.contains { matches(e.entity_id, $0) })
                    }
                } header: {
                    Text(domainNames[domain] ?? domain)
                } footer: {
                    if sensitive.contains(domain) { Text("Wird nur nach Freigabe geschaltet – nie automatisch oder zeitgesteuert.") }
                }
            }
        }
        .searchable(text: $search, prompt: "Gerät suchen")
        .navigationTitle("Smart Home")
        .toolbar { Button("Sichern") { Task { await save() } }.disabled(busy) }
        .task { await load() }
    }

    private func detect() async {
        detecting = true; defer { detecting = false }
        do {
            let r = try await APIClient(auth: auth).detectEnergy()
            energy = EnergySensors(pv_power: r.pick.pv_power ?? energy.pv_power, battery_soc: r.pick.battery_soc ?? energy.battery_soc,
                                   battery_power: r.pick.battery_power ?? energy.battery_power, grid_power: r.pick.grid_power ?? energy.grid_power,
                                   house_power: r.pick.house_power ?? energy.house_power)
            let n = [r.pick.pv_power, r.pick.battery_soc, r.pick.battery_power, r.pick.grid_power, r.pick.house_power].compactMap { $0 }.count
            info = "\(n) von 5 Sensoren gefunden\(r.fromDashboard ? " (über das Energie-Dashboard)" : "") – bitte prüfen und sichern."
        } catch { self.error = error.localizedDescription }
    }

    private func energyPicker(_ title: String, _ key: WritableKeyPath<EnergySensors, String?>) -> some View {
        Picker(title, selection: Binding(get: { energy[keyPath: key] ?? "" }, set: { energy[keyPath: key] = $0.isEmpty ? nil : $0 })) {
            Text("—").tag("")
            ForEach(sensors) { s in Text("\(s.name)\(s.unit.map { " (\($0))" } ?? "")").tag(s.entity_id) }
        }
    }

    /// Platzhalter-Regeln wie "climate.*" aus der Add-on-Konfiguration.
    private func matches(_ id: String, _ pattern: String) -> Bool {
        guard pattern.contains("*") else { return false }
        let parts = pattern.split(separator: "*", omittingEmptySubsequences: false).map(String.init)
        guard let first = parts.first, id.hasPrefix(first) else { return false }
        var rest = Substring(id.dropFirst(first.count))
        for p in parts.dropFirst() where !p.isEmpty {
            guard let r = rest.range(of: p) else { return false }
            rest = rest[r.upperBound...]
        }
        return parts.last?.isEmpty == true || id.hasSuffix(parts.last ?? "")
    }

    private func load() async {
        let api = APIClient(auth: auth)
        do {
            let s = try await api.adminSettings()
            entities = try await api.haEntities()
            patterns = s.ha_entities.filter { $0.contains("*") }
            allowed = Set(s.ha_entities.filter { !$0.contains("*") })
            energy = s.energy
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        busy = true; defer { busy = false }
        // Energiesensoren müssen lesbar sein – sie kommen automatisch auf die Liste.
        let energyIds = [energy.pv_power, energy.battery_soc, energy.battery_power, energy.grid_power, energy.house_power].compactMap { $0 }
        let list = Array(Set(patterns).union(allowed).union(energyIds)).sorted()
        do {
            try await APIClient(auth: auth).saveSettings(SettingsPatch(ha_entities: list, energy: energy))
            info = "Gespeichert – \(list.count) Einträge freigegeben"
        } catch { self.error = error.localizedDescription }
    }
}
