# Hausgeist für iOS

SwiftUI-App mit Sprache (Diktat, Vorlesen, Gesprächsmodus, Siri: „Frag Hausgeist“) und drei Tabs: **Chat** mit dem Master-Agenten, **Freigaben** (Zahlungen und andere Aktionen mit Freigeben/Ablehnen) und **Einstellungen**. Es gibt keine Fremdabhängigkeiten: Der Login läuft direkt über die Supabase-Auth-REST-API, die Sitzung liegt im Schlüsselbund.

## Projekt erzeugen

Das Xcode-Projekt wird mit [XcodeGen](https://github.com/yonaskolb/XcodeGen) aus `project.yml` erzeugt:

```bash
brew install xcodegen
cd ios
xcodegen
open Hausgeist.xcodeproj
```

In Xcode unter *Signing & Capabilities* dein Team auswählen und auf dem iPhone starten.

## Einmalig einrichten

1. **Konten anlegen:** Im Supabase-Dashboard unter *Authentication → Users → Add user* für jede Person ein Konto mit E-Mail und Passwort anlegen und **Auto Confirm** aktivieren. Die E-Mail muss mit `public.users.email` übereinstimmen. Beim ersten Login verknüpft der Server beides automatisch.
2. **Öffentliche Registrierung abschalten:** *Authentication → Sign In / Providers → Allow new users to sign up* deaktivieren. Fremde Konten bekämen vom Server ohnehin `401`.
3. **VPN:** In Home Assistant das Tailscale-Add-on installieren, auf den iPhones die Tailscale-App.
4. **Port freigeben:** Im Hausgeist-Add-on unter *Netzwerk* Port `8099` eintragen.
5. **In der App:** *Einstellungen → Server* auf `http://<pi-name>.<tailnet>.ts.net:8099` setzen und *Speichern und testen* tippen.

HTTP ist nur für `*.ts.net` und lokale Adressen erlaubt. Die Verbindung läuft durch den WireGuard-Tunnel von Tailscale und ist damit verschlüsselt.

## TestFlight über GitHub Actions

Der Workflow **TestFlight** baut die App auf einem macOS-Runner, signiert sie über die Cloud-Signierung von Apple und lädt sie direkt zu TestFlight hoch. Gestartet wird er manuell (*Actions → TestFlight → Run workflow*) oder durch ein Tag wie `v0.3.0`. Die Build-Nummer ist die Laufnummer des Workflows.

**Einmalig in App Store Connect:**
1. Unter *Apps → +* eine neue App anlegen: Plattform iOS, Bundle-ID `de.hausgeist.koeven`. Ist die Bundle-ID noch nicht registriert, vorher unter *developer.apple.com → Identifiers* anlegen.
2. Unter *Benutzer und Zugriff → Integrationen → App Store Connect API* einen **Team-Schlüssel mit der Rolle Admin** erzeugen. Die Cloud-Signierung braucht Admin-Rechte. Die `.p8`-Datei lässt sich nur einmal herunterladen.

**GitHub-Secrets** (*Repo → Settings → Secrets and variables → Actions*):

| Secret | Inhalt |
| --- | --- |
| `APP_STORE_CONNECT_KEY_ID` | Schlüssel-ID, z. B. `ABC123DEF4` |
| `APP_STORE_CONNECT_ISSUER_ID` | Issuer-ID (UUID oben auf der API-Seite) |
| `APP_STORE_CONNECT_KEY_P8` | kompletter Inhalt der `.p8`-Datei inkl. `-----BEGIN PRIVATE KEY-----` |
| `APPLE_TEAM_ID` | Team-ID aus *developer.apple.com → Membership* |

Danach in TestFlight Annika als interne Testerin hinzufügen.

## CarPlay (Sprachgespräch)

Die App enthält eine CarPlay-Oberfläche in der Kategorie „sprachbasierte Konversations-App“ (ab iOS 26.4).
Apple muss dafür das Entitlement `com.apple.developer.carplay-voice-based-conversation` freigeben:

1. https://developer.apple.com/contact/carplay/ → Kategorie „Voice-based conversational app“, Bundle-ID `de.hausgeist.koeven`.
2. Nach der Freigabe: Actions → TestFlight → „Run workflow“ mit Haken bei **carplay**.

Ohne Freigabe baut die App wie bisher; der CarPlay-Teil ist dann einfach unsichtbar.
