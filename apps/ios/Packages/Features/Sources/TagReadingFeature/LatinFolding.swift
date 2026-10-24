/// Undoes a Vision quirk: even when recognition is limited to Latin-script languages, it returns
/// some Latin capitals as their Cyrillic or Greek look-alikes ("AСMЕ" with a Cyrillic С and Е).
/// The server's parsers match ASCII, so a Cyrillic "СA 54321" would never be read as a CA number.
enum LatinFolding {
    /// Replaces Cyrillic and Greek look-alikes with the Latin letters they show. A line that also
    /// holds a Cyrillic or Greek letter without a Latin twin is real non-Latin text and is
    /// returned unchanged.
    static func fold(_ text: String) -> String {
        var folded = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            if let latin = lookAlikes[scalar] {
                folded.append(latin)
            } else if isCyrillicOrGreek(scalar) {
                return text
            } else {
                folded.append(scalar)
            }
        }
        return String(folded)
    }

    private static func isCyrillicOrGreek(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x0370 ... 0x03FF, 0x0400 ... 0x052F, 0x1F00 ... 0x1FFF:
            true
        default:
            false
        }
    }

    /// Cyrillic and Greek letters that render the same as a Latin letter in the fonts on tags.
    private static let lookAlikes: [Unicode.Scalar: Unicode.Scalar] = {
        let pairs: [(String, String)] = [
            // Cyrillic capitals and small letters.
            ("АВЕКМНОРСТУХІЈЅ", "ABEKMHOPCTYXIJS"),
            ("аеорсухіјѕһ", "aeopcyxijsh"),
            // Greek capitals and small omicron.
            ("ΑΒΕΖΗΙΚΜΝΟΡΤΥΧο", "ABEZHIKMNOPTYXo"),
        ]
        var table: [Unicode.Scalar: Unicode.Scalar] = [:]
        for (lookAlike, latin) in pairs {
            for (from, letter) in zip(lookAlike.unicodeScalars, latin.unicodeScalars) {
                table[from] = letter
            }
        }
        return table
    }()
}
