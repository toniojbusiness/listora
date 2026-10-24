import Core
import Testing

struct AppVersionTests {
    @Test
    func `formats marketing version and build`() {
        let version = AppVersion(infoDictionary: ["CFBundleShortVersionString": "1.2.0", "CFBundleVersion": "42"])
        #expect(version == AppVersion(marketing: "1.2.0", build: "42"))
        #expect(version.description == "1.2.0 (42)")
    }

    @Test
    func `shows a placeholder for missing or empty values`() {
        #expect(AppVersion(infoDictionary: [:]).description == "? (?)")
        #expect(AppVersion(infoDictionary: ["CFBundleShortVersionString": "", "CFBundleVersion": 7])
            .description == "? (?)")
    }
}
