import Foundation

// MARK: - Modelle der Verwaltung

struct CalendarOwner: Codable, Hashable {
    var name: String
    var owner: String
}

struct CalendarFeed: Codable, Hashable, Identifiable {
    var id: String { url }
    var name: String
    var url: String
    var owner: String
}

struct BringListConfig: Codable, Hashable, Identifiable {
    var id: String { entity_id }
    var name: String
    var entity_id: String
    var stores: [String]
    var `default`: Bool
}

struct HaCalendar: Codable, Hashable, Identifiable {
    var id: String { entity_id }
    var name: String
    var entity_id: String
    var owner: String
}

struct EnergySensors: Codable, Hashable {
    var pv_power: String?
    var battery_soc: String?
    var battery_power: String?
    var grid_power: String?
    var house_power: String?
}

struct AdminSettings: Codable {
    var icloud_user: String
    var icloud_password_set: Bool
    var calendars: [CalendarOwner]
    var calendar_feeds: [CalendarFeed]
    var ha_calendars: [HaCalendar]
    var ha_entities: [String]
    var energy: EnergySensors
    var daily_brief: String
    var evening_check: String
    var mail_triage: Bool
    var weekly_offers: Bool
    var calendar_insights: Bool
    var paperless_url: String
    var paperless_token_set: Bool
    var push_enabled: Bool
    // ab Server 0.9.0
    var payment_mode: String?
    var fints_product_id: String?
    var banks: [BankLogin]?
    var bring_lists: [BringListConfig]?
}

struct BankLogin: Codable, Identifiable, Hashable {
    var id: String { bank }
    var bank: String
    var name: String
    var default_url: String
    var login: String
    var url: String
    var pin_set: Bool
}

struct BankLoginSave: Encodable {
    var login: String
    var pin: String?
    var url: String?
    var fints_product_id: String?
}

struct BankTestResult: Decodable {
    struct Account: Decodable, Hashable { let iban: String; let name: String? }
    let accounts: [Account]
    let tanMethods: [String]
}

/// Nur gesetzte Felder werden geschickt (JSONEncoder lässt nil weg).
struct SettingsPatch: Encodable {
    var icloud_user: String?
    var icloud_app_password: String?
    var calendars: [CalendarOwner]?
    var calendar_feeds: [CalendarFeed]?
    var ha_calendars: [HaCalendar]?
    var ha_entities: [String]?
    var energy: EnergySensors?
    var daily_brief: String?
    var evening_check: String?
    var mail_triage: Bool?
    var weekly_offers: Bool?
    var calendar_insights: Bool?
    var paperless_url: String?
    var paperless_token: String?
    var payment_mode: String?
    var fints_product_id: String?
    var bring_lists: [BringListConfig]?
}

struct Mailbox: Codable, Identifiable, Hashable {
    var id: String { name }
    var name: String
    var host: String
    var port: Int
    var tls: Bool
    var user: String
    var folder: String?
    var smtp_host: String?
    var smtp_port: Int?
    var from_name: String?
    var password_set: Bool
    var owner_id: String?
    var visibility: String
    var scope: String
}

struct MailboxSave: Encodable {
    var original_name: String?
    var name: String
    var host: String
    var port: Int
    var tls: Bool
    var user: String
    var password: String?
    var folder: String?
    var smtp_host: String?
    var smtp_port: Int?
    var from_name: String?
    var owner_id: String?
    var visibility: String
    var scope: String
}

struct MailboxTestResult: Decodable {
    let ok: Bool
    let folders: [String]
    let smtp: String
}

struct Person: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var role: String
    var email: String?
    var approval_limit_cents: Int
    var has_login: Bool
}

struct PersonSave: Encodable {
    var name: String
    var role: String
    var email: String?
    var approval_limit_euro: Double
}

struct BankAccount: Codable, Identifiable, Hashable {
    var id: String
    var label: String
    var bank: String
    var iban: String
    var holder_id: String?
    var match_names: [String]
    var is_default: Bool
}

struct BankAccountSave: Encodable {
    var label: String
    var bank: String
    var iban: String
    var holder_id: String?
    var match_names: [String]
    var is_default: Bool
}

struct Payee: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var ibans: [String]
    var default_account_id: String?
}

struct PayeeSave: Encodable {
    var name: String
    var iban: String
    var default_account_id: String?
}

