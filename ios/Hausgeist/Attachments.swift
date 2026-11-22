import SwiftUI
import UIKit
import VisionKit

/// Datei, die mit einer Chat-Nachricht geschickt wird.
struct ChatAttachment: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let mime: String      // application/pdf oder image/jpeg
    let data: Data

    var icon: String { mime == "application/pdf" ? "doc.richtext" : "photo" }
}

enum AttachmentTools {
    /// Verkleinert ein Foto auf höchstens 2000 px Kantenlänge und speichert es als JPEG.
    static func jpeg(from image: UIImage, maxSide: CGFloat = 2000, quality: CGFloat = 0.75) -> Data? {
        let size = image.size
        let scale = min(1, maxSide / max(size.width, size.height))
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        return resized.jpegData(compressionQuality: quality)
    }

    /// Fügt gescannte Seiten zu einem PDF zusammen (A4-Breite, Seitenverhältnis bleibt).
    static func pdf(from pages: [UIImage]) -> Data {
        let pageWidth: CGFloat = 595 // A4 in Punkten
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: pageWidth, height: 842))
        return renderer.pdfData { ctx in
            for page in pages {
                let ratio = page.size.height / max(page.size.width, 1)
                let rect = CGRect(x: 0, y: 0, width: pageWidth, height: pageWidth * ratio)
                ctx.beginPage(withBounds: rect, pageInfo: [:])
                // Für kleine Dateien vor dem Zeichnen auf JPEG reduzieren.
                let img = jpeg(from: page, maxSide: 1800, quality: 0.6).flatMap(UIImage.init(data:)) ?? page
                img.draw(in: rect)
            }
        }
    }

    static func timestampName(_ prefix: String, ext: String) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd_HH-mm"
        return "\(prefix)_\(f.string(from: Date())).\(ext)"
    }
}

/// Dokumentenscanner von iOS (Kanten erkennen, entzerren, mehrere Seiten).
struct DocumentScanner: UIViewControllerRepresentable {
    var onFinish: ([UIImage]) -> Void
    var onCancel: () -> Void

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let vc = VNDocumentCameraViewController()
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ uiViewController: VNDocumentCameraViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let parent: DocumentScanner
        init(_ parent: DocumentScanner) { self.parent = parent }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            parent.onFinish((0..<scan.pageCount).map { scan.imageOfPage(at: $0) })
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            parent.onCancel()
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
            parent.onCancel()
        }
    }
}
