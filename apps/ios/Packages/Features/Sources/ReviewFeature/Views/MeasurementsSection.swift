import Core
import DesignSystem
import SwiftUI

/// The review's measurements: only those that fit the item's category, each typed on the in-app
/// keypad (or spoken: "pit to pit 21"). They go into the Depop description too.
struct MeasurementsSection: View {
    let rows: [MeasurementRow]
    let onSet: (MeasurementKind, Double?) -> Void
    @State private var entering: MeasurementRow?

    var body: some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SectionHeader(
                    "Measurements",
                    subtitle: "Laid flat, in inches. Say \"pit to pit 21\" or tap one. Depop's description lists them.",
                )
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        if index > 0 {
                            Divider().overlay(Palette.separator.color).padding(.leading, Spacing.md)
                        }
                        Button {
                            entering = row
                        } label: {
                            MeasurementRowView(row: row)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("review.measurement.\(row.kind.rawValue)")
                    }
                }
                .cardStyle(.flat, padding: 0)
            }
            .sheet(item: $entering) { row in
                MeasurementEntryView(row: row) { onSet(row.kind, $0) }
                    .presentationDetents([.large])
            }
        }
    }
}

/// One measurement: its name, and its value or the action to add it.
private struct MeasurementRowView: View {
    let row: MeasurementRow

    var body: some View {
        HStack(spacing: Spacing.sm) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(row.kind.title)
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                if let measurement = row.measurement {
                    Text(measurement.valueText)
                        .font(Typography.body.monospacedDigit())
                        .foregroundStyle(Palette.textPrimary)
                } else {
                    Label("Add \(row.kind.title.lowercased())", systemImage: "plus")
                        .font(Typography.body)
                        .foregroundStyle(Palette.brand)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right")
                .font(Typography.smallEmphasis)
                .foregroundStyle(Palette.textSecondary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.sm)
        .frame(minHeight: Layout.minimumTapTarget)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(row.measurement?.valueText ?? "None")
    }
}

/// A measurement on the keypad, with where to measure. Save and Remove sit at the bottom, within
/// thumb reach.
struct MeasurementEntryView: View {
    let row: MeasurementRow
    let onDone: (Double?) -> Void
    @State private var entry: MeasurementEntry
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(row: MeasurementRow, onDone: @escaping (Double?) -> Void) {
        self.row = row
        self.onDone = onDone
        _entry = State(initialValue: row.measurement.map { MeasurementEntry(value: $0.value) } ?? MeasurementEntry())
    }

    private var unitText: String {
        row.measurement?.unit == .centimeters ? "cm" : "in"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Spacing.lg) {
                    VStack(spacing: Spacing.xs) {
                        HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                            Text(entry.isEmpty ? "0" : entry.text)
                                .font(Typography.amountEntry)
                                .foregroundStyle(entry.isEmpty ? Palette.textSecondary : Palette.textPrimary)
                                .contentTransition(reduceMotion ? .identity : .numericText())
                                .animation(Motion.animation(Motion.snappy, reduceMotion: reduceMotion), value: entry)
                            Text(unitText)
                                .font(Typography.title3)
                                .foregroundStyle(Palette.textSecondary)
                        }
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                        .frame(maxWidth: .infinity, minHeight: Layout.buttonHeight)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(row.kind.title)
                        .accessibilityValue(entry.isEmpty ? "None" : "\(entry.text) \(unitText)")
                        .accessibilityIdentifier("measurement.amount")
                        Text(row.kind.hint)
                            .font(Typography.subheadline)
                            .foregroundStyle(Palette.textSecondary)
                            .multilineTextAlignment(.center)
                    }
                    KeypadView { entry.press($0) }
                }
                .padding(Spacing.md)
                .frame(maxWidth: Layout.readableWidth)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .scrollBounceBehavior(.basedOnSize)
            .background(Palette.background)
            .navigationTitle(row.kind.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                if row.measurement != nil {
                    ToolbarItem(placement: .destructiveAction) {
                        Button("Remove", role: .destructive) {
                            onDone(nil)
                            dismiss()
                        }
                        .accessibilityIdentifier("measurement.remove")
                    }
                }
            }
            .bottomActionBar {
                Button {
                    onDone(entry.value)
                    dismiss()
                } label: {
                    Text("Save \(row.kind.title.lowercased())")
                }
                .buttonStyle(.listoraPrimary)
                .disabled(entry.value == nil)
                .accessibilityIdentifier("measurement.save")
            }
        }
    }
}
