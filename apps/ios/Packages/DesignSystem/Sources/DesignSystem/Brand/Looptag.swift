import CoreGraphics
import SwiftUI

/// The Looptag mark: a price tag whose string writes a cursive l. Its geometry is the one in
/// `apps/ios/Brand/looptag-mark.svg`, the source of the app icon too (`BrandTests` checks that the
/// two agree), in the same 100 x 100 box: the string is a stroked line, and the tag hangs off its
/// end, with the string's hole punched through.
///
/// The app icon, the wordmark's l (`Wordmark`), and the loading indicator (`BrandSpinner`) all draw
/// from here.
enum Looptag {
    /// The string's center line: an entry flick, the tall loop, the descender, and the exit curve
    /// into the tag's hole.
    static let stringData = "M10 66 C20 60 32 48 41 34 C50 20 54 5 44 4 C33 3 27 18 27 36 "
        + "C27 54 27 68 34 76 C42 83 51 80 57 73"
    /// The tag, pointed end at the origin (where the string ties on), body to the right.
    static let tagData = "M0 0 L11 -13 H38 Q42 -13 42 -9 V9 Q42 13 38 13 H11 Z"
    /// The width of the string in the mark (the wordmark draws it thinner, at the font's stem).
    static let stringWidth: CGFloat = 9.5
    /// The tag is filled and also stroked this wide with round joins, which rounds its corners.
    static let tagOutlineWidth: CGFloat = 5
    /// Where the tag's origin sits in the box, and its rotation (degrees, clockwise) in the mark.
    static let tagOrigin = CGPoint(x: 55, y: 68)
    static let tagAngle: CGFloat = 50
    /// The hole, in the tag's own coordinates.
    static let holeCenter = CGPoint(x: 9.5, y: 0)
    static let holeRadius: CGFloat = 4.3

    /// The string's center line, in the 100 x 100 box.
    static let string: Path = SVGPath.parse(stringData)
    /// The mark's tag, as `tag()` draws it; made once, since the spinner draws it every frame.
    static let markTag: Path = tag()

    /// The string, stroked, from `start` to `end` of its length (0 to 1), in the box.
    static func stroke(width: CGFloat = stringWidth, from start: CGFloat = 0, to end: CGFloat = 1) -> Path {
        string.trimmedPath(from: start, to: end)
            .strokedPath(StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
    }

    /// The tag's filled outline with the hole cut out, turned `angle` degrees and scaled by `scale`
    /// about its origin, in the box.
    static func tag(angle: CGFloat = tagAngle, scale: CGFloat = 1) -> Path {
        let body = SVGPath.parse(tagData)
        let outline = body.strokedPath(StrokeStyle(lineWidth: tagOutlineWidth, lineJoin: .round))
        let hole = Path(ellipseIn: CGRect(
            x: holeCenter.x - holeRadius,
            y: holeCenter.y - holeRadius,
            width: holeRadius * 2,
            height: holeRadius * 2,
        ))
        let transform = CGAffineTransform(translationX: tagOrigin.x, y: tagOrigin.y)
            .rotated(by: angle * .pi / 180)
            .scaledBy(x: scale, y: scale)
        return body.union(outline).subtracting(hole).applying(transform)
    }
}

/// Reads the absolute path commands the brand SVGs use (M, L, H, V, C, Q, Z) into a `Path`.
enum SVGPath {
    static func parse(_ data: String) -> Path {
        var path = Path()
        var tokens = tokenize(data)[...]
        var command: Character = "M"
        var current = CGPoint.zero
        func number() -> CGFloat {
            guard case let .number(value) = tokens.popFirst() else {
                preconditionFailure("SVG path data ends early: \(data)")
            }
            return value
        }
        func point() -> CGPoint {
            CGPoint(x: number(), y: number())
        }
        while let token = tokens.first {
            if case let .command(letter) = token {
                command = letter
                tokens.removeFirst()
                if letter == "Z" {
                    path.closeSubpath()
                    continue
                }
            }
            switch command {
            case "M":
                current = point()
                path.move(to: current)
                command = "L" // Further pairs after an M are lines.
            case "L":
                current = point()
                path.addLine(to: current)
            case "H":
                current = CGPoint(x: number(), y: current.y)
                path.addLine(to: current)
            case "V":
                current = CGPoint(x: current.x, y: number())
                path.addLine(to: current)
            case "C":
                let control1 = point(), control2 = point()
                current = point()
                path.addCurve(to: current, control1: control1, control2: control2)
            case "Q":
                let control = point()
                current = point()
                path.addQuadCurve(to: current, control: control)
            default:
                preconditionFailure("Unsupported SVG path command \(command) in \(data)")
            }
        }
        return path
    }

    enum Token: Equatable {
        case command(Character)
        case number(CGFloat)
    }

    static func tokenize(_ data: String) -> [Token] {
        var tokens: [Token] = []
        var digits = ""
        func flush() {
            if let value = Double(digits) {
                tokens.append(.number(CGFloat(value)))
            }
            digits = ""
        }
        for character in data {
            if character.isLetter {
                flush()
                tokens.append(.command(character))
            } else if character == "-" {
                flush()
                digits = "-"
            } else if character.isNumber || character == "." {
                digits.append(character)
            } else {
                flush()
            }
        }
        flush()
        return tokens
    }
}
