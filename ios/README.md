# Hausgeist für iOS

SwiftUI-App mit drei Tabs: **Chat** mit dem Master-Agenten, **Freigaben** (Zahlungen und andere Aktionen mit Freigeben/Ablehnen) und **Einstellungen**. Es gibt keine Fremdabhängigkeiten: Der Login läuft direkt über die Supabase-Auth-REST-API, die Sitzung liegt im Schlüsselbund.

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
