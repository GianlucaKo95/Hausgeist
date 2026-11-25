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
                Image(systemName: "waveform").font(.title2.weight(.semibold))
            }
            .widgetAccentable()
        case .accessoryRectangular:
            HStack(spacing: 6) {
                Image(systemName: "waveform.circle.fill").font(.title2)
                VStack(alignment: .leading) {
                    Text("Hausgeist").font(.headline)
                    Text("Tippen und sprechen").font(.caption)
                }
            }
        default:
            VStack(spacing: 10) {
                ZStack {
                    Circle()
                        .fill(LinearGradient(colors: [.cyan, .blue], startPoint: .topLeading, endPoint: .bottomTrailing))
                        .frame(width: 64, height: 64)
                    Image(systemName: "waveform").font(.system(size: 28, weight: .semibold)).foregroundStyle(.white)
                }
                Text("Mit Hausgeist sprechen")
                    .font(.subheadline.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .minimumScaleFactor(0.8)
            }
        }
    }
}

struct TalkWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "de.hausgeist.talk", provider: TalkProvider()) { entry in
            TalkWidgetView(entry: entry)
                .containerBackground(for: .widget) {
                    LinearGradient(colors: [Color(red: 0.07, green: 0.09, blue: 0.16), .black], startPoint: .top, endPoint: .bottom)
                }
                .widgetURL(URL(string: "hausgeist://voice"))
        }
        .configurationDisplayName("Mit Hausgeist sprechen")
        .description("Startet direkt den Sprachchat – auch in CarPlay.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular])
    }
}

@main
struct HausgeistWidgets: WidgetBundle {
    var body: some Widget { TalkWidget() }
}
