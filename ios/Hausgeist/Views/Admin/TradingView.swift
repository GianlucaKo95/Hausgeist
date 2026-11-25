import SwiftUI

/// Alpaca-Paper-Konto für die Intraday-Engine. Nur Paper-Schlüssel (PK…) – echtes Geld ist ausgeschlossen.
struct TradingView: View {
    @Environment(AuthService.self) private var auth
    @State private var keyId = ""
    @State private var secret = ""
    @State private var secretSet = false
    @State private var supported = true
    @State private var busy = false
    @State private var error: String?
    @State private var info: String?

    var body: some View {
        Form {
            ErrorBanner(text: error)
            if !supported {
                Text("Bitte das Add-on auf Version 0.21.0 aktualisieren.").foregroundStyle(.secondary)
            } else {
                Section {
                    TextField("API Key ID (beginnt mit PK)", text: $keyId)
                        .textInputAutocapitalization(.characters).autocorrectionDisabled()
                        .font(.body.monospaced())
                    SecureField(secretSet ? "Secret Key (gespeichert)" : "Secret Key", text: $secret)
                        .font(.body.monospaced())
                    Button("Sichern", systemImage: "checkmark") { Task { await save() } }
                        .disabled(busy || !keyId.hasPrefix("PK") || (!secretSet && secret.isEmpty))
                    if let info { Label(info, systemImage: "checkmark.circle").foregroundStyle(.green) }
                } header: {
                    Text("Alpaca Paper-Konto")
                } footer: {
                    Text("Kostenloses Paper-Konto auf alpaca.markets anlegen, im Dashboard auf „Paper“ wechseln und unter „API Keys“ einen Schlüssel erzeugen. Live-Schlüssel (AK…) werden abgelehnt – die Engine handelt nur mit Spielgeld.")
                }
                Section("So geht's weiter") {
                    Text("Im Chat zum Beispiel: „Bau mir eine Intraday-Regel für AAPL und NVDA auf 5-Minuten-Kerzen: Einstieg über VWAP mit steigendem Volumen, Stop 1 %, Ziel 2 %. Teste sie über 10 Tage.“")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Trading (Paper)")
        .task { await load() }
    }

    private var api: APIClient { APIClient(auth: auth) }

    private func load() async {
        do {
            let s = try await api.adminSettings()
            supported = s.alpaca != nil
            keyId = s.alpaca?.key_id ?? ""
            secretSet = s.alpaca?.secret_set ?? false
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        busy = true; defer { busy = false }
        do {
            try await api.saveSettings(SettingsPatch(alpaca: AlpacaSave(key_id: keyId.trimmingCharacters(in: .whitespaces), secret: secret.isEmpty ? nil : secret.trimmingCharacters(in: .whitespaces))))
            secret = ""; secretSet = true; info = "Gespeichert"; error = nil
        } catch { self.error = error.localizedDescription }
    }
}