struct HAEntity: Codable, Identifiable, Hashable {
    var id: String { entity_id }
    var entity_id: String
    var domain: String
    var state: String
    var name: String
    var unit: String?
}

private struct OK: Decodable { let ok: Bool }
private struct ICloudTest: Decodable { let ok: Bool; let calendars: [String] }

// MARK: - Aufrufe

extension APIClient {
    func adminSettings() async throws -> AdminSettings {
        if AppConfig.isDemo { return DemoAdmin.settings }
        return try await request("api/admin/settings")
    }

    func saveSettings(_ patch: SettingsPatch) async throws {
        if AppConfig.isDemo { return }
        let _: OK = try await request("api/admin/settings", method: "PUT", body: patch)
    }

    func testICloud(user: String, password: String) async throws -> [String] {
        if AppConfig.isDemo { return ["Familie", "Gianluca", "Annika", "Arbeit"] }
        let r: ICloudTest = try await request("api/admin/icloud/test", method: "POST",
                                              body: ["icloud_user": user, "icloud_app_password": password])
        return r.calendars
    }

    func saveBankLogin(bank: String, _ b: BankLoginSave) async throws {
        if AppConfig.isDemo { return }
        let _: OK = try await request("api/admin/banks/\(bank)", method: "PUT", body: b)
    }

    func deleteBankLogin(bank: String) async throws {
        if AppConfig.isDemo { return }
        let _: OK = try await request("api/admin/banks/\(bank)", method: "DELETE")
    }

    func testBank(bank: String, _ b: BankLoginSave) async throws -> BankTestResult {
        if AppConfig.isDemo {
            return BankTestResult(accounts: [.init(iban: "DE02120300000000202051", name: "Girokonto")], tanMethods: ["DKB-App", "chipTAN"])
        }
        return try await request("api/admin/banks/\(bank)/test", method: "POST", body: b)
    }

    func mailboxes() async throws -> [Mailbox] {
        if AppConfig.isDemo { return DemoAdmin.mailboxes }
        return try await request("api/admin/mailboxes")
    }

    func saveMailbox(_ m: MailboxSave) async throws {
        if AppConfig.isDemo { return }
        let _: OK = try await request("api/admin/mailboxes", method: "PUT", body: m)
    }

    func deleteMailbox(name: String) async throws {
        if AppConfig.isDemo { return }
        let _: OK = try await request("api/admin/mailboxes/\(name)", method: "DELETE")
    }

    func testMailbox(_ m: MailboxSave) async throws -> MailboxTestResult {
        if AppConfig.isDemo { return MailboxTestResult(ok: true, folders: ["INBOX", "Gesendet"], smtp: "ok") }
        return try await request("api/admin/mailboxes/test", method: "POST", body: m)
    }

    func people() async throws -> [Person] {
        if AppConfig.isDemo { return DemoAdmin.people }
        return try await request("api/admin/users")
    }

    func savePerson(id: String?, _ p: PersonSave) async throws {
        if AppConfig.isDemo { return }
        let _: OK = try await request(id.map { "api/admin/users/\($0)" } ?? "api/admin/users", method: id == nil ? "POST" : "PUT", body: p)
    }

    func deletePerson(id: String) async throws {
        if AppConfig.isDemo { return }
        let _: OK = try await request("api/admin/users/\(id)", method: "DELETE")
    }

    func accounts() async throws -> [BankAccount] {
        if AppConfig.isDemo { return DemoAdmin.accounts }
        return try await request("api/admin/accounts")
    }

    func saveAccount(id: String?, _ a: BankAccountSave) async throws {
        if AppConfig.isDemo { return }
        let _: OK = try await request(id.map { "api/admin/accounts/\($0)" } ?? "api/admin/accounts", method: id == nil ? "POST" : "PUT", body: a)
    }

    func deleteAccount(id: String) async throws {
        if AppConfig.isDemo { return }
        let _: OK = try await request("api/admin/accounts/\(id)", method: "DELETE")
    }

    func payees() async throws -> [Payee] {
        if AppConfig.isDemo { return [] }
        return try await request("api/admin/payees")
    }

    func savePayee(_ p: PayeeSave) async throws {
        if AppConfig.isDemo { return }
        let _: OK = try await request("api/admin/payees", method: "POST", body: p)
    }

    func deletePayee(id: String) async throws {
        if AppConfig.isDemo { return }
        let _: OK = try await request("api/admin/payees/\(id)", method: "DELETE")
    }

