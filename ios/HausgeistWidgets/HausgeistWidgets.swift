import WidgetKit
import SwiftUI

/// „Mit Hausgeist sprechen“ – auf dem Homescreen, im Sperrbildschirm, in StandBy und im CarPlay-Dashboard.
/// Antippen öffnet den Sprachchat (in CarPlay das Sprach-Gespräch der CarPlay-App).
struct TalkEntry: TimelineEntry { let date: Date }

struct TalkProvider: TimelineProvider {
    func placeholder(in context: Context) -> TalkEntry { TalkEntry(date: .now) }
    func getSnapshot(in context: Context, completion: @escaping (TalkEntry) -> Void) { completion(TalkEntry(date: .now)) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<TalkEntry>) -> Void) {
        completion(Timeline(entries: [TalkEntry(date: .now)], policy: .never))
    }
}

struct TalkWidgetView: View {
    @Environment(\.widgetFamily) private var family
    var entry: TalkEntry

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                Ghost(width: 22, fill: .white, eyes: .black)
            }
            .widgetAccentable()
        case .accessoryRectangular:
            HStack(spacing: 8) {
                Ghost(width: 18, fill: .white, eyes: .black)
                    .widgetAccentable()
                VStack(alignment: .leading, spacing: 0) {
                    Text("Hausgeist").font(.headline)
                    Text("Tippen und sprechen").font(.caption)
                }
            }
        default:
            VStack(alignment: .leading, spacing: 0) {
                Ghost(width: 36)
                Spacer(minLength: 8)
                Text("Mit Hausgeist sprechen")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }
}

struct TalkWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "de.hausgeist.talk", provider: TalkProvider()) { entry in
            TalkWidgetView(entry: entry)
                .containerBackground(for: .widget) { HGColor.night }
                .widgetURL(URL(string: "hausgeist://voice"))
        }
        .configurationDisplayName("Mit Hausgeist sprechen")
        .description("Startet direkt den Sprachchat, auch in CarPlay")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular])
    }
}

@main
struct HausgeistWidgets: WidgetBundle {
    var body: some Widget { TalkWidget() }
}
