import ListoraAPI

/// What "Identify harder" says about the plan's premium identifications.
enum QuotaPresentation {
    /// "Uses 1 premium identification. 2 of 10 used this month." from the server's usage; nil
    /// usage (it could not be read) says only what the action uses.
    static func premiumLine(_ usage: Usage?) -> String {
        let cost = "Uses 1 premium identification."
        guard let quota = usage?.quotas.first(where: {
            $0.metric.value1 == .premiumIdentifications
        }) else { return cost }
        if let limit = quota.limit {
            let left = max(0, Int(limit) - Int(quota.used))
            return "\(cost) \(quota.used) of \(limit) used this month, \(left) left."
        }
        return "\(cost) \(quota.used) used this month."
    }

    /// True when the plan's premium identifications are used up.
    static func isUsedUp(_ usage: Usage?) -> Bool {
        guard let quota = usage?.quotas.first(where: { $0.metric.value1 == .premiumIdentifications }),
              let limit = quota.limit else { return false }
        return quota.used >= limit
    }
}
