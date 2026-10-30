import APIClient
import Core
import Foundation
import Observation

/// Printing one order's shipping label with its item stickers, in one job (docs/features/pack-check.md,
/// "Printing the label"): the label's file is downloaded on this iPhone through the seller's
/// session on the marketplace, put together with the order's stickers, and printed through
/// AirPrint; then Listora records the print. A label printed before asks first, since a second
/// copy on another package ships one buyer two packages.
@MainActor
@Observable
final class LabelPrintModel {
    enum Stage: Equatable {
        case ready
        /// Listora printed this label before: the seller says whether to print it again.
        case confirmingReprint
        case downloading
        case printing
        case recording
        /// Printed and recorded.
        case printed
        /// Nothing printed: why, and whether the label can still be printed on the marketplace.
        case failed(message: String)
        /// Printed, but Listora couldn't record it yet: the next print wouldn't warn.
        case notRecorded(message: String)
    }

    private(set) var stage: Stage = .ready
    private(set) var order: PackOrder

    private let service: any PackCheckService
    private let files: any LabelFileSource
    private let printer: any LabelPrinter
    private let onChange: @MainActor (PackOrder) -> Void
    /// The print being recorded, for a retry that must not count it twice.
    private var pending: (trackingNumber: String, idempotencyKey: String)?

    init(
        order: PackOrder,
        service: any PackCheckService,
        files: any LabelFileSource,
        printer: any LabelPrinter,
        onChange: @escaping @MainActor (PackOrder) -> Void = { _ in },
    ) {
        self.order = order
        self.service = service
        self.files = files
        self.printer = printer
        self.onChange = onChange
    }

    /// The order's stickers, one per item.
    var stickers: [StickerRequest] {
        order.items.map(StickerRequest.init)
    }

    var marketplace: String {
        MarketplaceName.of(order.marketplace)
    }

    /// "Label printed 12 minutes ago", once Listora printed this label.
    var printedBefore: String? {
        order.label?.printed?.label
    }

    /// The order's page on the marketplace, where its label prints there.
    var labelPage: URL? {
        order.labelPageUrl.flatMap(URL.init(string:))
    }

    var isWorking: Bool {
        switch stage {
        case .downloading, .printing, .recording: true
        default: false
        }
    }

    /// Prints the label and the stickers; a label printed before asks first (`confirmed` once the
    /// seller said to print it again).
    func print(confirmed: Bool = false) async {
        guard !isWorking else { return }
        guard let label = order.label, let file = label.fileUrl.flatMap(URL.init(string:)) else {
            stage = .failed(message: "Listora can't print this label. Open it on \(marketplace) instead.")
            return
        }
        if label.printed != nil, !confirmed {
            stage = .confirmingReprint
            return
        }
        stage = .downloading
        let data: Data
        do {
            data = try await files.labelFile(at: file, marketplace: order.marketplace.value1?.rawValue ?? "")
        } catch {
            stage = .failed(message: error.message(marketplace: marketplace))
            return
        }
        guard let job = LabelPrintJob.pdf(label: data, stickers: stickers) else {
            stage = .failed(message: LabelFileError.notALabel.message(marketplace: marketplace))
            return
        }
        stage = .printing
        guard await printer.print(job, jobName: "Listora label and stickers") else {
            // Canceled in the print sheet: nothing printed.
            stage = .ready
            return
        }
        pending = (label.trackingNumber, UUID().uuidString)
        await record()
    }

    /// Records the print that went out (again, after a failure: the same key counts it once).
    func record() async {
        guard let pending else { return }
        stage = .recording
        do {
            let updated = try await service.recordLabelPrint(
                saleID: order.saleId,
                trackingNumber: pending.trackingNumber,
                idempotencyKey: pending.idempotencyKey,
            )
            self.pending = nil
            order = updated
            onChange(updated)
            stage = .printed
        } catch {
            stage = .notRecorded(message: error.message)
        }
    }

    /// The seller decided not to print it again.
    func cancelReprint() {
        stage = .ready
    }
}

/// Prints a PDF through AirPrint; `true` once the job went to the printer.
protocol LabelPrinter: Sendable {
    @MainActor func print(_ pdf: Data, jobName: String) async -> Bool
}

/// The system's print sheet.
struct AirPrinter: LabelPrinter {
    @MainActor func print(_ pdf: Data, jobName: String) async -> Bool {
        await withCheckedContinuation { continuation in
            Printer.print(pdf, jobName: jobName) { completed in continuation.resume(returning: completed) }
        }
    }
}

/// UI tests' stand-in (`LISTORA_SCRIPTED_PRINTING`): every job "prints" at once, with no sheet.
struct ScriptedPrinter: LabelPrinter {
    @MainActor func print(_: Data, jobName _: String) async -> Bool {
        true
    }
}
