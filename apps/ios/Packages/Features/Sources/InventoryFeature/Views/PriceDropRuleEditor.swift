import DesignSystem
import ListoraAPI
import SwiftUI

/// A price drop rule's terms (docs/features/price-drops.md): how much each drop takes off, after
/// how many days unsold, and the lowest price, starting from the seller's own days to sell. An
/// existing rule also has its switch and Delete. Saving changes no price: the first drop shows
/// under Coming up a day before it runs.
struct PriceDropRuleEditor: View {
    @State private var model: PriceDropRuleEditorModel
    @State private var confirmsDelete = false
    @Environment(\.dismiss) private var dismiss

    init(model: PriceDropRuleEditorModel) {
        _model = State(initialValue: model)
    }

    var body: some View {
        Form {
            if case .newBrand = model.target {
                Section {
                    TextField("Brand, as on the tag", text: $model.brand)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await model.loadDefaults() } }
                        .accessibilityIdentifier("priceDropRule.brand")
                } header: {
                    SectionHeader("Brand", subtitle: "Every item of this brand without a rule of its own.")
                }
            }
            Section {
                Stepper(value: $model.percent, in: PriceDropRuleEditorModel.percentRange) {
                    LabeledContent("Each drop", value: "\(model.percent)% off")
                }
                .accessibilityIdentifier("priceDropRule.percent")
                Stepper(value: $model.afterDays, in: PriceDropRuleEditorModel.daysRange) {
                    LabeledContent("After", value: "\(PriceDropWords.days(model.afterDays)) unsold")
                }
                .accessibilityIdentifier("priceDropRule.days")
                PriceField("Never below", minorUnits: floor, hint: "The lowest price a drop sets.")
                    .accessibilityIdentifier("priceDropRule.floor")
            } header: {
                SectionHeader("The rule")
            } footer: {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Text(model.summary)
                    if let defaults = model.defaults {
                        Text(PriceDropWords.basis(defaults))
                    }
                    Text("A listing's days start again after each drop, so it drops again later, down to the "
                        + "lowest price. Prices land on whole dollars.")
                }
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
            }
            if !model.isNew {
                Section {
                    Toggle("Price drops on", isOn: $model.enabled)
                        .tint(Palette.brand.color)
                        .accessibilityIdentifier("priceDropRule.enabled")
                    Button("Delete rule", role: .destructive) { confirmsDelete = true }
                        .accessibilityIdentifier("priceDropRule.delete")
                }
            }
            if let missing = model.missing {
                Text(missing)
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .listRowBackground(Color.clear)
            }
            if let error = model.saveError {
                Banner("Couldn't save", message: error, tone: .failed)
                    .listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Palette.background)
        .navigationTitle(model.isNew ? "New price drop" : "Price drop")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    Task {
                        if await model.save() {
                            dismiss()
                        }
                    }
                }
                .disabled(model.missing != nil || model.isSaving)
                .accessibilityIdentifier("priceDropRule.save")
            }
        }
        .confirmationDialog("Delete this rule?", isPresented: $confirmsDelete, titleVisibility: .visible) {
            Button("Delete rule", role: .destructive) {
                Task {
                    if await model.delete() {
                        dismiss()
                    }
                }
            }
        } message: {
            Text("Its planned drops stop. A drop already sent still finishes.")
        }
        .task { await model.loadDefaults() }
    }

    /// The lowest price as the field's optional minor units.
    private var floor: Binding<Int?> {
        Binding(
            get: { model.floorCents > 0 ? Int(model.floorCents) : nil },
            set: { model.floorCents = Int64($0 ?? 0) },
        )
    }
}
