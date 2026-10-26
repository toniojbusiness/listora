import SwiftUI

/// A small, short burst of confetti in the palette's colors, with a success haptic, for the moment
/// an item sells. It plays when the view appears with a non-nil `trigger`, and again each time
/// `trigger` changes to a new non-nil value, over the view, without blocking taps. With Reduce Motion on, nothing
/// moves: a soft glow fades in and out
/// instead.
struct CelebrationModifier<Trigger: Equatable>: ViewModifier {
    let trigger: Trigger?
    @State private var start: Date?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .overlay {
                if let start {
                    Group {
                        if reduceMotion {
                            CelebrationGlow()
                        } else {
                            ConfettiBurst(start: start)
                        }
                    }
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
            }
            .onChange(of: trigger, initial: true) { _, new in
                guard new != nil else { return }
                Haptics.play(.success)
                let started = Date()
                start = started
                Task {
                    try? await Task.sleep(for: .seconds(ConfettiBurst.duration))
                    if start == started {
                        start = nil
                    }
                }
            }
    }
}

/// The confetti: pieces thrown up and out from the top center that fall back with gravity, spin,
/// and fade. Their paths come from a fixed seed, so every burst looks the same.
struct ConfettiBurst: View {
    let start: Date
    static let duration: TimeInterval = 1.8
    /// Points per second squared: pieces rise a little, then rain down across the screen.
    static let gravity = 900.0
    private static let pieces: [Piece] = Piece.make(count: 36)
    private static let colors: [ColorToken] = [
        Palette.brand, Palette.success, Palette.warning, Palette.info, Palette.brandSoft,
    ]

    var body: some View {
        TimelineView(.animation) { timeline in
            let elapsed = timeline.date.timeIntervalSince(start)
            Canvas { context, size in
                let origin = CGPoint(x: size.width / 2, y: size.height * 0.2)
                let progress = min(max(elapsed / Self.duration, 0), 1)
                for piece in Self.pieces {
                    let time = elapsed
                    let x = origin.x + piece.velocity.dx * time
                    let y = origin.y + piece.velocity.dy * time + 0.5 * Self.gravity * time * time
                    var layer = context
                    layer.opacity = 1 - progress * progress
                    layer.translateBy(x: x, y: y)
                    layer.rotate(by: .degrees(piece.spin * time))
                    let rect = CGRect(
                        x: -piece.size.width / 2,
                        y: -piece.size.height / 2,
                        width: piece.size.width,
                        height: piece.size.height,
                    )
                    let color = Self.colors[piece.colorIndex % Self.colors.count].color
                    layer.fill(
                        Path(roundedRect: rect, cornerRadius: piece.isRound ? piece.size.width / 2 : 1.5),
                        with: .color(color),
                    )
                }
            }
        }
    }

    struct Piece {
        let velocity: CGVector
        let size: CGSize
        let spin: Double
        let colorIndex: Int
        let isRound: Bool

        /// A fixed pseudo-random spread (a linear congruential generator), so bursts are the same
        /// every time and in tests.
        static func make(count: Int) -> [Piece] {
            var seed: UInt64 = 0x5EED
            func next() -> Double {
                seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
                return Double(seed >> 33) / Double(1 << 31)
            }
            return (0 ..< count).map { index in
                let angle = -Double.pi / 2 + (next() - 0.5) * Double.pi * 0.85
                let speed = 260 + next() * 260
                let isRound = index.isMultiple(of: 3)
                let side = 6 + next() * 4
                return Piece(
                    velocity: CGVector(dx: cos(angle) * speed, dy: sin(angle) * speed),
                    size: isRound ? CGSize(width: side, height: side) : CGSize(width: side, height: side * 1.8),
                    spin: (next() - 0.5) * 720,
                    colorIndex: index,
                    isRound: isRound,
                )
            }
        }
    }
}

/// The Reduce Motion celebration: a soft success-colored glow that fades in and out in place.
private struct CelebrationGlow: View {
    @State private var isVisible = false

    var body: some View {
        RadialGradient(
            colors: [Palette.success.color.opacity(0.22), .clear],
            center: .top,
            startRadius: 0,
            endRadius: 420,
        )
        .ignoresSafeArea()
        .opacity(isVisible ? 1 : 0)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.4)) { isVisible = true }
            withAnimation(.easeInOut(duration: 0.6).delay(0.8)) { isVisible = false }
        }
    }
}

extension View {
    /// Celebrates (confetti and a success haptic) when the view appears with a non-nil `trigger`
    /// and each time it becomes a new non-nil value, such as the id of a sale just recorded.
    public func celebration(trigger: (some Equatable)?) -> some View {
        modifier(CelebrationModifier(trigger: trigger))
    }
}

#Preview {
    @Previewable @State var sale: Int?
    Button("Sold") { sale = (sale ?? 0) + 1 }
        .buttonStyle(.listoraPrimary)
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.background)
        .celebration(trigger: sale)
}
