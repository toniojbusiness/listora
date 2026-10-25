import APIClient
import Foundation
import ListoraAPI

public typealias UserTask = Components.Schemas.UserTask
typealias Photo = Components.Schemas.Photo

/// What the user's confirmation says besides "done": a list task's new listing link, or a sale
/// email review's answer (the item that sold, or that none did).
struct TaskCompletion: Equatable, Sendable {
    var listingURL: String?
    var matchedItemID: String?
    /// None of the user's items sold.
    var rejectMatch = false
}

/// The task inbox's calls, returning the contract's types and throwing ``APIFailure`` for every
/// other answer. A protocol so the models' tests run against a fake. Only the server finishes a
/// task: these calls send the user's confirmation, and the screens show what the server answers.
protocol TasksService: Sendable {
    /// Open tasks, urgent first, then oldest first; `itemID` narrows them to one item.
    func openTasks(itemID: String?) async throws(APIFailure) -> [UserTask]
    func task(id: String) async throws(APIFailure) -> UserTask
    /// The user's confirmation that they did the task; a listing link links a new listing, and a
    /// review's answer records the sale of the item they picked (or nothing).
    func complete(taskID: String, completion: TaskCompletion, idempotencyKey: String) async throws(APIFailure)
        -> UserTask
    /// The user gives up on the task; its operation fails with a Retry.
    func dismiss(taskID: String, idempotencyKey: String) async throws(APIFailure) -> UserTask
}

/// ``TasksService`` over the generated client.
struct APITasksService: TasksService {
    let client: Client

    /// The inbox reads up to this many pages of open tasks.
    private static let pageLimit = 4

    func openTasks(itemID: String?) async throws(APIFailure) -> [UserTask] {
        var tasks: [UserTask] = []
        var cursor: String?
        for _ in 0 ..< Self.pageLimit {
            let output = try await call {
                try await client.listTasks(query: .init(status: [.open], itemId: itemID, cursor: cursor, limit: 100))
            }
            switch output {
            case let .ok(response):
                let page = try body { try response.body.json }
                tasks += page.data
                cursor = page.nextCursor
            case let .badRequest(response): throw APIFailure(statusCode: 400, response: response)
            case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
            }
            if cursor == nil {
                break
            }
        }
        return tasks
    }

    func task(id: String) async throws(APIFailure) -> UserTask {
        switch try await call({ try await client.getTask(path: .init(taskId: id)) }) {
        case let .ok(response): try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func complete(taskID: String, completion: TaskCompletion, idempotencyKey: String) async throws(APIFailure)
        -> UserTask
    {
        let output = try await call {
            try await client.completeTask(
                path: .init(taskId: taskID),
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(.init(
                    externalUrl: completion.listingURL,
                    matchedItemId: completion.matchedItemID,
                    rejectMatch: completion.rejectMatch ? true : nil,
                )),
            )
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func dismiss(taskID: String, idempotencyKey: String) async throws(APIFailure) -> UserTask {
        let output = try await call {
            try await client.dismissTask(path: .init(taskId: taskID), headers: .init(idempotencyKey: idempotencyKey))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    private func call<Output>(_ request: () async throws -> Output) async throws(APIFailure) -> Output {
        do {
            return try await request()
        } catch {
            throw APIFailure(error)
        }
    }

    private func body<Body>(_ read: () throws -> Body) throws(APIFailure) -> Body {
        do {
            return try read()
        } catch {
            throw APIFailure(error)
        }
    }
}
