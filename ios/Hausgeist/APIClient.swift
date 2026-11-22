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

    func reset() async throws {
        struct R: Decodable { let ok: Bool }
        let _: R = try await request("api/reset", method: "POST", body: [String: String]())
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

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: (any Encodable)? = nil, retry: Bool = true) async throws -> T {
        guard let base = AppConfig.serverURL else { throw APIError.noServer }
        var req = URLRequest(url: base.appending(path: path))
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
