import type { AiTier } from './types.ts';

/**
 * The global kill switch. When engaged, no AI call is sent for any account. It is asked on
 * every call, so an implementation backed by live configuration takes effect immediately.
 */
export interface KillSwitch {
  isEngaged(): Promise<boolean>;
}

/** A kill switch fixed for the life of the process (from `AI_KILL_SWITCH`). */
export function staticKillSwitch(engaged: boolean): KillSwitch {
  return { isEngaged: () => Promise.resolve(engaged) };
}

/** Engaged when any of `switches` is: the deploy-time `AI_KILL_SWITCH` or the operator's. */
export function anyKillSwitch(...switches: readonly KillSwitch[]): KillSwitch {
  return {
    isEngaged: async () => {
      for (const killSwitch of switches) if (await killSwitch.isEngaged()) return true;
      return false;
    },
  };
}

/**
 * Accounts an operator has blocked from AI. Asked on every call, like the kill switch, so a
 * block takes effect on the account's next call.
 */
export interface AccountBlocks {
  isBlocked(accountId: string): Promise<boolean>;
}

/** No account is blocked; the default when no control store is wired in. */
export const NO_ACCOUNT_BLOCKS: AccountBlocks = { isBlocked: () => Promise.resolve(false) };

/** The operator-managed controls (`PostgresAiControls` in production). */
export interface AiControls extends KillSwitch, AccountBlocks {}

/**
 * Plan quotas are counted in reseller units (`usage_counter.metric`), not dollars: one item
 * analyzed, one premium identification. The caller says which unit a call uses.
 */
export const QUOTA_METRICS = ['ai_items', 'premium_identifications'] as const;
export type QuotaMetric = (typeof QUOTA_METRICS)[number];

export interface QuotaCharge {
  readonly metric: QuotaMetric;
  readonly units: number;
}

export interface QuotaContext {
  readonly accountId: string;
  readonly tier: AiTier;
  readonly purpose: string;
  readonly charge: QuotaCharge;
}

export type QuotaDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly used: number; readonly limit: number };

/**
 * The hook plan entitlements plug into. `check` runs before the call; `consume` runs only
 * after the call succeeded, so a failed call never uses up a reseller unit (its dollar cost
 * still counts toward the daily budget).
 */
export interface QuotaPolicy {
  check(context: QuotaContext): Promise<QuotaDecision>;
  consume(context: QuotaContext): Promise<void>;
}

/** No plan limits; the default until billing entitlements land. */
export const UNLIMITED_QUOTA: QuotaPolicy = {
  check: () => Promise.resolve({ allowed: true }),
  consume: () => Promise.resolve(),
};
