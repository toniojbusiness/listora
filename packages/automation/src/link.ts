/**
 * Linking a marketplace for browser automation (decision D1): the seller logs into the
 * marketplace in the iPhone app, which hands Listora the session cookies (never the password).
 * In one transaction, the session vault stores them on the account's automation connection, the
 * account's listings on that marketplace without a connection join it (so their next steps are
 * automated), the runner is asked to check the session (session-checks/), and a first sale
 * check is due at once. Relinking after a check takes the same way. The API's
 * `linkMarketplaceSession` endpoint calls this (docs/features/marketplace-linking.md).
 */
import { inTransaction, type DbExecutor } from '@listora/db';
import type { SessionCookie, SessionVault } from '@listora/connections';

import type { AutomatedMarketplace, AutomationProfile } from './profiles.ts';
import { enqueueSaleCheck, scheduleSaleCheck } from './sale-checks/schedule.ts';
import { requestSessionCheck } from './session-checks/schedule.ts';

export interface LinkAutomationInput {
  accountId: string;
  marketplace: AutomatedMarketplace;
  cookies: readonly SessionCookie[];
  displayName?: string | null;
}

export async function linkAutomationSession(
  executor: DbExecutor,
  deps: { vault: SessionVault; profile: AutomationProfile },
  input: LinkAutomationInput,
): Promise<{ connectionId: string; checkId: string }> {
  return inTransaction(executor, async (trx) => {
    const { connectionId } = await deps.vault.linkSession(trx, {
      accountId: input.accountId,
      marketplace: input.marketplace,
      cookies: input.cookies,
      cookieDomains: deps.profile.cookieDomains,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    });
    await trx
      .updateTable('marketplace_listing')
      .set({ connection_id: connectionId })
      .where('account_id', '=', input.accountId)
      .where('marketplace', '=', input.marketplace)
      .where('connection_id', 'is', null)
      .execute();
    const check = { accountId: input.accountId, connectionId, marketplace: input.marketplace };
    // Added first, so the runner checks the session before it looks for sales.
    const { checkId } = await requestSessionCheck(trx, check);
    await scheduleSaleCheck(trx, { ...check, at: 'now', reason: 'linked' });
    await enqueueSaleCheck(trx, check);
    return { connectionId, checkId };
  });
}
