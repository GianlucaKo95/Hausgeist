import Foundation

/// Öffentliche Projektdaten. Der Publishable Key darf in der App stehen –
/// er erlaubt nur das Anmelden, keine Datenzugriffe (dafür gilt RLS).
enum AppConfig {
    /// Startargument -uiDemo: App mit Beispieldaten ohne Login und Server (für Screenshots).
    static let isDemo = ProcessInfo.processInfo.arguments.contains("-uiDemo")

    /// Wert eines Startarguments, z. B. -admin mailboxes
    static func launchArg(_ name: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    /// Startargument -tab <chat|approvals|settings>
    static var initialTab: String {
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-tab"), i + 1 < args.count { return args[i + 1] }
        return "home"
    }

    static let supabaseURL = URL(string: "https://gyjeldwxsicauzxfsisc.supabase.co")!
    static let supabasePublishableKey = "sb_publishable_SWkeGI32jOnu9r8rFXRBcw_USIhXWkA"

    /// Adresse des Add-ons im VPN, z. B. http://homeassistant.tailXXXX.ts.net:8099
    static var serverURL: URL? {
        get { UserDefaults.standard.string(forKey: "serverURL").flatMap(URL.init(string:)) }
        set { UserDefaults.standard.set(newValue?.absoluteString, forKey: "serverURL") }
    }
}
