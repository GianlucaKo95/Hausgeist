import Foundation

/// Beispieldaten für den Demo-Modus (-uiDemo), z. B. für Screenshots.
enum DemoData {
    static let chat: [ChatMessage] = [
        ChatMessage(sender: .me, text: "Welche Verträge kann ich bald kündigen?"),
        ChatMessage(sender: .ghost, text: """
        Zwei Verträge haben in den nächsten Wochen ihre Kündigungsfrist:

        • **Fitnessstudio** – kündigen bis **15.12.2026**, sonst Verlängerung um 12 Monate (39,90 €/Monat)
        • **Handyvertrag Annika** – kündigen bis **31.01.2027**

        Soll ich dir für das Fitnessstudio eine Kündigung entwerfen?
        """),
        ChatMessage(sender: .me, text: "Ja, bitte. Und setz Milch und Kaffee auf die Einkaufsliste."),
    ]

    static let reply = """
    Erledigt:
    • Milch und Kaffee stehen auf der Einkaufsliste.
    • Die Kündigung ans Fitnessstudio liegt als Mail-Entwurf zur **Freigabe** bereit – sie wird erst gesendet, wenn du zustimmst.
    """

    static let approvals = ApprovalList(
        payments: [
            PaymentApproval(id: "demo-1", issuer: "Stadtwerke Duisburg", amount_cents: 8420,
                            iban: "DE89 3704 0044 0532 0130 00", reference: "Abschlag Dezember",
                            payee_status: "known", due_date: "2026-12-01", recipient_name: "Familie Köhni",
                            note: nil, account: "Sparkasse Giro", can_decide: true),
            PaymentApproval(id: "demo-2", issuer: "Elektro Schmitz GmbH", amount_cents: 61850,
                            iban: "DE02 1203 0000 0000 2020 51", reference: "RE-2026-1184",
                            payee_status: "new", due_date: "2026-12-05", recipient_name: "KoeVen GbR",
                            note: "Neuer Empfänger – bitte IBAN prüfen", account: "DKB Giro", can_decide: true),
        ],
        actions: [
            ActionApproval(id: "demo-3", kind: "send_mail",
                           summary: "An: kuendigung@fitness-beispiel.de\nBetreff: Kündigung Mitgliedschaft Nr. 4711",
                           amount_cents: nil, can_decide: true),
        ]
    )

    static let overview = Overview(
        approvals: 2,
        events: [
            .init(title: "Elternabend Kita", start: "2026-11-26T19:30:00+01:00", end: "2026-11-26T21:00:00+01:00", all_day: false, location: "Kita Sonnenschein", calendar: "Familie"),
            .init(title: "Zahnarzt Nelio", start: "2026-11-27T08:15:00+01:00", end: "2026-11-27T09:00:00+01:00", all_day: false, location: nil, calendar: "Annika"),
            .init(title: "Altpapier", start: "2026-11-27", end: nil, all_day: true, location: nil, calendar: "Müllabfuhr"),
        ],
        energy: ["pv_power": .init(value: 2140, unit: "W"), "battery_soc": .init(value: 76, unit: "%"),
                 "house_power": .init(value: 640, unit: "W"), "grid_power": .init(value: -1310, unit: "W")],
        recent: [.init(id: "d1", title: "Verträge kündigen", category: "Dokumente", updated_at: "2026-11-24T08:00:00Z"),
                 .init(id: "d2", title: "Hotel Rom Ostern", category: "Recherche", updated_at: "2026-11-20T18:30:00Z")]
    )
}
