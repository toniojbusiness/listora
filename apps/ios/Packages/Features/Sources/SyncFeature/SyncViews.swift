import DesignSystem
import SwiftUI

/// The sync indicator, over the bottom of every tab: one line per marketplace at work ("Checking
/// Depop sales...", with the spinner), what its reads found ("Depop: 52 sales found") for a few
/// seconds, and a failure in the seller's words with Try again. Nothing shows while nothing runs.
public struct SyncIndicator: View {
    private let model: SyncModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(model: SyncModel) {
        self.model = model
    }

    public var body: some View {
        let lines = model.lines
        VStack(spacing: Spacing.xs) {
            ForEach(lines) { line in
                SyncLineView(line: line, retry: retry) { model.dismiss(line) }
                    .transition(.rise)
            }
        }
        .padding(.horizontal, Spacing.md)
        .padding(.bottom, Spacing.sm)
        .frame(maxWidth: Layout.readableWidth)
        .animation(Motion.animation(Motion.standard, reduceMotion: reduceMotion), value: lines)
        .onChange(of: lines.filter { $0.kind != .working }) { _, ended in
            // VoiceOver hears what a sync found as it shows.
            for line in ended {
                UIAccessibility.post(notification: .announcement, argument: line.text)
            }
        }
    }

    private func retry() {
        Task { await model.syncNow() }
    }
}

private struct SyncLineView: View {
    let line: SyncModel.Line
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: Spacing.sm) {
            switch line.kind {
            case .working:
                BrandSpinner(color: StatusTone.inProgress.color)
                    .controlSize(.small)
                    .accessibilityHidden(true)
            case .found:
                Image(systemName: "arrow.triangle.2.circlepath")
                    .foregroundStyle(StatusTone.checking.color)
                    .accessibilityHidden(true)
            case .failed:
                Image(systemName: StatusTone.failed.systemImage)
                    .foregroundStyle(StatusTone.failed.color)
                    .accessibilityHidden(true)
            }
            Text(line.text)
                .font(Typography.emphasis)
                .foregroundStyle(Palette.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("sync.line.\(line.id)")
            if line.kind == .failed {
                Button("Try again", action: retry)
                    .buttonStyle(.listora(.secondary, size: .compact))
                    .fixedSize()
                    .accessibilityIdentifier("sync.retry.\(line.id)")
                Button("Dismiss", systemImage: "xmark", action: dismiss)
                    .labelStyle(.iconOnly)
                    .font(Typography.emphasis)
                    .foregroundStyle(Palette.textSecondary)
                    .frame(width: Layout.minimumTapTarget, height: Layout.minimumTapTarget)
                    .contentShape(Rectangle())
                    .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.xs)
        .frame(minHeight: Layout.minimumTapTarget)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.large, style: .continuous)
                .strokeBorder(Palette.separator, lineWidth: 1),
        )
        .elevation(.high)
    }
}

/// Sync now, for a screen's toolbar: asks Listora to sync every linked marketplace, and spins
/// while a sync runs.
public struct SyncNowButton: View {
    private let model: SyncModel

    public init(model: SyncModel) {
        self.model = model
    }

    public var body: some View {
        Button {
            Haptics.play(.tap)
            Task { await model.syncNow() }
        } label: {
            if model.isSyncing {
                BrandSpinner()
                    .controlSize(.small)
                    .accessibilityLabel("Syncing")
            } else {
                Label("Sync now", systemImage: "arrow.triangle.2.circlepath")
            }
        }
        .disabled(model.requesting)
        .accessibilityIdentifier("sync.now")
    }
}

#Preview {
    let model = SyncModel(service: PreviewSyncService(), isSignedIn: { true })
    VStack {
        Spacer()
        SyncIndicator(model: model)
    }
    .background(Palette.background)
    .task { await model.syncNow() }
}

private struct PreviewSyncService: SyncService {
    func status() async -> [MarketplaceSyncStatus] {
        []
    }

    func requestSync(idempotencyKey _: String) async -> [MarketplaceSyncStatus] {
        [
            MarketplaceSyncStatus(marketplace: "depop", state: .synced, statusText: "52 sales found"),
            MarketplaceSyncStatus(
                marketplace: "poshmark", state: .failed, statusText: "Couldn't check sales. Sync again to try again.",
            ),
        ]
    }
}
