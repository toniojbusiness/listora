import Foundation
import Testing
@testable import DesignSystem

struct ShimmerTests {
    @Test
    func `the highlight sweeps from the leading edge across and starts over`() {
        let sweep = ShimmerModifier.sweep
        #expect(ShimmerModifier.sweepPhase(at: 0) == -1)
        #expect(abs(ShimmerModifier.sweepPhase(at: sweep / 2)) < 0.0001)
        #expect(ShimmerModifier.sweepPhase(at: sweep * 0.99) > 0.9)
        #expect(ShimmerModifier.sweepPhase(at: sweep) == -1)
        #expect(abs(ShimmerModifier.sweepPhase(at: 10 * sweep + sweep / 4) - -0.5) < 0.0001)
    }

    @Test
    func `the Reduce Motion pulse dims to 0.6 and comes back`() {
        let pulse = ShimmerModifier.pulse
        #expect(ShimmerModifier.pulseOpacity(at: 0) == 1)
        #expect(abs(ShimmerModifier.pulseOpacity(at: pulse) - 0.6) < 0.0001)
        #expect(abs(ShimmerModifier.pulseOpacity(at: 2 * pulse) - 1) < 0.0001)
        #expect(abs(ShimmerModifier.pulseOpacity(at: pulse / 2) - 0.8) < 0.0001)
        for step in 0 ..< 100 {
            let opacity = ShimmerModifier.pulseOpacity(at: Double(step) * 0.07)
            #expect(opacity >= 0.6 && opacity <= 1)
        }
    }
}
