// Renders the placeholder app icon into Listora/Assets.xcassets/AppIcon.appiconset. Run it on a
// Mac with `make ios-app-icon`, then commit the PNGs.
//
// The mark is a price tag on the brand teal (Palette.brand). It is drawn here with Core
// Graphics, so the icon has one source and no downloaded or third-party asset. To ship a real
// design, replace the three PNGs instead and delete this tool (see "App icon" in README.md).
//
// It is a one-file developer tool, not app code: a failed Core Graphics call stops it with a
// crash.
// swiftlint:disable force_unwrapping

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The only size the iOS 18 SDK needs: Xcode derives every other size from it.
let side = 1024
let outputDirectory = URL(fileURLWithPath: CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "apps/ios/Listora/Assets.xcassets/AppIcon.appiconset")

let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

func color(_ hex: UInt32, alpha: CGFloat = 1) -> CGColor {
    CGColor(
        colorSpace: colorSpace,
        components: [
            CGFloat((hex >> 16) & 0xFF) / 255,
            CGFloat((hex >> 8) & 0xFF) / 255,
            CGFloat(hex & 0xFF) / 255,
            alpha,
        ],
    )!
}

/// A tag pointing left, centered on the origin, with its string hole cut out (even-odd fill).
func tagPath() -> CGPath {
    let path = CGMutablePath()
    let right: CGFloat = 290, shoulder: CGFloat = -110, tip: CGFloat = -300, half: CGFloat = 170
    let corner: CGFloat = 56
    path.move(to: CGPoint(x: 0, y: half))
    path.addArc(tangent1End: CGPoint(x: right, y: half), tangent2End: CGPoint(x: right, y: 0), radius: corner)
    path.addArc(tangent1End: CGPoint(x: right, y: -half), tangent2End: CGPoint(x: 0, y: -half), radius: corner)
    path.addArc(tangent1End: CGPoint(x: shoulder, y: -half), tangent2End: CGPoint(x: tip, y: 0), radius: corner)
    path.addArc(tangent1End: CGPoint(x: tip, y: 0), tangent2End: CGPoint(x: shoulder, y: half), radius: corner / 2)
    path.addArc(tangent1End: CGPoint(x: shoulder, y: half), tangent2End: CGPoint(x: 0, y: half), radius: corner)
    path.closeSubpath()
    path.addEllipse(in: CGRect(x: -175, y: -44, width: 88, height: 88))
    return path
}

enum Variant: String, CaseIterable {
    /// Opaque, as App Store Connect requires.
    case light = "AppIcon"
    /// Transparent background: iOS draws its own dark backdrop behind the glyph.
    case dark = "AppIcon-Dark"
    /// Grayscale on transparent: iOS applies the user's tint.
    case tinted = "AppIcon-Tinted"
}

func render(_ variant: Variant) -> CGImage {
    let context = CGContext(
        data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
        bitmapInfo: (variant == .light ? CGImageAlphaInfo.noneSkipLast : .premultipliedLast).rawValue,
    )!
    let size = CGFloat(side)
    let glyph: [CGColor]
    switch variant {
    case .light:
        // Brand teal, lighter at the top left (Palette.brand light is 0x0F766E).
        let colors = [color(0x14B8A6), color(0x0F766E)] as CFArray
        let gradient = CGGradient(colorsSpace: colorSpace, colors: colors, locations: [0, 1])!
        context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: size), end: CGPoint(x: size, y: 0), options: [])
        glyph = [color(0xFFFFFF), color(0xE6FFFB)]
    case .dark:
        glyph = [color(0x5EEAD4), color(0x2DD4BF)] // Palette.brand dark is 0x2DD4BF.
    case .tinted:
        glyph = [color(0xFFFFFF), color(0xBDBDBD)]
    }

    context.translateBy(x: size / 2, y: size / 2)
    context.rotate(by: -.pi / 4) // The tip points to the top left.
    context.scaleBy(x: 1.1, y: 1.1)
    context.translateBy(x: -40, y: 0) // Centers the tag's visual weight, not its bounding box.
    context.addPath(tagPath())
    context.clip(using: .evenOdd)
    let fill = CGGradient(colorsSpace: colorSpace, colors: glyph as CFArray, locations: [0, 1])!
    context.drawLinearGradient(fill, start: CGPoint(x: 0, y: 200), end: CGPoint(x: 0, y: -200), options: [])
    return context.makeImage()!
}

func write(_ image: CGImage, named name: String) {
    let url = outputDirectory.appendingPathComponent("\(name).png")
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    precondition(CGImageDestinationFinalize(destination), "Could not write \(url.path)")
    print("wrote \(url.path)")
}

try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
for variant in Variant.allCases {
    write(render(variant), named: variant.rawValue)
}

// swiftlint:enable force_unwrapping
