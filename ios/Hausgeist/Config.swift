import Foundation

/// Öffentliche Projektdaten. Der Publishable Key darf in der App stehen –
/// er erlaubt nur das Anmelden, keine Datenzugriffe (dafür gilt RLS).
enum AppConfig {
    static let supabaseURL = URL(string: "https://gyjeldwxsicauzxfsisc.supabase.co")!
    static let supabasePublishableKey = "sb_publishable_SWkeGI32jOnu9r8rFXRBcw_USIhXWkA"

    /// Adresse des Add-ons im VPN, z. B. http://homeassistant.tailXXXX.ts.net:8099
    static var serverURL: URL? {
        get { UserDefaults.standard.string(forKey: "serverURL").flatMap(URL.init(string:)) }
        set { UserDefaults.standard.set(newValue?.absoluteString, forKey: "serverURL") }
    }
}
