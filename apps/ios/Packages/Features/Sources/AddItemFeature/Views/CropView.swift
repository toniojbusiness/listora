import DesignSystem
import SwiftUI

/// Crops a photo: drag the corners to resize the frame and the middle to move it. "Square"
/// keeps a 1:1 frame, the shape most marketplaces show in search results.
struct CropView: View {
    let url: URL
    /// The photo's width divided by its height.
    let aspectRatio: CGFloat
    /// Called with the frame in normalized coordinates (origin top left), or nil when cancelled.
    let onFinish: @MainActor (CGRect?) async -> Void

    @State private var crop = CGRect(x: 0, y: 0, width: 1, height: 1)
    @State private var dragStart: CGRect?
    @State private var isSquare = false

    private static let minimumSide: CGFloat = 0.1
    private static let handleSize: CGFloat = 34

    var body: some View {
        NavigationStack {
            VStack(spacing: Spacing.md) {
                GeometryReader { geometry in
                    let frame = imageFrame(in: geometry.size)
                    ZStack(alignment: .topLeading) {
                        PhotoThumbnail(url: url, pointSize: max(frame.width, frame.height), contentMode: .fit)
                            .frame(width: frame.width, height: frame.height)
                            .offset(x: frame.minX, y: frame.minY)
                        cropOverlay(in: frame)
                    }
                }
                FlowLayout(centered: true) {
                    ChoiceChip("Original", systemImage: "rectangle", isSelected: !isSquare) { isSquare = false }
                        .accessibilityIdentifier("crop.original")
                    ChoiceChip("Square", systemImage: "square", isSelected: isSquare) { isSquare = true }
                        .accessibilityIdentifier("crop.square")
                }
                .onChange(of: isSquare) { _, square in
                    if square {
                        Motion.perform(Motion.snappy) {
                            crop = Self.squared(crop, aspectRatio: aspectRatio)
                        }
                    }
                }
                Text("Drag the corners to resize, or the middle to move.")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
            }
            .padding(.vertical, Spacing.md)
            .background(Palette.mediaBackground)
            .navigationTitle("Crop")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Palette.mediaBackground.color, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { Task { await onFinish(nil) } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { Task { await onFinish(crop) } }
                        .disabled(crop == CGRect(x: 0, y: 0, width: 1, height: 1))
                        .accessibilityIdentifier("crop.done")
                }
            }
        }
        // Photos are edited on black in both modes, like the system's photo editor.
        .environment(\.colorScheme, .dark)
        .sensoryFeedback(.selection, trigger: isSquare)
    }

    /// Where the photo sits when fitted into `size`, with room for the handles.
    private func imageFrame(in size: CGSize) -> CGRect {
        let available = CGSize(width: size.width - 2 * Spacing.lg, height: size.height - 2 * Spacing.lg)
        let fitted = available.width / max(available.height, 1) > aspectRatio
            ? CGSize(width: available.height * aspectRatio, height: available.height)
            : CGSize(width: available.width, height: available.width / aspectRatio)
        return CGRect(
            x: (size.width - fitted.width) / 2,
            y: (size.height - fitted.height) / 2,
            width: fitted.width,
            height: fitted.height,
        )
    }

    private func cropOverlay(in frame: CGRect) -> some View {
        let rect = CGRect(
            x: frame.minX + crop.minX * frame.width,
            y: frame.minY + crop.minY * frame.height,
            width: crop.width * frame.width,
            height: crop.height * frame.height,
        )
        return ZStack(alignment: .topLeading) {
            // Dims what the crop removes.
            Path { path in
                path.addRect(frame)
                path.addRect(rect)
            }
            .fill(Palette.scrim.color.opacity(0.55), style: FillStyle(eoFill: true))
            .allowsHitTesting(false)
            Rectangle()
                .strokeBorder(Palette.onMedia, lineWidth: 1.5)
                .background(thirdsGrid.opacity(dragStart == nil ? 0 : 0.6))
                .contentShape(Rectangle())
                .frame(width: rect.width, height: rect.height)
                .offset(x: rect.minX, y: rect.minY)
                .gesture(moveGesture(in: frame))
                .accessibilityHidden(true)
            ForEach(Corner.allCases, id: \.self) { corner in
                CornerHandle(corner: corner)
                    .frame(width: Layout.minimumTapTarget, height: Layout.minimumTapTarget)
                    .contentShape(Rectangle())
                    .offset(
                        x: corner.point(in: rect).x - Layout.minimumTapTarget / 2,
                        y: corner.point(in: rect).y - Layout.minimumTapTarget / 2,
                    )
                    .gesture(resizeGesture(corner, in: frame))
                    .accessibilityHidden(true)
            }
        }
    }

    /// Rule-of-thirds lines, shown while the frame is being dragged.
    private var thirdsGrid: some View {
        GeometryReader { geometry in
            Path { path in
                for step in 1 ... 2 {
                    let x = geometry.size.width * CGFloat(step) / 3
                    let y = geometry.size.height * CGFloat(step) / 3
                    path.move(to: CGPoint(x: x, y: 0))
                    path.addLine(to: CGPoint(x: x, y: geometry.size.height))
                    path.move(to: CGPoint(x: 0, y: y))
                    path.addLine(to: CGPoint(x: geometry.size.width, y: y))
                }
            }
            .stroke(Palette.onMedia, lineWidth: 0.5)
        }
        .allowsHitTesting(false)
    }

    private func moveGesture(in frame: CGRect) -> some Gesture {
        DragGesture()
            .onChanged { value in
                let start = dragStart ?? crop
                dragStart = start
                var moved = start.offsetBy(
                    dx: value.translation.width / frame.width,
                    dy: value.translation.height / frame.height,
                )
                moved.origin.x = min(max(moved.minX, 0), 1 - moved.width)
                moved.origin.y = min(max(moved.minY, 0), 1 - moved.height)
                crop = moved
            }
            .onEnded { _ in dragStart = nil }
    }

    private func resizeGesture(_ corner: Corner, in frame: CGRect) -> some Gesture {
        DragGesture()
            .onChanged { value in
                let start = dragStart ?? crop
                dragStart = start
                let translation = CGSize(
                    width: value.translation.width / frame.width,
                    height: value.translation.height / frame.height,
                )
                crop = Self.resized(start, corner: corner, by: translation, square: isSquare, aspectRatio: aspectRatio)
            }
            .onEnded { _ in dragStart = nil }
    }

    /// An L-shaped corner handle, centered on the frame's corner.
    private struct CornerHandle: View {
        let corner: Corner

        var body: some View {
            let length = CropView.handleSize
            Path { path in
                let center = CGPoint(x: Layout.minimumTapTarget / 2, y: Layout.minimumTapTarget / 2)
                let dx: CGFloat = corner == .topLeft || corner == .bottomLeft ? 1 : -1
                let dy: CGFloat = corner == .topLeft || corner == .topRight ? 1 : -1
                path.move(to: CGPoint(x: center.x, y: center.y + dy * length / 2))
                path.addLine(to: center)
                path.addLine(to: CGPoint(x: center.x + dx * length / 2, y: center.y))
            }
            .stroke(Palette.onMedia, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
            .shadow(color: Palette.scrim.color.opacity(0.5), radius: 2)
        }
    }

    enum Corner: CaseIterable {
        case topLeft, topRight, bottomLeft, bottomRight

        func point(in rect: CGRect) -> CGPoint {
            switch self {
            case .topLeft: CGPoint(x: rect.minX, y: rect.minY)
            case .topRight: CGPoint(x: rect.maxX, y: rect.minY)
            case .bottomLeft: CGPoint(x: rect.minX, y: rect.maxY)
            case .bottomRight: CGPoint(x: rect.maxX, y: rect.maxY)
            }
        }
    }

    /// `start` with `corner` moved by `translation` (normalized), kept inside the photo and at least
    /// ``minimumSide``; with `square`, the frame stays 1:1 in pixels.
    static func resized(
        _ start: CGRect,
        corner: Corner,
        by translation: CGSize,
        square: Bool,
        aspectRatio: CGFloat,
    ) -> CGRect {
        var left = start.minX, top = start.minY, right = start.maxX, bottom = start.maxY
        let dx = translation.width, dy = translation.height
        switch corner {
        case .topLeft: left += dx; top += dy
        case .topRight: right += dx; top += dy
        case .bottomLeft: left += dx; bottom += dy
        case .bottomRight: right += dx; bottom += dy
        }
        left = min(max(left, 0), start.maxX - minimumSide)
        right = max(min(right, 1), start.minX + minimumSide)
        top = min(max(top, 0), start.maxY - minimumSide)
        bottom = max(min(bottom, 1), start.minY + minimumSide)
        let rect = CGRect(x: left, y: top, width: right - left, height: bottom - top)
        return square ? squared(rect, aspectRatio: aspectRatio, anchoredAt: corner) : rect
    }

    /// The largest 1:1 (in pixels) frame inside `rect`, anchored at the corner opposite to the one
    /// being dragged, or centered.
    static func squared(_ rect: CGRect, aspectRatio: CGFloat, anchoredAt corner: Corner? = nil) -> CGRect {
        // A normalized width w covers w * aspectRatio units of height.
        let side = min(rect.width * aspectRatio, rect.height)
        let width = side / aspectRatio
        let height = side
        switch corner {
        case .topLeft: return CGRect(x: rect.maxX - width, y: rect.maxY - height, width: width, height: height)
        case .topRight: return CGRect(x: rect.minX, y: rect.maxY - height, width: width, height: height)
        case .bottomLeft: return CGRect(x: rect.maxX - width, y: rect.minY, width: width, height: height)
        case .bottomRight: return CGRect(x: rect.minX, y: rect.minY, width: width, height: height)
        case nil: return CGRect(x: rect.midX - width / 2, y: rect.midY - height / 2, width: width, height: height)
        }
    }
}
