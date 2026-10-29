import SwiftUI

/// A list's one sort control: a pill beside the list's filters that names the order in effect
/// and opens a menu of the orders, the current one checked. The list sorts on the server; this
/// only picks the order.
public struct SortMenu<Value: Hashable>: View {
    @Binding private var selection: Value
    private let options: [Value]
    private let title: (Value) -> String

    /// `title` names an order in the menu and on the pill ("Price: high to low").
    public init(selection: Binding<Value>, options: [Value], title: @escaping (Value) -> String) {
        _selection = selection
        self.options = options
        self.title = title
    }

    public var body: some View {
        Menu {
            Picker("Sort by", selection: $selection) {
                ForEach(options, id: \.self) { option in
                    Text(title(option)).tag(option)
                }
            }
        } label: {
            HStack(spacing: Spacing.xxs) {
                Image(systemName: "arrow.up.arrow.down").imageScale(.small)
                Text(title(selection)).lineLimit(1)
            }
            .choicePill(isSelected: false)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Sort by")
        .accessibilityValue(title(selection))
        .sensoryFeedback(.selection, trigger: selection)
    }
}

#Preview {
    @Previewable @State var order = "Recently added"
    SortMenu(selection: $order, options: ["Recently added", "Price: high to low"]) { $0 }
        .padding()
        .background(Palette.background)
}
