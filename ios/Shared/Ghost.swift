import SwiftUI

/// Farben aus dem App-Icon.
enum HGColor {
    /// Nachtblau des Icon-Hintergrunds
    static let night = Color(red: 0.086, green: 0.125, blue: 0.290)
    /// Blau des Hauses im Icon (entspricht der Akzentfarbe der App)
    static let house = Color(red: 0.216, green: 0.388, blue: 0.753)
}

/// Der Geist aus dem App-Icon – das Erkennungszeichen der App.
/// Breite = `width`, Höhe = 1,5 × Breite.
struct Ghost: View {
    var width: CGFloat
    var fill: Color = .white
    var eyes: Color = HGColor.night
    /// −1 … 1: Blick nach links/rechts
    var look: CGFloat = 0
    /// 1 = Augen offen, kleiner = blinzeln
    var open: CGFloat = 1

    var body: some View {
        let w = width
        let h = width * 1.5
        let r = w / 6
        ZStack(alignment: .topLeading) {
            UnevenRoundedRectangle(topLeadingRadius: w / 2, bottomLeadingRadius: 0,
                                   bottomTrailingRadius: 0, topTrailingRadius: w / 2, style: .circular)
                .fill(fill)
                .frame(width: w, height: h - r)
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(fill)
                    .frame(width: 2 * r, height: 2 * r)
                    .offset(x: CGFloat(i) * 2 * r, y: h - 2 * r)
            }
            ForEach([CGFloat(1) / 3, CGFloat(2) / 3], id: \.self) { fx in
                Ellipse()
                    .fill(eyes)
                    .frame(width: w * 0.137, height: max(w * 0.02, w * 0.19 * open))
                    .position(x: w * fx + look * w * 0.06, y: w * 0.49)
            }
        }
        .frame(width: w, height: h, alignment: .topLeading)
        .accessibilityHidden(true)
    }
}

/// Kleiner Geist, der blinzelt und sich umschaut – zeigt „Hausgeist arbeitet“.
struct GhostWorking: View {
    var width: CGFloat = 12
    var fill: Color = .secondary
    var eyes: Color = Color(.systemBackground)

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            let blink = t.truncatingRemainder(dividingBy: 2.8) < 0.14
            Ghost(width: width, fill: fill, eyes: eyes,
                  look: CGFloat(sin(t * 1.6)), open: blink ? 0.1 : 1)
        }
    }
}
