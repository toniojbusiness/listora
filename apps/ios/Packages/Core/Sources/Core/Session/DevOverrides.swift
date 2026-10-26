#if DEBUG
    import Foundation

    /// The Dev-build hook that lets UI tests run the Share Extension against a stub API. The app
    /// stores the stub's URL in the App Group at launch (`LISTORA_DEV_API_BASE_URL`), where the
    /// extension, which a test cannot launch with an environment of its own, reads it. Compiled
    /// into Debug builds only and honored only in the Dev environment, so a Staging or Prod build
    /// can never be redirected.
    public enum DevOverrides {
        private static let apiBaseURLKey = "ListoraDevAPIBaseURL"

        /// Sets the API base URL override, or removes it when `url` is nil (a launch without one),
        /// so a normal Dev run never stays on a test's stub. Does nothing outside Dev.
        public static func storeAPIBaseURL(_ url: URL?, for configuration: AppConfiguration) {
            guard configuration.environment == .dev,
                  let defaults = UserDefaults(suiteName: configuration.appGroupIdentifier)
            else { return }
            if let url {
                defaults.set(url.absoluteString, forKey: apiBaseURLKey)
            } else {
                defaults.removeObject(forKey: apiBaseURLKey)
            }
        }

        /// The configuration with the API base URL override applied, when one is set and valid.
        public static func applied(to configuration: AppConfiguration) -> AppConfiguration {
            guard configuration.environment == .dev,
                  let raw = UserDefaults(suiteName: configuration.appGroupIdentifier)?.string(forKey: apiBaseURLKey),
                  let url = URL(string: raw),
                  let overridden = try? AppConfiguration(
                      environment: configuration.environment,
                      apiBaseURL: url,
                      appGroupIdentifier: configuration.appGroupIdentifier,
                      sessionKeychainGroup: configuration.sessionKeychainGroup,
                      cognito: configuration.cognito,
                  )
            else { return configuration }
            return overridden
        }
    }
#endif
