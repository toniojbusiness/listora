import DesignSystem
import Foundation
import Observation

/// Dev builds only: which palette direction the app draws in (``PaletteTheme``), kept across
/// launches, so the candidate themes can be compared on a device. `LISTORA_PALETTE=<id>` picks one
/// at launch (debug builds), as the screenshot tour does. Other builds always use
/// ``PaletteTheme/standard``.
@MainActor
@Observable
public final class PaletteSwitch {
    static let defaultsKey = "dev.paletteTheme"

    private let defaults: UserDefaults
    public private(set) var selection: PaletteTheme.Key

    init(defaults: UserDefaults, launchChoice: PaletteTheme.Key?) {
        self.defaults = defaults
        selection = launchChoice
            ?? defaults.string(forKey: Self.defaultsKey).flatMap(PaletteTheme.Key.init(rawValue:))
            ?? PaletteTheme.standard.id
        apply()
    }

    public func select(_ id: PaletteTheme.Key) {
        selection = id
        apply()
    }

    private func apply() {
        defaults.set(selection.rawValue, forKey: Self.defaultsKey)
        Palette.theme = .with(id: selection)
    }
}
