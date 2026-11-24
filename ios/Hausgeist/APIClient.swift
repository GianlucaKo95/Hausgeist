import Foundation

struct Me: Decodable {
    let id: String
    let name: String
    let role: String
}

struct PaymentApproval: Decodable, Identifiable {
    let id: String
    let issuer: String
    let amount_cents: Int
    let iban: String
    let reference: String?
    let payee_status: String
    let due_date: String?
    let recipient_name: String?
    let note: String?
    let account: String?
    let can_decide: Bool
}

struct ActionApproval: Decodable, Identifiable {
    let id: String
    let kind: String
    let summary: String
    let amount_cents: Int?
    let can_decide: Bool
}

struct ApprovalList: Decodable {
    let payments: [PaymentApproval]
    let actions: [ActionApproval]
}

struct DecisionResult: Decodable {
    let ok: Bool
    let message: String
}

private struct ServerError: Decodable { let error: String? }

enum APIError: LocalizedError {
    case noServer
    case http(Int, String)

    var errorDescription: String? {
        switch self {
        case .noServer: return "Bitte in den Einstellungen die Serveradresse eintragen."
        case .http(let code, let msg): return msg.isEmpty ? "Serverfehler (\(code))" : msg
        }
    }
}

/// Zugriff auf die Hausgeist-API auf dem Pi.
@MainActor
struct APIClient {
    let auth: AuthService

