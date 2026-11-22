# Hausgeist

Persönliches Agenten-Netzwerk als Home-Assistant-Add-on: ein **Master-Agent** nimmt Anfragen entgegen und verteilt sie an **acht Fachagenten**. Kritische Aktionen laufen nur nach Freigabe per Push.

## Was läuft

**Ereignisgesteuert und zeitgesteuert (ohne Chat)**
- **Posteingang:** PDFs aus Mails und Fotos/Scans/PDFs aus der App werden eingeordnet. Bei einer **Rechnung** wird die Zahlung geprüft und zur Freigabe vorgelegt. Ein **Vertrag** wird erfasst, die Kündigungsfrist eingetragen und gemeldet. Ein **Termin** wird zur Übernahme in den Kalender vorgeschlagen. Alles andere geht nach Paperless. Kalendereinladungen (.ics) werden ebenfalls vorgeschlagen.
- **Zahlungen:** Ausgeführt wird erst nach Freigabe. Bis die FinTS-Registrierung da ist, läuft alles im **Testmodus**, es fließt kein Geld.
- **Kalender vorausdenken:** Morgens und abends (Standard 18:00) liest der Family-Agent die nächsten 8 Tage aus allen Kalendern und leitet Vorbereitungen ab. Ein paar Beispiele: Morgen ist Papiermüll, also kommt um 19 Uhr die Erinnerung, die blaue Tonne rauszustellen. Bei einem Geburtstag kommt 5 Tage vorher der Hinweis aufs Geschenk. Vor einem Arzttermin erinnert er am Vorabend an die Versichertenkarte. Präferenzen wie „Nelio bringt den Papiermüll raus“ oder „Müll-Erinnerung um 20 Uhr“ werden beachtet. Jede Erinnerung kommt nur einmal.
- **Routinen:** Erinnerungen zu Zeitpunkten (auch wiederkehrend) und geplante Geräteschaltungen. Gerätealarme mit Wenn-dann-Regeln werden jede Minute geprüft. Morgens gibt es das Tagesbriefing (Fristen, Aufgaben, offene Freigaben) und einen Mail-Überblick, wiederkehrende Einkäufe kommen automatisch auf die Liste. Preisalarme werden täglich geprüft, montags kommen Prospekt-Angebote. Offene Freigaben werden nach 24 Stunden erneut gemeldet und verfallen nach 7 Tagen.

**Auf Anfrage (Chat in der HA-Seitenleiste oder über die API)**

| Agent | Kann | Stufe 2 (nur nach Freigabe) |
| --- | --- | --- |
| Finance | Rechnungen, Ausgaben nach Kategorie, Budgets, offene Freigaben, Konten/Empfänger (Admin) | Überweisung (aus Rechnung, Foto oder „Überweise 50 € an …“) |
| Document | Paperless durchsuchen und lesen, Verträge erfassen (auch aus Beschreibung), Fristen, Uploads einordnen und ablegen | – |
| Shopping | Listen pro Laden und Abteilung, wiederkehrende Artikel, Preisvergleich, Preisalarme, Wunschlisten (mit Reservierung), Prospekt-Angebote | Bestellung (Warenkorb mit Links) |
| Communication | Private/gemeinsame Postfächer lesen, sortieren, markieren, Antworten entwerfen | Mail senden |
| Household | HA-Geräte und Räume (Whitelist), zeitgesteuertes Schalten, Gerätealarme und Wenn-dann-Regeln, Energie mit PV/Speicher, Haushaltsaufgaben und Wartungen | Schlösser, Alarm, Rollläden/Tore, Sirenen, Ventile |
| Personal & Family | Apple-Kalender, Termine im eigenen/gemeinsamen Kalender, Familienaufgaben, Erinnerungen zu Zeitpunkten | Termin im Kalender einer anderen Person |
| Business | Geschäftspostfach (scope `business`), GitHub-Repos und Issues | Mail senden |
| Research | Websuche, Quellen prüfen, Fotos erkennen (Ort, Hotel, Produkt), Bildersuche (optional), Hotels/Reisen finden und vergleichen, Entscheidungsvorlagen | Buchung (vorausgefüllte Links; gebucht wird dort) |

Der Master-Agent selbst verwaltet außerdem **Notizen** (Haushaltswissen wie „Wo ist der Haupthahn?“) und Präferenzen.

Freigaberegeln: Kinder geben nichts frei und sehen nur Family, Einkaufsliste und Recherche. Erwachsene geben bis zu ihrem Limit frei (Standard 500 €). Darüber und bei neuer oder geänderter Empfänger-IBAN entscheidet nur der Admin. Mails darf nur der Besitzer des Postfachs oder der Admin freigeben.

