import Foundation
import Observation

struct AuthSession: Codable {
    var accessToken: String
    var refreshToken: String
    var expiresAt: Date
    var email: String
}

enum AuthError: LocalizedError {
    case invalidCredentials
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidCredentials: return "E-Mail oder Passwort ist falsch."
        case .server(let msg): return msg
        }
    }
}

/// Anmeldung über Supabase Auth (E-Mail + Passwort) direkt per REST,
/// ohne zusätzliche Bibliothek. Die Sitzung liegt im Schlüsselbund.
@Observable
@MainActor
final class AuthService {
    private(set) var session: AuthSession?
    private let keychainKey = "session"

    var isSignedIn: Bool { session != nil }

    init() {
        if let data = Keychain.load(keychainKey),
           let s = try? JSONDecoder().decode(AuthSession.self, from: data) {
            session = s
        }
    }

    func signIn(email: String, password: String) async throws {
        let body = ["email": email.trimmingCharacters(in: .whitespaces).lowercased(), "password": password]
        let s = try await tokenRequest(grantType: "password", body: body, email: body["email"]!)
        store(s)
    }

    func signOut() async {
        if let token = session?.accessToken {
            var req = URLRequest(url: AppConfig.supabaseURL.appending(path: "auth/v1/logout"))
            req.httpMethod = "POST"
            req.setValue(AppConfig.supabasePublishableKey, forHTTPHeaderField: "apikey")
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            _ = try? await URLSession.shared.data(for: req)
        }
        session = nil
        Keychain.delete(keychainKey)
    }

    /// Gültiges Access-Token, bei Bedarf erneuert.
    func validAccessToken(forceRefresh: Bool = false) async throws -> String {
        guard let s = session else { throw AuthError.server("Nicht angemeldet") }
        if !forceRefresh && s.expiresAt.timeIntervalSinceNow > 60 { return s.accessToken }
        do {
            let fresh = try await tokenRequest(grantType: "refresh_token", body: ["refresh_token": s.refreshToken], email: s.email)
            store(fresh)
            return fresh.accessToken
        } catch AuthError.invalidCredentials {
            await signOut()
            throw AuthError.server("Sitzung abgelaufen – bitte neu anmelden.")
        }
    }

    private func store(_ s: AuthSession) {
        session = s
        if let data = try? JSONEncoder().encode(s) { Keychain.save(data, for: keychainKey) }
    }

    private func tokenRequest(grantType: String, body: [String: String], email: String) async throws -> AuthSession {
        var comps = URLComponents(url: AppConfig.supabaseURL.appending(path: "auth/v1/token"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "grant_type", value: grantType)]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(AppConfig.supabasePublishableKey, forHTTPHeaderField: "apikey")
        req.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 400 || status == 401 { throw AuthError.invalidCredentials }
        guard status == 200 else {
            throw AuthError.server("Anmeldung fehlgeschlagen (\(status))")
        }
        struct TokenResponse: Decodable {
            let access_token: String
            let refresh_token: String
            let expires_in: Double
        }
        let t = try JSONDecoder().decode(TokenResponse.self, from: data)
        return AuthSession(accessToken: t.access_token, refreshToken: t.refresh_token,
                           expiresAt: Date().addingTimeInterval(t.expires_in), email: email)
    }
}
