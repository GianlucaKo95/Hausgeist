# Hausgeist

Persönliches Agenten-Netzwerk als Home-Assistant-Add-on. Phase 1 deckt den Rechnungsablauf ab:

1. **Communication-Agent** überwacht IMAP-Postfächer und meldet Mails mit PDF-Anhang.
2. **Finance-Agent** liest die Rechnung mit Claude aus, prüft IBAN (Prüfsumme, bekannter Empfänger), Doppelrechnungen und Betragslimit, schlägt ein Zahlerkonto vor und schickt eine Push-Nachricht mit **Freigeben / Ablehnen** an alle, die freigeben dürfen.
3. **Executor** (fester Code, kein Sprachmodell) zahlt ausschließlich mit den eingefrorenen Werten der Freigabe. Bis die FinTS-Produktregistrierung da ist, läuft er im **Testmodus** (`payment_mode: dryrun`) und überweist nichts.
4. **Document-Agent** legt das PDF anschließend in Paperless-ngx ab.

Freigaberegeln: Kinder geben nichts frei. Erwachsene bis zu ihrem Limit (Standard 500 €). Darüber sowie bei neuer oder geänderter Empfänger-IBAN nur der Admin.

## Einrichtung

1. **Supabase:** Projekt anlegen, `supabase/migrations/20261120000000_init.sql` im SQL-Editor ausführen, danach `supabase/seed.example.sql` angepasst ausführen.
2. **Add-on installieren:** In Home Assistant unter *Einstellungen → Add-ons → Add-on Store → ⋮ → Repositories* `https://github.com/GianlucaKo95/hausgeist` hinzufügen, dann *Hausgeist* installieren.
3. **Konfigurieren** (Reiter *Konfiguration*):

```yaml
anthropic_api_key: sk-ant-…
model: claude-sonnet-5-5
supabase_url: https://<ref>.supabase.co
supabase_service_key: <service_role key>
paperless_url: http://<paperless-host>:8000
paperless_token: <API-Token aus Paperless → Profil>
payment_mode: dryrun
mailboxes:
  - name: privat
    host: imap.example.de
    port: 993
    tls: true
    user: gk@koeven.de
    password: <App-Passwort>
log_level: info
```

`name` jedes Postfachs muss zu einem Eintrag in `public.mailboxes` passen.

Beim ersten Start merkt sich das Add-on den aktuellen Stand jedes Postfachs und verarbeitet nur **neu eingehende** Mails.

## Entwicklung

```bash
cd hausgeist/app
npm install
npm test      # Build + Tests der Prüflogik
```

## Sicherheit

- Mail- und PDF-Inhalte sind fremder Text. Das Modell liest nur aus; Prüfung, Freigabe und Zahlung sind normaler Code.
- Datenbank-Trigger verhindern, dass Betrag, IBAN oder Verwendungszweck nach dem Anlegen geändert werden.
- Jede Aktion landet in `audit_log`.

## Nächste Schritte

- FinTS-Anbindung (Sparkasse Duisburg, Deutsche Bank, DKB), sobald die Produktregistrierungsnummer da ist
- Master-Agent mit eigener App als Chat-Eingang
- Personal & Family (Apple-Kalender), Household, Shopping, Research, Business