## Einrichtung

1. **Supabase:** Projekt anlegen, alle Dateien aus `supabase/migrations/` der Reihe nach im SQL-Editor ausführen, danach `supabase/seed.example.sql` angepasst ausführen.
2. **Add-on installieren:** *Einstellungen → Add-ons → Add-on Store → ⋮ → Repositories* → `https://github.com/GianlucaKo95/hausgeist`, dann *Hausgeist* installieren. Der erste Build auf dem Pi dauert einige Minuten.
3. **Konfigurieren:**

```yaml
anthropic_api_key: sk-ant-…
model: claude-sonnet-5-5
supabase_url: https://<ref>.supabase.co
supabase_service_key: <service_role key>
paperless_url: http://<paperless-host>:8000
paperless_token: <API-Token>
payment_mode: dryrun
mailboxes:
  - name: privat              # muss in public.mailboxes stehen (owner, visibility, scope)
    host: imap.example.de
    port: 993
    tls: true
    user: gk@koeven.de
    password: <App-Passwort>
    smtp_host: smtp.example.de  # nötig zum Senden
    smtp_port: 587
    from_name: Gianluca Köhni
icloud_user: <Apple-ID>
icloud_app_password: <app-spezifisches Passwort von appleid.apple.com>
calendar_feeds:               # abonnierte Kalender (ICS), z. B. Abfuhrkalender der Wirtschaftsbetriebe Duisburg
  - name: Abfall
    url: https://…/abfuhrkalender.ics
    owner: shared
ha_calendars:                 # Kalender aus Home Assistant, z. B. Waste Collection Schedule
  - name: Müll
    entity_id: calendar.abfall
    owner: shared
calendar_insights: true       # aus Terminen Vorbereitungen ableiten
evening_check: "18:00"
calendars:                    # Besitzer je Kalender: Name aus public.users oder "shared"
  - name: Familie
    owner: shared
  - name: Luca
    owner: Luca
ha_entities:                  # nur diese Geräte sieht der Household-Agent
  - climate.*
  - sensor.pv_*
  - switch.waschmaschine
  - lock.haustuer
energy:
  pv_power: sensor.pv_leistung
  battery_soc: sensor.speicher_ladestand
  grid_power: sensor.netz_leistung
  house_power: sensor.hausverbrauch
github_token: <fine-grained Token, Issues lesen/schreiben>
serpapi_key: ""               # optional: Bildersuche (Google Lens) über serpapi.com
daily_brief: "07:30"
mail_triage: true             # Mail-Überblick morgens
weekly_offers: true           # Prospekt-Angebote montags
log_level: info
```

4. **Chat öffnen:** In der Seitenleiste erscheint **Hausgeist**. Die Person wird über ihren HA-Benutzer erkannt, `users.ha_user_id` muss also gesetzt sein.

## iOS-App

Die eigene App liegt in `ios/` (SwiftUI). Sie bietet Chat, Freigaben und Einstellungen, der Login läuft über Supabase Auth, erreichbar ist der Pi über Tailscale. Die Einrichtung steht in [`ios/README.md`](ios/README.md).

API (Port 8099, über VPN):

```
GET  /api/me
POST /api/chat                          {"message": "..."} → {"reply": "..."}
POST /api/reset                         neues Gespräch
GET  /api/approvals                     offene Zahlungen und Aktionen
POST /api/approvals/payment/<id>        {"approve": true|false}
POST /api/approvals/action/<id>         {"approve": true|false}
Header: Authorization: Bearer <Supabase-Access-Token>
```

## Entwicklung

```bash
cd hausgeist/app
npm install
npm test      # Build + Tests
```

## Sicherheit

- Mail-, Dokument- und Webinhalte sind fremder Text. Agenten lesen und schlagen vor. Stufe-2-Aktionen werden nur beantragt und von festem Code mit dem eingefrorenen Inhalt ausgeführt.
- Datenbank-Trigger verhindern Änderungen an Freigaben, Rechnungs-Zahlungsdaten und Aktionen nach dem Anlegen.
- Jeder Fachagent sieht nur seine eigenen Werkzeuge. Jede Aktion landet in `audit_log`.
- Der Master-Agent läuft über das Claude Agent SDK. Es bringt eine eigene Laufzeit mit (etwa 350 MB im Image).

## Offen

- FinTS-Anbindung (Sparkasse Duisburg, Deutsche Bank, DKB), sobald die Produktregistrierungsnummer da ist
- Echte Bestellung bei Shops mit API; bis dahin enthält die Freigabe die Warenkorb-Links
