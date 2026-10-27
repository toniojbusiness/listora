import APIClient
import Core
import DesignSystem
import Foundation
import ListoraAPI
import Observation

/// An import's questions (docs/features/imports.md): each listing the import was not sure about,
/// with the items it may be. The seller says which item it is, that it is an item of its own, or
/// to leave it out; a question goes away only once the server took the answer.
@MainActor
@Observable
public final class ImportQuestionsModel {
    public enum Phase: Equatable {
        case loading
        case loaded
        case failed(message: String)
    }

    public enum Answer: Equatable, Sendable {
        case sameItem(itemID: String)
        case newItem
        case skip
    }

    public private(set) var questions: [Components.Schemas.ListingImportQuestion] = []
    public private(set) var phase: Phase = .loading
    /// The question being answered right now.
    public private(set) var answering: String?
    /// The import's summary after the latest answer.
    public private(set) var summary: String?
    public private(set) var failure: String?

    public let importID: String
    private let service: any ImportsService
    /// Keys of answers whose reply was lost, sent again with them so each counts once.
    private var pendingKeys: [String: String] = [:]

    public init(importID: String, service: any ImportsService) {
        self.importID = importID
        self.service = service
    }

    public func load() async {
        if questions.isEmpty {
            phase = .loading
        }
        do {
            questions = try await service.questions(importID: importID)
            phase = .loaded
        } catch {
            phase = .failed(message: error.message)
        }
    }

    public func answer(_ question: Components.Schemas.ListingImportQuestion, _ answer: Answer) async {
        guard answering == nil else { return }
        answering = question.id
        failure = nil
        defer { answering = nil }
        let key = pendingKeys[question.id] ?? UUID().uuidString
        pendingKeys[question.id] = key
        let body: Components.Schemas.ListingImportAnswer = switch answer {
        case let .sameItem(itemID): .init(answer: .sameItem, itemId: itemID)
        case .newItem: .init(answer: .newItem)
        case .skip: .init(answer: .skip)
        }
        do {
            let updated = try await service.answer(
                importID: importID,
                questionID: question.id,
                answer: body,
                idempotencyKey: key,
            )
            pendingKeys[question.id] = nil
            summary = updated.summary
            questions.removeAll { $0.id == question.id }
        } catch {
            if error.retryable == false {
                pendingKeys[question.id] = nil
            }
            failure = error.message
            // Answered elsewhere, or its item went away: the list as the server has it now.
            if error.statusCode == 409 || error.statusCode == 404 {
                await load()
            }
        }
    }
}
