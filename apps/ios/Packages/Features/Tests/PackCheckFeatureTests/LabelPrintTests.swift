import APIClient
import Core
import Foundation
import PDFKit
import Testing
import UIKit
@testable import PackCheckFeature

/// The QR codes a PDF page shows, top to bottom.
func qrCodes(on page: PDFPage) throws -> [String] {
    let image = page.thumbnail(of: CGSize(width: 1152, height: 1728), for: .mediaBox)
    let detector = try #require(CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: nil))
    let features = try detector.features(in: #require(CIImage(image: image))).compactMap { $0 as? CIQRCodeFeature }
    // Core Image's y grows upward: the top sticker has the largest y.
    return features.sorted { $0.bounds.minY > $1.bounds.minY }.compactMap(\.messageString)
}

/// A label source that hands out a test label, or fails, and counts its downloads.
actor FakeLabelFiles: LabelFileSource {
    var failure: LabelFileError?
    var downloads: [URL] = []

    init(failure: LabelFileError? = nil) {
        self.failure = failure
    }

    func labelFile(at url: URL, marketplace _: String) async throws(LabelFileError) -> Data {
        downloads.append(url)
        if let failure {
            throw failure
        }
        return LabelPrintJob.testLabel(named: "412")
    }
}

/// A printer that remembers its jobs; `completes` false is the seller canceling the print sheet.
@MainActor
final class FakePrinter: LabelPrinter, @unchecked Sendable {
    var jobs: [Data] = []
    var completes = true

    func print(_ pdf: Data, jobName _: String) async -> Bool {
        jobs.append(pdf)
        return completes
    }
}

@MainActor
struct LabelPrintModelTests {
    @Test func `the label and the order's stickers print in one job, then the print is recorded`() async throws {
        let service = FakePackService()
        let files = FakeLabelFiles()
        let printer = FakePrinter()
        var changed: [PackOrder] = []
        let model = try LabelPrintModel(
            order: labeledOrder("sale-a"), service: service, files: files, printer: printer,
            onChange: { changed.append($0) },
        )
        await model.print()
        #expect(model.stage == .printed)
        #expect(await files.downloads.map(\.absoluteString) == [
            "https://webapi.depop.com/presentation/api/v1/receipts/412/label/",
        ])
        let job = try #require(printer.jobs.first.flatMap(PDFDocument.init(data:)))
        // The label's page, then the two stickers on one label-size page.
        #expect(job.pageCount == 2)
        // The sticker page holds both items' QR codes.
        #expect(try qrCodes(on: #require(job.page(at: 1))) == ["LISTORA:AJ-000184", "LISTORA:AJ-000185"])
        #expect(await Array(service.labelPrints.values) == ["9400111899223197428490"])
        #expect(changed.first?.label?.printed?.label == "Label printed just now")
        #expect(model.printedBefore == "Label printed just now")
    }

    @Test func `a label printed before asks first, and prints only once the seller says so`() async throws {
        let service = FakePackService()
        let printer = FakePrinter()
        let model = try LabelPrintModel(
            order: labeledOrder("sale-a", printed: "Label printed 12 minutes ago"),
            service: service, files: FakeLabelFiles(), printer: printer,
        )
        await model.print()
        #expect(model.stage == .confirmingReprint)
        #expect(printer.jobs.isEmpty)
        model.cancelReprint()
        #expect(model.stage == .ready)
        await model.print(confirmed: true)
        #expect(model.stage == .printed)
        #expect(printer.jobs.count == 1)
    }

    @Test func `a label it couldn't download prints nothing and says why`() async throws {
        let service = FakePackService()
        let printer = FakePrinter()
        let model = try LabelPrintModel(
            order: labeledOrder("sale-a"), service: service, files: FakeLabelFiles(failure: .notLinked),
            printer: printer,
        )
        await model.print()
        guard case let .failed(message) = model.stage else { Issue.record("not failed: \(model.stage)"); return }
        #expect(message.contains("only on the iPhone you linked Depop on"))
        #expect(printer.jobs.isEmpty)
        #expect(await service.labelPrints.isEmpty)
        #expect(model.labelPage?.absoluteString == "https://www.depop.com/sellinghub/sold-items/")
    }

    @Test func `an order without a label file prints nothing`() async throws {
        let printer = FakePrinter()
        let files = FakeLabelFiles()
        let model = try LabelPrintModel(
            order: labeledOrder("sale-a", file: false), service: FakePackService(), files: files, printer: printer,
        )
        await model.print()
        guard case .failed = model.stage else { Issue.record("not failed"); return }
        #expect(await files.downloads.isEmpty)
        #expect(printer.jobs.isEmpty)
    }

    @Test func `a print canceled in the print sheet is not recorded`() async throws {
        let service = FakePackService()
        let printer = FakePrinter()
        printer.completes = false
        let model = try LabelPrintModel(
            order: labeledOrder("sale-a"), service: service, files: FakeLabelFiles(), printer: printer,
        )
        await model.print()
        #expect(model.stage == .ready)
        #expect(await service.labelPrints.isEmpty)
    }

    @Test func `a print Listora couldn't record is recorded once on a retry`() async throws {
        let service = FakePackService()
        await service.setFailRecord(true)
        let model = try LabelPrintModel(
            order: labeledOrder("sale-a"), service: service, files: FakeLabelFiles(), printer: FakePrinter(),
        )
        await model.print()
        guard case .notRecorded = model.stage else { Issue.record("not notRecorded: \(model.stage)"); return }
        await service.setFailRecord(false)
        await model.record()
        await model.record()
        #expect(model.stage == .printed)
        #expect(await service.labelPrints.count == 1)
    }
}