    private static let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 600   // Der Master-Agent braucht für große Aufgaben Zeit.
        cfg.timeoutIntervalForResource = 600
        return URLSession(configuration: cfg)
    }()

    func me() async throws -> Me {
        if AppConfig.isDemo { return Me(id: "demo", name: "Gianluca", role: "admin") }
        return try await request("api/me")
    }

    func chat(_ message: String, attachments: [ChatAttachment] = [], pushIfSlow: Bool = false) async throws -> String {
        if AppConfig.isDemo { return DemoData.reply }
        struct File: Encodable { let name: String; let mime: String; let data: String }
        struct Body: Encodable { let message: String; let attachments: [File]; let push_if_slow: Bool }
        struct R: Decodable { let reply: String }
        let body = Body(message: message, attachments: attachments.map {
            File(name: $0.name, mime: $0.mime, data: $0.data.base64EncodedString())
        }, push_if_slow: pushIfSlow)
        let r: R = try await request("api/chat", method: "POST", body: body)
        return r.reply
    }

    /// Startet eine Anfrage als Auftrag auf dem Pi. Kommt die Antwort innerhalb von 25 s, ist sie gleich dabei.
    func chatStart(_ message: String, attachments: [ChatAttachment] = []) async throws -> (reply: String?, jobId: String?) {
        if AppConfig.isDemo { return (DemoData.reply, nil) }
        struct File: Encodable { let name: String; let mime: String; let data: String }
        struct Body: Encodable { let message: String; let attachments: [File]; let async: Bool; let conversation_id: String? }
        struct R: Decodable { let reply: String?; let job_id: String?; let conversation_id: String? }
        let body = Body(message: message, attachments: attachments.map {
            File(name: $0.name, mime: $0.mime, data: $0.data.base64EncodedString())
        }, async: true, conversation_id: UserDefaults.standard.string(forKey: "conversationId"))
        let r: R = try await request("api/chat", method: "POST", body: body)
        if let c = r.conversation_id { UserDefaults.standard.set(c, forKey: "conversationId") }
        return (r.reply, r.job_id)
    }

    struct ChatJobStatus: Decodable { let status: String; let reply: String?; let error: String? }

    func chatJob(_ id: String, wait: Int) async throws -> ChatJobStatus {
        try await request("api/chat/jobs/\(id)?wait=\(wait)")
    }

    func openChatJobs() async throws -> [String] {
        struct J: Decodable { let id: String }
        struct R: Decodable { let jobs: [J] }
        let r: R = try await request("api/chat/jobs")
        return r.jobs.map(\.id)
    }

    // MARK: Gedächtnis

    struct MemoryItem: Decodable, Identifiable, Hashable { let id: String; let text: String; let updated_at: String }

    func memories() async throws -> [MemoryItem] {
        if AppConfig.isDemo { return [MemoryItem(id: "m1", text: "Fährt einen MG5 (Elektroauto)", updated_at: ""), MemoryItem(id: "m2", text: "Kauft Lebensmittel meist bei Rewe und Aldi", updated_at: "")] }
        struct R: Decodable { let memories: [MemoryItem] }
        let r: R = try await request("api/memories")
        return r.memories
    }

    func deleteMemory(_ id: String) async throws {
        struct R: Decodable { let ok: Bool }
        let _: R = try await request("api/memories/\(id)", method: "DELETE")
    }

    func deleteAllMemories() async throws {
        struct R: Decodable { let ok: Bool }
        let _: R = try await request("api/memories", method: "DELETE")
    }

    // MARK: Standort

    struct Place: Decodable { let name: String; let lat: Double; let lon: Double; let radius: Double }

    func places() async throws -> [Place] {
        struct R: Decodable { let places: [Place] }
        let r: R = try await request("api/places")
        return r.places
    }

    func sendLocation(lat: Double, lon: Double, accuracy: Double) async throws {
        struct B: Encodable { let lat: Double; let lon: Double; let accuracy: Double }
        struct R: Decodable { let ok: Bool }
        let _: R = try await request("api/location", method: "POST", body: B(lat: lat, lon: lon, accuracy: accuracy))
    }

    func sendZoneEvent(zone: String, event: String) async throws {
        struct R: Decodable { let ok: Bool }
        let _: R = try await request("api/location/zone", method: "POST", body: ["zone": zone, "event": event])
    }

    func clearLocation() async throws {
        struct R: Decodable { let ok: Bool }
        let _: R = try await request("api/location", method: "DELETE")
    }

    // MARK: Gesprächsverlauf

    struct ConversationInfo: Decodable, Identifiable, Hashable {
        let id: String
        let title: String
        let updated_at: String
        let messages: Int
        let current: Bool
        var date: Date? { ISO8601DateFormatter.flexible.date(from: updated_at) ?? ISO8601DateFormatter().date(from: updated_at) }
    }

    func conversations() async throws -> [ConversationInfo] {
        if AppConfig.isDemo {
            return [ConversationInfo(id: "d1", title: "Welche Verträge kann ich bald kündigen?", updated_at: "2026-11-24T08:00:00Z", messages: 4, current: true),
                    ConversationInfo(id: "d2", title: "Hotel in Rom für Ostern", updated_at: "2026-11-20T18:30:00Z", messages: 6, current: false)]
        }
        struct R: Decodable { let conversations: [ConversationInfo] }
        let r: R = try await request("api/conversations")
        return r.conversations
    }

    func conversationMessages(_ id: String) async throws -> [ChatMessage] {
        if AppConfig.isDemo { return DemoData.chat }
        struct M: Decodable { let sender: String; let text: String }
        struct R: Decodable { let messages: [M] }
        let r: R = try await request("api/conversations/\(id)")
        return r.messages.map { ChatMessage(sender: ChatMessage.Sender(rawValue: $0.sender) ?? .ghost, text: $0.text) }
    }

    func openConversation(_ id: String) async throws {
        if AppConfig.isDemo { return }
        struct R: Decodable { let ok: Bool }
        let _: R = try await request("api/conversations/\(id)/open", method: "POST", body: [String: String]())
        UserDefaults.standard.set(id, forKey: "conversationId")
    }

    func deleteConversation(_ id: String) async throws {
        if AppConfig.isDemo { return }
        struct R: Decodable { let ok: Bool }
        let _: R = try await request("api/conversations/\(id)", method: "DELETE")
    }

    func reset() async throws {
        struct R: Decodable { let ok: Bool }
        let _: R = try await request("api/reset", method: "POST", body: [String: String]())
        UserDefaults.standard.removeObject(forKey: "conversationId")
    }

    func registerDevice(token: String, environment: String) async throws {
        struct R: Decodable { let ok: Bool }
        let _: R = try await request("api/devices", method: "POST", body: ["token": token, "environment": environment])
    }

    func unregisterDevice(token: String) async throws {
        struct R: Decodable { let ok: Bool }
        let _: R = try await request("api/devices", method: "DELETE", body: ["token": token])
    }

    /// Freigeben/Ablehnen direkt aus der Mitteilung.
    func pushAction(_ action: String) async throws -> DecisionResult {
        try await request("api/push-action", method: "POST", body: ["action": action])
    }

    func approvals() async throws -> ApprovalList {
        if AppConfig.isDemo { return DemoData.approvals }
        return try await request("api/approvals")
    }

    func decide(payment id: String, approve: Bool) async throws -> DecisionResult {
        try await request("api/approvals/payment/\(id)", method: "POST", body: ["approve": approve])
    }

    func decide(action id: String, approve: Bool) async throws -> DecisionResult {
        try await request("api/approvals/action/\(id)", method: "POST", body: ["approve": approve])
    }

    func request<T: Decodable>(_ path: String, method: String = "GET", body: (any Encodable)? = nil, retry: Bool = true) async throws -> T {
        guard let base = AppConfig.serverURL else { throw APIError.noServer }
        // Pfad und Abfrage getrennt anhängen – appending(path:) würde ein „?“ maskieren.
        let parts = path.split(separator: "?", maxSplits: 1).map(String.init)
        var url = base.appending(path: parts[0])
        if parts.count == 2, var c = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            c.percentEncodedQuery = parts[1]
            url = c.url ?? url
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(try await auth.validAccessToken())", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await Self.session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 && retry {
            _ = try await auth.validAccessToken(forceRefresh: true)
            return try await request(path, method: method, body: body, retry: false)
        }
        // 409 = Entscheidung nicht möglich; die Antwort trägt trotzdem eine Meldung.
        if status == 200 || (status == 409 && T.self == DecisionResult.self) {
            return try JSONDecoder().decode(T.self, from: data)
        }
        let msg = (try? JSONDecoder().decode(ServerError.self, from: data))?.error ?? ""
        throw APIError.http(status, msg)
    }
}


extension ISO8601DateFormatter {
    /// Supabase liefert Zeitstempel mit Sekundenbruchteilen.
    static let flexible: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
