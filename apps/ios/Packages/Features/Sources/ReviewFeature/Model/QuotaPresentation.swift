import ListoraAPI

/// What "Identify harder" says about the plan's premium identifications.
enum QuotaPresentation {
    /// "Uses 1 premium identification. 2 of 10 used this month." from the server's usage; nil
    /// usage (it could not be read) says only what the action uses.
    static func premiumLine(_ usage: Usage?) -> String {
        let cost = "Uses 1 premium identification."
        guard let quota = premiumQuota(usage) else { return cost }
        if let limit = quota.limit, quota.used >= limit {
            return "All \(limit) premium identifications in your plan are used this month."
        }
        if let limit = quota.limit {
            let left = max(0, Int(limit) - Int(quota.used))
            return "\(cost) \(quota.used) of \(limit) used this month, \(left) left."
        }
        return "\(cost) \(quota.used) used this month."
    }

    /// True when the plan's premium identifications are used up: "Identify harder" is unavailable.
    static func isUsedUp(_ usage: Usage?) -> Bool {
        guard let quota = premiumQuota(usage), let limit = quota.limit else { return false }
        return quota.used >= limit
    }

    private static func premiumQuota(_ usage: Usage?) -> Components.Schemas.QuotaUsage? {
        usage?.quotas.first { $0.metric.value1 == .premiumIdentifications }
    }
}
