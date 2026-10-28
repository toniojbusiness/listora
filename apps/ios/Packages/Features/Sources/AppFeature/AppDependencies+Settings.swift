import APIClient
import Core
import Foundation
import ImportFeature
import MarketplaceLinkingFeature
import PhoneExecutionFeature
import SettingsFeature
import SignInFeature

/// What Settings needs beyond the other features' screens.
@MainActor
public struct SettingsModels {
    /// The seller's profile (Settings, and the avatar in the Today and Sales headers).
    public let profile: ProfileModel
    /// Settings > Sale emails, and "Ask before delisting" in Settings > Notifications.
    public let saleEmails: SaleEmailsModel
    /// Settings > Delete account.
    public let accountDeletion: AccountDeletionModel
    /// Settings > Import your listings: the listings a seller already has, brought in as items.
    public let imports: ImportsModel
    /// Settings > People: the owner's invites.
    public let invites: InvitesModel
    /// Settings > Description style: how Listora's AI writes the seller's Depop drafts.
    public let descriptionStyle: DescriptionStyleModel

    /// `profileDirectory` keeps the profile photo; `LISTORA_RESET_LOCAL_DATA` empties it first.
    init(
        _ apiClient: APIClient,
        _ accessTokens: AccessTokenStore,
        _ signIn: SignInModel,
        _ phone: PhoneExecutionEnvironment,
        _ profileDirectory: URL,
        _ launchOptions: DebugLaunchOptions,
    ) {
        if launchOptions.resetLocalData {
            try? FileManager.default.removeItem(at: profileDirectory)
        }
        let profile = ProfileModel(
            service: APIProfileService(client: apiClient.client),
            photos: FileAvatarStore(directory: profileDirectory),
            signedInEmail: { signIn.stage.signedInEmail },
        )
        self.profile = profile
        saleEmails = SaleEmailsModel(service: APISaleEmailsService(api: apiClient))
        invites = InvitesModel(service: APIInvitesService(client: apiClient.client))
        descriptionStyle = DescriptionStyleModel(service: APIDescriptionStyleService(client: apiClient.client))
        accountDeletion = Self.accountDeletion(apiClient, accessTokens, signIn, phone.sessions, profile)
        imports = AppDependencies.makeImports(apiClient, phone)
    }

    /// Deleting the account. It signs out, but its result (the marketplaces to revoke by hand)
    /// stays on screen until Settings closes; then the sign-in shows. It also removes the
    /// marketplace sessions and the profile photo this phone kept for the account.
    private static func accountDeletion(
        _ apiClient: APIClient,
        _ accessTokens: AccessTokenStore,
        _ signIn: SignInModel,
        _ sessions: any MarketplaceSessionStore,
        _ profile: ProfileModel,
    ) -> AccountDeletionModel {
        AccountDeletionModel(
            service: APIAccountDeletionService(client: apiClient.client),
            isSignedIn: { accessTokens.grant != nil },
            signOut: {
                let email = signIn.stage.signedInEmail
                signIn.signOutKeepingScreen()
                sessions.removeAll()
                profile.accountDeleted(email: email)
            },
        )
    }
}
