import Foundation
import Testing
@testable import ReceiptRefiner

@Suite("OCR-only receipt fallback")
struct OcrOnlyTests {
    @Test("keeps page order, markers, and recognition options")
    func orderedPages() async throws {
        let pages = [URL(fileURLWithPath: "/tmp/page-001.heic"),
                     URL(fileURLWithPath: "/tmp/page-002.heic")]
        var seen: [String] = []
        let text = try await ReceiptRefiner.ocrText(pages: pages) { page, options in
            #expect(options.automaticallyDetectLanguage)
            #expect(options.useLanguageCorrection)
            seen.append(page.lastPathComponent)
            return page.lastPathComponent == "page-001.heic" ? "FIRST" : "SECOND"
        }

        #expect(seen == ["page-001.heic", "page-002.heic"])
        #expect(text == "--- PAGE 1 ---\nFIRST\n--- PAGE 2 ---\nSECOND")
    }

    @Test("rejects a blank Vision result")
    func blankResult() async {
        await #expect(throws: RefinerError.visionFailed) {
            try await ReceiptRefiner.ocrText(pages: [URL(fileURLWithPath: "/tmp/page-001.heic")]) {
                _, _ in "  \n"
            }
        }
    }

    @Test("rejects an invalid queue package")
    func invalidPackage() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        #expect(throws: RefinerError.invalidPackage) {
            try ReceiptRefiner.queuePackagePages(root)
        }
    }
}
