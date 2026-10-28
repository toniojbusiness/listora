import DesignSystem
import SwiftUI

/// A large in-app number pad for amounts: thumb-sized keys, no system keyboard to open or dismiss.
struct KeypadView: View {
    let onPress: (AmountEntry.Key) -> Void

    private let rows: [[AmountEntry.Key]] = [
        [.digit(1), .digit(2), .digit(3)],
        [.digit(4), .digit(5), .digit(6)],
        [.digit(7), .digit(8), .digit(9)],
        [.decimalPoint, .digit(0), .delete],
    ]

    var body: some View {
        Grid(horizontalSpacing: Spacing.xs, verticalSpacing: Spacing.xs) {
            ForEach(rows.indices, id: \.self) { row in
                GridRow {
                    ForEach(rows[row], id: \.self) { key in
                        Button {
                            onPress(key)
                        } label: {
                            label(for: key)
                                .frame(maxWidth: .infinity, minHeight: Layout.buttonHeight)
                                .background(
                                    Palette.surface,
                                    in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous),
                                )
                                .overlay(
                                    RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
                                        .strokeBorder(Palette.separator, lineWidth: 1),
                                )
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(KeypadKeyStyle())
                        .accessibilityLabel(accessibilityName(for: key))
                        .accessibilityIdentifier("keypad.\(identifier(for: key))")
                    }
                }
            }
        }
        // Digits stay legible at every size; past this the pad would push the amount off screen.
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
    }

    @ViewBuilder
    private func label(for key: AmountEntry.Key) -> some View {
        switch key {
        case let .digit(digit):
            Text("\(digit)").font(Typography.keypad)
        case .decimalPoint:
            Text(".").font(Typography.keypad)
        case .delete:
            Image(systemName: "delete.left").font(Typography.headline)
        }
    }

    private func identifier(for key: AmountEntry.Key) -> String {
        switch key {
        case let .digit(digit): "\(digit)"
        case .decimalPoint: "point"
        case .delete: "delete"
        }
    }

    private func accessibilityName(for key: AmountEntry.Key) -> String {
        switch key {
        case let .digit(digit): "\(digit)"
        case .decimalPoint: "Decimal point"
        case .delete: "Delete"
        }
    }
}

private struct KeypadKeyStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Palette.textPrimary)
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

/// The amount being typed on the keypad, large and centered; gray while empty.
struct AmountDisplay: View {
    let entry: AmountEntry
    let label: String
    let identifier: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Text(entry.display)
            .font(Typography.amountEntry)
            .foregroundStyle(entry.isEmpty ? Palette.textSecondary : Palette.textPrimary)
            .contentTransition(reduceMotion ? .identity : .numericText())
            .animation(Motion.animation(Motion.snappy, reduceMotion: reduceMotion), value: entry)
            .lineLimit(1)
            .minimumScaleFactor(0.5)
            .frame(maxWidth: .infinity, minHeight: Layout.buttonHeight)
            .accessibilityLabel(label)
            .accessibilityValue(entry.isEmpty ? "None" : entry.display)
            .accessibilityIdentifier(identifier)
    }
}
