// Renders the Looptag app icon from its SVG sources in Brand/ into
// Brand/AppIcon.xcassets/AppIcon.appiconset. Run it on a Mac with `make ios-app-icon`, then commit
// the PNGs. The SVGs are the source; the PNGs are never edited by hand.
//
// rsvg-convert (Homebrew librsvg) rasterizes each SVG at 1024 x 1024. The default icon is then
// redrawn without an alpha channel, since App Store Connect rejects an icon that has one; the dark
// and tinted icons keep their transparent background, behind which iOS draws its own.
//
// It is a one-file developer tool, not app code: a failed step stops it with a crash.
// swiftlint:disable force_unwrapping

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The only size the iOS 18 SDK needs: Xcode derives every other size from it.
let side = 1024
let arguments = CommandLine.arguments
let brandDirectory = URL(fileURLWithPath: arguments.count > 1 ? arguments[1] : "apps/ios/Brand")
let outputDirectory = brandDirectory.appendingPathComponent("AppIcon.xcassets/AppIcon.appiconset")
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

enum Variant: String, CaseIterable {
    /// Opaque, as App Store Connect requires.
    case light = "AppIcon"
    /// Transparent background: iOS draws its own dark backdrop behind the glyph.
    case dark = "AppIcon-Dark"
    /// Grayscale on transparent: iOS applies the user's tint.
    case tinted = "AppIcon-Tinted"

    var source: String {
        switch self {
        case .light: "app-icon-light.svg"
        case .dark: "app-icon-dark.svg"
        case .tinted: "app-icon-tinted.svg"
        }
    }
}

func rasterize(_ svg: URL, to png: URL) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["rsvg-convert", "-w", "\(side)", "-h", "\(side)", svg.path, "-o", png.path]
    try process.run()
    process.waitUntilExit()
    precondition(process.terminationStatus == 0, "rsvg-convert failed on \(svg.path)")
}

func load(_ url: URL) -> CGImage {
    let source = CGImageSourceCreateWithURL(url as CFURL, nil)!
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
    precondition(image.width == side && image.height == side, "\(url.path) is not \(side) x \(side)")
    return image
}

/// The image drawn into a context of its own, opaque (no alpha channel) or with alpha.
func redraw(_ image: CGImage, opaque: Bool) -> CGImage {
    let context = CGContext(
        data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
        bitmapInfo: (opaque ? CGImageAlphaInfo.noneSkipLast : .premultipliedLast).rawValue,
    )!
    context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
    return context.makeImage()!
}

func write(_ image: CGImage, to url: URL) {
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    precondition(CGImageDestinationFinalize(destination), "Could not write \(url.path)")
    print("wrote \(url.path)")
}

let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("listora-app-icon-\(getpid())")
try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: scratch) }
for variant in Variant.allCases {
    let raster = scratch.appendingPathComponent("\(variant.rawValue).png")
    try rasterize(brandDirectory.appendingPathComponent(variant.source), to: raster)
    let image = redraw(load(raster), opaque: variant == .light)
    write(image, to: outputDirectory.appendingPathComponent("\(variant.rawValue).png"))
}

// swiftlint:enable force_unwrapping
