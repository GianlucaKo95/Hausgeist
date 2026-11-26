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
        if AppConfig.isDemo {
            session = AuthSession(accessToken: "demo", refreshToken: "demo", expiresAt: .distantFuture, email: "demo@koeven.de")
            return
        }
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

    /// Abmelden. Nur dieses Gerät – andere Geräte bleiben angemeldet.
    func signOut(remote: Bool = true) async {
        if remote, let token = session?.accessToken,
           var comps = URLComponents(url: AppConfig.supabaseURL.appending(path: "auth/v1/logout"), resolvingAgainstBaseURL: false) {
            comps.queryItems = [URLQueryItem(name: "scope", value: "local")]
            var req = URLRequest(url: comps.url ?? AppConfig.supabaseURL.appending(path: "auth/v1/logout"))
            req.httpMethod = "POST"
            req.setValue(AppConfig.supabasePublishableKey, forHTTPHeaderField: "apikey")
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            _ = try? await URLSession.shared.data(for: req)
        }
        session = nil
        Keychain.delete(keychainKey)
    }

    /// Laufende Erneuerung – alle gleichzeitigen Anfragen warten auf dieselbe,
    /// damit derselbe Refresh-Token nie doppelt benutzt wird.
    private var refreshTask: Task<AuthSession, Error>?

    /// Hat ein anderer Teil (Widget, Siri, Mitteilungs-Knöpfe) die Sitzung schon erneuert? Dann die neuere nehmen.
    private func adoptNewerStored() {
        guard !AppConfig.isDemo, let data = Keychain.load(keychainKey),
              let stored = try? JSONDecoder().decode(AuthSession.self, from: data),
              stored.expiresAt > (session?.expiresAt ?? .distantPast) else { return }
        session = stored
    }

    /// Gültiges Access-Token, bei Bedarf erneuert.
    func validAccessToken(forceRefresh: Bool = false) async throws -> String {
        adoptNewerStored()
        guard let s = session else { throw AuthError.server("Nicht angemeldet") }
        if !forceRefresh && s.expiresAt.timeIntervalSinceNow > 60 { return s.accessToken }
        if let running = refreshTask { return try await running.value.accessToken }

        let rt = s.refreshToken, email = s.email
        let task = Task { try await self.refreshWithRetry(rt, email: email) }
        refreshTask = task
        defer { refreshTask = nil }
        do {
            let fresh = try await task.value
            store(fresh)
            return fresh.accessToken
        } catch AuthError.invalidCredentials {
            // Vielleicht hat ein anderer Teil der App inzwischen erneuert – dann ist nichts verloren.
            adoptNewerStored()
            if let cur = session, cur.refreshToken != rt {
                return cur.accessToken
            }
            await signOut(remote: false)
            throw AuthError.server("Sitzung abgelaufen – bitte neu anmelden")
        }
    }

    /// Netzwerkfehler (Funkloch, WLAN-Wechsel) beenden nie die Sitzung – kurz warten und noch einmal.
    private func refreshWithRetry(_ refreshToken: String, email: String) async throws -> AuthSession {
        var delay: UInt64 = 1_000_000_000
        for attempt in 0..<3 {
            do {
                return try await tokenRequest(grantType: "refresh_token", body: ["refresh_token": refreshToken], email: email)
            } catch AuthError.invalidCredentials {
                throw AuthError.invalidCredentials
            } catch {
                if attempt == 2 { throw error }
                try? await Task.sleep(nanoseconds: delay)
                delay *= 2
            }
        }
        throw AuthError.server("Anmeldung gerade nicht erreichbar")
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
