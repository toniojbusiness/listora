import Foundation
import SwiftUI

/// What the seller typed into a ``PriceField``, kept to a valid amount as they type: digits and one
/// decimal separator ("." or the locale's), at most two decimals, and at most ``maxIntegerDigits``
/// whole digits. Anything else is dropped, so the field never holds text that is not a price.
public struct PriceInput: Equatable, Sendable {
    public static let maxIntegerDigits = 7

    /// The cleaned text, as shown in the field ("12.5", "0.99", "").
    public let text: String

    public init(_ raw: String, decimalSeparator: String = Locale.current.decimalSeparator ?? ".") {
        var whole = ""
        var fraction = ""
        var hasSeparator = false
        for character in raw {
            if character.isASCII, character.isNumber {
                if hasSeparator {
                    if fraction.count < 2 {
                        fraction.append(character)
                    }
                } else if whole.count < Self.maxIntegerDigits {
                    whole.append(character)
                }
            } else if !hasSeparator, character == "." || String(character) == decimalSeparator {
                hasSeparator = true
            }
        }
        // "007" is 7; a lone separator becomes "0.".
        while whole.count > 1, whole.hasPrefix("0") {
            whole.removeFirst()
        }
        if hasSeparator, whole.isEmpty {
            whole = "0"
        }
        text = hasSeparator ? "\(whole).\(fraction)" : whole
    }

    /// The amount, or nil when nothing was entered.
    public var amount: Decimal? {
        text.isEmpty ? nil : Decimal(string: text, locale: Locale(identifier: "en_US_POSIX"))
    }

    /// The amount in minor units (cents), or nil when nothing was entered.
    public var minorUnits: Int? {
        guard let amount else { return nil }
        var cents = amount * 100
        var rounded = Decimal()
        NSDecimalRound(&rounded, &cents, 0, .plain)
        return NSDecimalNumber(decimal: rounded).intValue
    }
}

/// A price entry: the currency symbol, then the amount in large tabular digits on the decimal
/// keypad, kept valid by ``PriceInput``. The binding holds the amount in minor units (cents), so
/// callers never parse text. VoiceOver reads the label and the formatted amount.
public struct PriceField: View {
    private let label: String
    @Binding private var minorUnits: Int?
    private let currencyCode: String
    private let hint: String?
    @State private var text: String
    @FocusState private var isFocused: Bool

    public init(_ label: String, minorUnits: Binding<Int?>, currencyCode: String = "USD", hint: String? = nil) {
        self.label = label
        _minorUnits = minorUnits
        self.currencyCode = currencyCode
        self.hint = hint
        _text = State(initialValue: minorUnits.wrappedValue.map(Self.text(forMinorUnits:)) ?? "")
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(label)
                .font(Typography.subheadline.weight(.semibold))
                .foregroundStyle(Palette.textPrimary)
                .accessibilityHidden(true)
            HStack(alignment: .firstTextBaseline, spacing: Spacing.xxs) {
                Text(currencySymbol)
                    .font(Typography.title)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityHidden(true)
                TextField(label, text: $text, prompt: Text("0.00").foregroundStyle(Palette.textSecondary))
                    .font(Typography.priceLarge)
                    .foregroundStyle(Palette.textPrimary)
                    .keyboardType(.decimalPad)
                    .focused($isFocused)
                    .accessibilityLabel(label)
                    .accessibilityValue(spokenValue)
                    .onChange(of: text) { _, raw in
                        let input = PriceInput(raw)
                        if input.text != raw {
                            text = input.text
                        }
                        minorUnits = input.minorUnits
                    }
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.sm)
            .frame(maxWidth: .infinity, minHeight: Layout.buttonHeight, alignment: .leading)
            .background(Palette.surfaceSecondary, in: shape)
            .overlay(shape.strokeBorder(Palette.brand, lineWidth: isFocused ? 2 : 0))
            .contentShape(shape)
            .onTapGesture { isFocused = true }
            if let hint {
                Text(hint)
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
            }
        }
    }

    private var currencySymbol: String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        return formatter.currencySymbol
    }

    private var spokenValue: String {
        guard let amount = PriceInput(text).amount else { return "Empty" }
        return amount.formatted(.currency(code: currencyCode))
    }

    static func text(forMinorUnits minorUnits: Int) -> String {
        let whole = minorUnits / 100
        let cents = minorUnits % 100
        return cents == 0 ? "\(whole)" : String(format: "%d.%02d", whole, cents)
    }
}

#Preview {
    @Previewable @State var price: Int? = 4800
    VStack(spacing: Spacing.lg) {
        PriceField("Price", minorUnits: $price, hint: "Similar items sold for $40-$55.")
        Text(price.map { "\($0) cents" } ?? "No price")
    }
    .padding()
    .background(Palette.surface)
}