    func haEntities() async throws -> [HAEntity] {
        if AppConfig.isDemo { return DemoAdmin.entities }
        return try await request("api/admin/ha/entities")
    }
}

// MARK: - Beispieldaten für den Demo-Modus

enum DemoAdmin {
    static let people = [
        Person(id: "u1", name: "Gianluca", role: "admin", email: "gk@koeven.de", approval_limit_cents: 0, has_login: true),
        Person(id: "u2", name: "Annika", role: "adult", email: "annika@example.de", approval_limit_cents: 50000, has_login: true),
        Person(id: "u3", name: "Nelio", role: "child", email: nil, approval_limit_cents: 0, has_login: false),
    ]
    static let mailboxes = [
        Mailbox(name: "Privat", host: "imap.example.de", port: 993, tls: true, user: "gk@koeven.de", folder: nil,
                smtp_host: "smtp.example.de", smtp_port: 587, from_name: "Gianluca Köhni", password_set: true,
                owner_id: "u1", visibility: "private", scope: "private"),
        Mailbox(name: "Familie", host: "imap.gmail.com", port: 993, tls: true, user: "familie@example.de", folder: nil,
                smtp_host: "smtp.gmail.com", smtp_port: 587, from_name: nil, password_set: true,
                owner_id: nil, visibility: "shared", scope: "private"),
    ]
    static let accounts = [
        BankAccount(id: "a1", label: "Sparkasse Giro", bank: "sparkasse_duisburg", iban: "DE89370400440532013000",
                    holder_id: "u1", match_names: ["Köhni"], is_default: true),
        BankAccount(id: "a2", label: "DKB Giro", bank: "dkb", iban: "DE02120300000000202051",
                    holder_id: "u1", match_names: ["KoeVen"], is_default: false),
    ]
    static let entities = [
        HAEntity(entity_id: "climate.wohnzimmer", domain: "climate", state: "heat", name: "Heizung Wohnzimmer", unit: nil),
        HAEntity(entity_id: "light.kueche", domain: "light", state: "off", name: "Küche", unit: nil),
        HAEntity(entity_id: "lock.haustuer", domain: "lock", state: "locked", name: "Haustür", unit: nil),
        HAEntity(entity_id: "sensor.pv_leistung", domain: "sensor", state: "2140", name: "PV-Leistung", unit: "W"),
        HAEntity(entity_id: "sensor.speicher_soc", domain: "sensor", state: "76", name: "Speicher Ladestand", unit: "%"),
        HAEntity(entity_id: "todo.zuhause", domain: "todo", state: "4", name: "Zuhause (Bring!)", unit: nil),
        HAEntity(entity_id: "switch.waschmaschine", domain: "switch", state: "off", name: "Waschmaschine", unit: nil),
    ]
    static let settings = AdminSettings(
        icloud_user: "gk@koeven.de", icloud_password_set: true,
        calendars: [CalendarOwner(name: "Familie", owner: "shared"), CalendarOwner(name: "Gianluca", owner: "Gianluca")],
        calendar_feeds: [CalendarFeed(name: "Abfall", url: "https://example.de/abfall.ics", owner: "shared")],
        ha_calendars: [], ha_entities: ["climate.*", "light.kueche", "switch.waschmaschine", "sensor.pv_leistung"],
        energy: EnergySensors(pv_power: "sensor.pv_leistung", battery_soc: "sensor.speicher_soc"),
        daily_brief: "07:30", evening_check: "18:00", mail_triage: true, weekly_offers: true, calendar_insights: true,
        paperless_url: "", paperless_token_set: false, push_enabled: true,
        payment_mode: "dryrun", fints_product_id: "",
        banks: [
            BankLogin(bank: "sparkasse_duisburg", name: "Sparkasse Duisburg", default_url: "https://banking-rl4.s-fints-pt-rl.de/fints30", login: "gk1234", url: "", pin_set: true),
            BankLogin(bank: "deutsche_bank", name: "Deutsche Bank", default_url: "https://fints.deutsche-bank.de/", login: "", url: "", pin_set: false),
            BankLogin(bank: "dkb", name: "DKB", default_url: "https://fints.dkb.de/fints", login: "", url: "", pin_set: false),
        ],
        bring_lists: [BringListConfig(name: "Zuhause", entity_id: "todo.zuhause", stores: ["Rewe", "Aldi", "dm"], default: true)])
}
