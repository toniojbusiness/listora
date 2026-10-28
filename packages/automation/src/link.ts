/**
 * Linking a marketplace for browser automation (decision D1): the seller logs into the
 * marketplace in the iPhone app, which hands Listora the session cookies (never the password).
 * In one transaction, the session vault stores them on the account's automation connection, the
 * account's listings on that marketplace that were never on a shop join it (so their next steps
 * are automated), the runner is asked to check the session (session-checks/), and a first sale
 * check is due at once. Relinking after a check takes the same way. The API's
 * `linkMarketplaceSession` endpoint calls this (docs/features/marketplace-linking.md).
 */
import { inTransaction, type DbExecutor, type ExecutionLocation } from '@listora/db';
import type { SessionCookie, SessionVault } from '@listora/connections';

import type { AutomatedMarketplace, AutomationProfile } from './profiles.ts';
import { enqueueSaleCheck, scheduleSaleCheck } from './sale-checks/schedule.ts';
import { requestSessionCheck } from './session-checks/schedule.ts';

export interface LinkAutomationInput {
  accountId: string;
  marketplace: AutomatedMarketplace;
  cookies: readonly SessionCookie[];
  displayName?: string | null;
  /**
   * The device that linked it (`app_device.id`): the phone that runs the connection's
   * automated steps when they run on the phone (docs/features/phone-execution.md).
   */
  deviceId?: string | null;
  /** Where a new connection's automated steps run; the profile's `runsOn` when absent. */
  runsOn?: ExecutionLocation;
}

export async function linkAutomationSession(
  executor: DbExecutor,
  deps: { vault: SessionVault; profile: AutomationProfile },
  input: LinkAutomationInput,
): Promise<{ connectionId: string; checkId: string }> {
  return inTransaction(executor, async (trx) => {
    const existing = await trx
      .selectFrom('marketplace_connection')
      .select('id')
      .where('account_id', '=', input.accountId)
      .where('marketplace', '=', input.marketplace)
      .executeTakeFirst();
    const { connectionId } = await deps.vault.linkSession(trx, {
      accountId: input.accountId,
      marketplace: input.marketplace,
      cookies: input.cookies,
      cookieDomains: deps.profile.cookieDomains,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    });
    // A new connection runs where its marketplace runs by default; a relink keeps where the
    // connection runs, and the phone that linked it becomes the one that runs it.
    const placement = {
      ...(existing === undefined ? { runs_on: input.runsOn ?? deps.profile.runsOn } : {}),
      ...(input.deviceId === undefined || input.deviceId === null
        ? {}
        : { phone_device_id: input.deviceId }),
    };
    if (Object.keys(placement).length > 0) {
      await trx
        .updateTable('marketplace_connection')
        .set(placement)
        .where('account_id', '=', input.accountId)
        .where('id', '=', connectionId)
        .execute();
    }
    await trx
      .updateTable('marketplace_listing')
      .set({ connection_id: connectionId })
      .where('account_id', '=', input.accountId)
      .where('marketplace', '=', input.marketplace)
      .where('connection_id', 'is', null)
      // A listing from an unlinked shop stays out: this may be another shop
      // (docs/features/marketplace-linking.md#relinking-another-shop).
      .where('shop_unlinked_at', 'is', null)
      .execute();
    const check = { accountId: input.accountId, connectionId, marketplace: input.marketplace };
    // Added first, so the runner checks the session before it looks for sales.
    const { checkId } = await requestSessionCheck(trx, check);
    await scheduleSaleCheck(trx, { ...check, at: 'now', reason: 'linked' });
    await enqueueSaleCheck(trx, check);
    return { connectionId, checkId };
  });
}
