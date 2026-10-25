import SwiftUI
import UIKit

/// Reports every tap anywhere in the app's window, sheets included, for the interaction
/// measurement (`InteractionMeter`). Its recognizer runs alongside every other one and never
/// takes a touch from the view it lands on. The system keyboard and the photo picker are not part
/// of the window, so their taps are not seen.
struct WindowTapCounter: UIViewRepresentable {
    let onTap: @MainActor () -> Void

    func makeUIView(context _: Context) -> TapCounterView {
        TapCounterView(onTap: onTap)
    }

    func updateUIView(_: TapCounterView, context _: Context) {}
}

final class TapCounterView: UIView, UIGestureRecognizerDelegate {
    private let onTap: @MainActor () -> Void
    private var recognizer: UITapGestureRecognizer?

    init(onTap: @escaping @MainActor () -> Void) {
        self.onTap = onTap
        super.init(frame: .zero)
        isUserInteractionEnabled = false
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        preconditionFailure("TapCounterView is never decoded")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if let recognizer {
            recognizer.view?.removeGestureRecognizer(recognizer)
            self.recognizer = nil
        }
        guard let window else { return }
        let recognizer = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        recognizer.cancelsTouchesInView = false
        recognizer.delaysTouchesBegan = false
        recognizer.delaysTouchesEnded = false
        recognizer.delegate = self
        window.addGestureRecognizer(recognizer)
        self.recognizer = recognizer
    }

    @objc
    private func tapped(_ recognizer: UITapGestureRecognizer) {
        if recognizer.state == .ended {
            onTap()
        }
    }

    func gestureRecognizer(
        _: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith _: UIGestureRecognizer,
    ) -> Bool {
        true
    }
}
