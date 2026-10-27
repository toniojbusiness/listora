import APIClient
import ImportFeature
import PhoneExecutionFeature
import SwiftUI

extension AppDependencies {
    /// Import listings: a marketplace that runs on this phone reads its pages here, so starting an
    /// import runs the phone's waiting work at once.
    static func makeImports(_ apiClient: APIClient, _ phone: PhoneExecutionEnvironment) -> ImportsModel {
        let model = ImportsModel(service: APIImportsService(client: apiClient.client))
        model.phoneWork = phone.runner
        return model
    }

    /// The Import listings screen, with each import's questions.
    func importsScreen() -> AnyView {
        let service = APIImportsService(client: apiClient.client)
        return AnyView(ImportsView(model: settings.imports) { importID in
            ImportQuestionsModel(importID: importID, service: service)
        })
    }
}
