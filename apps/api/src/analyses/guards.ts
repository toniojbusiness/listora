import { ANALYSIS_PURPOSE, ANALYSIS_QUOTA, analysisFailure } from '@listora/analysis';
import { AiGuardError, type AiClient, type AiTier } from '@listora/ai';
import { assertNever } from '@listora/shared';

import { ApiError } from '../errors.ts';
import type { Tenant } from '../tenancy.ts';

/**
 * Refuses an analysis request up front when its call would be refused anyway, so nothing is
 * queued that cannot run: the kill switch (`503`), an operator's block on the account (`403`),
 * the account's daily AI budget (`429`, with the seconds until it resets), or the plan quota of
 * the tier (`402`).
 */
export async function assertAnalysisAllowed(
  ai: AiClient,
  tenant: Tenant,
  tier: AiTier,
  now: Date,
): Promise<void> {
  try {
    await ai.checkGuards({
      accountId: tenant.accountId,
      tier,
      purpose: ANALYSIS_PURPOSE,
      quota: ANALYSIS_QUOTA[tier],
    });
  } catch (error) {
    if (!(error instanceof AiGuardError)) throw error;
    const { message } = analysisFailure(error);
    const { reason } = error;
    switch (reason.kind) {
      case 'kill_switch':
        throw new ApiError('service_unavailable', message, { cause: error });
      case 'account_blocked':
        throw new ApiError('forbidden', message, { cause: error });
      case 'daily_budget':
        throw new ApiError('ai_budget_exceeded', message, {
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((reason.resetsAt.getTime() - now.getTime()) / 1_000),
          ),
          cause: error,
        });
      case 'quota':
        throw new ApiError('quota_exceeded', message, { cause: error });
      default:
        return assertNever(reason);
    }
  }
}
