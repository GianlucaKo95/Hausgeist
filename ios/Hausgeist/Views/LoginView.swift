import SwiftUI

struct LoginView: View {
    @Environment(AuthService.self) private var auth
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Image(systemName: "house.lodge")
                            .font(.system(size: 40))
                            .foregroundStyle(.tint)
                        Text("Hausgeist").font(.largeTitle.bold())
                        Text("Melde dich mit deinem Haushaltskonto an.")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                }
                Section {
                    TextField("E-Mail", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Passwort", text: $password)
                        .textContentType(.password)
                        .onSubmit { Task { await signIn() } }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
                Section {
                    Button {
                        Task { await signIn() }
                    } label: {
                        if busy { ProgressView() } else { Text("Anmelden").bold() }
                    }
                    .disabled(busy || email.isEmpty || password.isEmpty)
                }
            }
        }
    }

    private func signIn() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await auth.signIn(email: email, password: password)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
