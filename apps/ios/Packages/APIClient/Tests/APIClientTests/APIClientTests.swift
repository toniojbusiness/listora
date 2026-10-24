import APIClient
import Foundation
import Testing

struct APIClientTests {
    @Test
    func `keeps the configured base URL`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:3000"))
        #expect(APIClient(baseURL: url).baseURL == url)
    }
}