/// Answers the label downloads of ``SessionLabelFiles`` in tests, by URL, and keeps the requests.
final class LabelStubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var answers: [String: (status: Int, body: Data)] = [:]
    nonisolated(unsafe) static var requests: [URLRequest] = []
    static let lock = NSLock()

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LabelStubProtocol.self]
        return URLSession(configuration: configuration)
    }

    static func answer(_ url: String, status: Int, body: Data) {
        lock.withLock { answers[url] = (status, body) }
    }

    static func sent(to url: String) -> URLRequest? {
        lock.withLock { requests.last { $0.url?.absoluteString == url } }
    }

    override static func canInit(with _: URLRequest) -> Bool {
        true
    }

    override static func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let url = request.url?.absoluteString ?? ""
        let answer = Self.lock.withLock {
            Self.requests.append(request)
            return Self.answers[url]
        } ?? (status: 404, body: Data())
        if let url = request.url,
           let response = HTTPURLResponse(url: url, statusCode: answer.status, httpVersion: nil, headerFields: nil)
        {
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        }
        client?.urlProtocol(self, didLoad: answer.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// A phone holding a Depop session.
final class FakeSessions: MarketplaceSessionStore, @unchecked Sendable {
    let stored: [String: [StoredCookie]]

    init(_ stored: [String: [StoredCookie]]) {
        self.stored = stored
    }

    func cookies(for marketplace: String) -> [StoredCookie] {
        stored[marketplace] ?? []
    }

    func save(_: [StoredCookie], for _: String) {}
    func keep(onlyFor _: String, formerly _: String?) {}
    func removeAll() {}
    func isReadOnly(_: String) -> Bool {
        false
    }

    func setReadOnly(_: Bool, for _: String) {}
}

func cookie(_ name: String, _ value: String, domain: String = ".depop.com", path: String = "/") -> StoredCookie {
    StoredCookie(
        name: name, value: value, domain: domain, path: path, expires: nil, secure: true, httpOnly: false,
        sameSite: nil,
    )
}

struct SessionLabelFilesTests {
    let depop = FakeSessions(["depop": [
        cookie("access_token", "invented-token"),
        cookie("session", "invented-session"),
        cookie("other_site", "x", domain: ".example.com"),
    ]])

    @Test func `it downloads the label through the seller's own session, as Depop's page would`() async throws {
        let url = "https://webapi.depop.com/presentation/api/v1/receipts/412/label/"
        LabelStubProtocol.answer(url, status: 200, body: Data("%PDF-1.4 invented".utf8))
        let files = SessionLabelFiles(sessions: depop, allowsLocalHTTP: false, urlSession: LabelStubProtocol.session())
        let data = try await files.labelFile(at: #require(URL(string: url)), marketplace: "depop")
        #expect(SessionLabelFiles.isPDF(data))
        let sent = try #require(LabelStubProtocol.sent(to: url))
        #expect(sent.httpMethod == "GET")
        #expect(sent.value(forHTTPHeaderField: "Authorization") == "Bearer invented-token")
        // Only the session's cookies for Depop, never another site's.
        #expect(sent.value(forHTTPHeaderField: "Cookie") == "access_token=invented-token; session=invented-session")
    }

    @Test func `it fetches only from the marketplace's own site, over https`() throws {
        let cookies = depop.cookies(for: "depop")
        let allowed = { (url: String, local: Bool) in
            try SessionLabelFiles.allows(#require(URL(string: url)), cookies: cookies, localHTTP: local)
        }
        #expect(try allowed("https://webapi.depop.com/label.pdf", false))
        #expect(try allowed("https://depop.com/label.pdf", false))
        #expect(try !allowed("https://labels.example.org/label.pdf", false))
        #expect(try !allowed("https://depop.com.example.org/label.pdf", false))
        #expect(try !allowed("http://webapi.depop.com/label.pdf", false))
        // A Dev build's local stand-in of the marketplace.
        #expect(try allowed("http://127.0.0.1:4100/label.pdf", true))
        #expect(try !allowed("http://127.0.0.1:4100/label.pdf", false))
        #expect(try !allowed("http://192.168.1.2/label.pdf", true))
    }

    @Test func `what isn't a label, a signed-out session, and no session say so`() async throws {
        let session = LabelStubProtocol.session()
        let files = SessionLabelFiles(sessions: depop, allowsLocalHTTP: false, urlSession: session)
        let page = "https://www.depop.com/not-a-label/"
        LabelStubProtocol.answer(page, status: 200, body: Data("<html>".utf8))
        await #expect(throws: LabelFileError.notALabel) {
            try await files.labelFile(at: #require(URL(string: page)), marketplace: "depop")
        }
        let signedOut = "https://www.depop.com/signed-out.pdf"
        LabelStubProtocol.answer(signedOut, status: 401, body: Data())
        await #expect(throws: LabelFileError.signedOut) {
            try await files.labelFile(at: #require(URL(string: signedOut)), marketplace: "depop")
        }
        let elsewhere = SessionLabelFiles(sessions: FakeSessions([:]), allowsLocalHTTP: false, urlSession: session)
        await #expect(throws: LabelFileError.notLinked) {
            try await elsewhere.labelFile(at: #require(URL(string: signedOut)), marketplace: "depop")
        }
    }

    @Test func `a cookie goes only where a browser would send it`() throws {
        let url = try #require(URL(string: "https://www.depop.com/sellinghub/labels/1.pdf"))
        #expect(cookie("a", "1").isSent(to: url))
        #expect(cookie("a", "1", path: "/sellinghub").isSent(to: url))
        #expect(!cookie("a", "1", path: "/products").isSent(to: url))
        #expect(!cookie("a", "1", domain: "webapi.depop.com").isSent(to: url))
        let expired = StoredCookie(
            name: "a", value: "1", domain: ".depop.com", path: "/", expires: Date(timeIntervalSince1970: 0),
            secure: true, httpOnly: false, sameSite: nil,
        )
        #expect(!expired.isSent(to: url))
    }
}

@MainActor
struct LabelPrintJobTests {
    @Test func `the stickers follow the label on pages of its size, four to a page`() throws {
        let label = LabelPrintJob.testLabel(named: "412")
        let stickers = (1 ... 5).map { StickerRequest(sku: "AJ-00000\($0)", title: "Item \($0)", locationCode: nil) }
        let job = try #require(LabelPrintJob.pdf(label: label, stickers: stickers).flatMap(PDFDocument.init(data:)))
        #expect(job.pageCount == 3)
        for index in 0 ..< job.pageCount {
            #expect(job.page(at: index)?.bounds(for: .mediaBox).size == LabelPrintJob.labelSize)
        }
        #expect(job.page(at: 0)?.string?.contains("TEST LABEL 412") == true)
        #expect(LabelPrintJob.pdf(label: Data("not a pdf".utf8), stickers: stickers) == nil)
    }
}
