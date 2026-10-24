/// The guided shot list: front, back, tag, then any flaws and details. Each shot gets its step's
/// role, so a seller who follows the guide never sets a role by hand.
struct CaptureGuide: Equatable {
    enum Step: CaseIterable, Equatable {
        case front
        case back
        case tag
        case details

        var title: String {
            switch self {
            case .front: "Front"
            case .back: "Back"
            case .tag: "Tag"
            case .details: "Flaws & details"
            }
        }

        var instruction: String {
            switch self {
            case .front: "Lay the item flat or hang it, and fill the frame."
            case .back: "Turn it over and shoot the back the same way."
            case .tag: "Get close to the brand and care tags so the text is sharp."
            case .details: "Shoot flaws up close, then details like buttons or prints. Tap Done when finished."
            }
        }
    }

    struct Shot: Equatable {
        let photo: PreparedPhoto
        let role: PhotoRole
    }

    private(set) var step: Step = .front
    private(set) var shots: [Shot] = []
    /// What a shot in the details step shows; the seller switches between flaw and detail.
    var detailRole: PhotoRole = .flaw

    var role: PhotoRole {
        switch step {
        case .front: .front
        case .back: .back
        case .tag: .tag
        case .details: detailRole
        }
    }

    var canTakeMore: Bool {
        shots.count < DraftStore.maxPhotosPerDraft
    }

    func count(of step: Step) -> Int {
        shots.count { shot in
            switch step {
            case .front: shot.role == .front
            case .back: shot.role == .back
            case .tag: shot.role == .tag
            case .details: shot.role == .flaw || shot.role == .detail
            }
        }
    }

    /// Keeps a shot with the current role. Front, back, and tag move on to the next step after one
    /// shot; flaws and details take as many as the seller wants.
    mutating func accept(_ photo: PreparedPhoto) {
        guard canTakeMore else { return }
        shots.append(Shot(photo: photo, role: role))
        if step != .details {
            advance()
        }
    }

    mutating func skip() {
        advance()
    }

    mutating func go(to step: Step) {
        self.step = step
    }

    mutating func removeLastShot() {
        guard !shots.isEmpty else { return }
        shots.removeLast()
    }

    private mutating func advance() {
        let steps = Step.allCases
        if let index = steps.firstIndex(of: step), index + 1 < steps.count {
            step = steps[index + 1]
        }
    }
}
