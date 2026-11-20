# Hausgeist

Persönliches Agenten-Netzwerk als Home-Assistant-Add-on: ein **Master-Agent** nimmt Anfragen entgegen und verteilt sie an **acht Fachagenten**. Kritische Aktionen laufen nur nach Freigabe per Push.

## Was läuft

**Ereignisgesteuert (ohne Chat)**
- **Rechnungsablauf:** IMAP-Postfächer werden überwacht. Rechnungen werden mit Claude ausgelesen und von festem Code geprüft (IBAN-Prüfsumme, bekannter Empfänger, Doppelrechnung, Limit). Es folgt eine Push-Nachricht mit **Freigeben / Ablehnen**, dann zahlt der Ausführer, anschließend wird das PDF in Paperless abgelegt. Bis die FinTS-Registrierung da ist: **Testmodus**, es fließt kein Geld.
- **Tägliches Briefing** (Standard 07:30): Kündigungsfristen 30/14/7/1 Tag vorher, fällige Haushaltsaufgaben, offene Freigaben.

**Auf Anfrage (Chat in der HA-Seitenleiste oder über die API)**

| Agent | Kann | Stufe 2 (nur nach Freigabe) |
| --- | --- | --- |
| Finance | Rechnungen, Ausgaben nach Kategorie, Budgets, offene Freigaben | Zahlung nur über den Rechnungsablauf |
| Document | Paperless durchsuchen und lesen, Verträge erfassen, Kündigungsfristen automatisch eintragen | – |
| Shopping | Einkaufsliste, wiederkehrende Einkäufe, Preisvergleich per Websuche | Bestellung (Warenkorb mit Links) |
| Communication | Private/gemeinsame Postfächer lesen, sortieren, markieren, Antworten entwerfen | Mail senden |
| Household | HA-Geräte (Whitelist), Energie mit PV/Speicher, Verlauf, Haushaltsaufgaben und Wartungen | Schlösser, Alarm, Rollläden/Tore, Sirenen, Ventile |
| Personal & Family | Apple-Kalender lesen, Termine im eigenen/gemeinsamen Kalender, Familienaufgaben, Erinnerungen | Termin im Kalender einer anderen Person |
| Business | Geschäftspostfach (scope `business`), GitHub-Repos und Issues | Mail senden |
| Research | Websuche, Quellen prüfen, Entscheidungsvorlagen ablegen | – |

Freigaberegeln: Kinder geben nichts frei und sehen nur Family, Einkaufsliste und Recherche. Erwachsene geben bis zu ihrem Limit frei (Standard 500 €). Darüber und bei neuer oder geänderter Empfänger-IBAN entscheidet nur der Admin. Mails darf nur der Besitzer des Postfachs oder der Admin freigeben.

## Einrichtung

1. **Supabase:** Projekt anlegen, beide Dateien aus `supabase/migrations/` der Reihe nach im SQL-Editor ausführen, danach `supabase/seed.example.sql` angepasst ausführen.
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
api_token: <langes Zufallstoken für die eigene App>
daily_brief: "07:30"
log_level: info
```

4. **Chat öffnen:** In der Seitenleiste erscheint **Hausgeist**. Die Person wird über ihren HA-Benutzer erkannt, `users.ha_user_id` muss also gesetzt sein.

## API für die eigene App

Port 8099 in der Add-on-Netzwerkkonfiguration freigeben, dann:

```
POST /api/chat     {"message": "..."}   → {"reply": "..."}
POST /api/reset                            neues Gespräch
GET  /api/me
Header: Authorization: Bearer <api_token>
        X-Hausgeist-User: <users.id>
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
- Eigene App als Chat-Eingang
- Echte Bestellung bei Shops mit API; bis dahin enthält die Freigabe die Warenkorb-Links
