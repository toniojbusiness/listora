import DesignSystem
import SwiftUI

/// The verdict as a big rubber stamp in its ink: green Grab, amber Maybe, red Leave.
struct ScanVerdictStamp: View {
    let text: String
    let tone: StatusTone

    var body: some View {
        let ink = tone == .neutral ? Palette.textPrimary : tone.color
        Text(text)
            .font(Typography.title)
            .textCase(.uppercase)
            .tracking(1.6)
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(ink)
            .padding(.horizontal, Spacing.xs)
            .padding(.vertical, 2)
            .overlay {
                RoundedRectangle(cornerRadius: Radius.tight, style: .continuous)
                    .strokeBorder(ink, lineWidth: 2)
            }
            .rotationEffect(.degrees(-3))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(text)
    }
}

/// One reality check line, with a small mark of its kind; a source not checked is muted.
struct ScanRealityRow: View {
    let line: ScanCard.RealityLine

    private var symbol: String {
        switch line.kind {
        case "own_sales": "person.crop.circle.badge.checkmark"
        case "market_sold": "checkmark.seal"
        case "asking", "web": "tag"
        case "retail": "bag"
        case "brand_pulse": "waveform.path.ecg"
        case "missing": "questionmark.circle"
        default: "circle"
        }
    }

    var body: some View {
        Label {
            Text(line.text).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: symbol).imageScale(.small)
        }
        .font(Typography.caption)
        .foregroundStyle(line.kind == "missing" ? Palette.textSecondary : Palette.textPrimary)
        .accessibilityIdentifier("scan.reality.\(line.kind)")
    }
}

/// The card's three prices side by side, like ChatGPT's answer at the bins: what to list at
/// (room for offers), what it likely sells for, and what it goes for fast. The likely sale
/// leads; all three are estimates, so none of them says "sold".
struct ScanThreePrices: View {
    let prices: ScanCard.Prices

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.md) {
            column("List at", prices.listAt, emphasized: false)
            column("Likely sale", prices.realistic, emphasized: true)
            column("Fast sale", prices.fast, emphasized: false)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "List at \(prices.listAt), likely sale \(prices.realistic), fast sale \(prices.fast). \(prices.basedOn)",
        )
        .accessibilityIdentifier("scan.prices")
    }

    private func column(_ label: String, _ price: String, emphasized: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(price)
                .font(Typography.price)
                .foregroundStyle(emphasized ? Palette.textPrimary : Palette.textSecondary)
            Text(label)
                .font(Typography.caption)
                .foregroundStyle(Palette.textSecondary)
        }
    }
}

/// What a card says above its answers: as it is while it fits, and once there is more than the
/// room the camera leaves it (a long reality check, a large text size, a small iPhone), scrolling
/// inside the card from its top, the verdict and the prices first, with its scroll bar flashed so
/// the seller sees there is more. The answers below it stay put.
struct ScanCardScroll<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        ViewThatFits(in: .vertical) {
            details
            ScrollView {
                details.padding(.bottom, Spacing.sm)
            }
            // The line cut by the card's edge fades out instead of ending mid-word.
            .mask {
                VStack(spacing: 0) {
                    Color.black
                    LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                        .frame(height: Spacing.sm)
                }
            }
            .scrollIndicators(.visible)
            .scrollIndicatorsFlash(onAppear: true)
            .scrollBounceBehavior(.basedOnSize)
            .accessibilityIdentifier("scan.content")
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
