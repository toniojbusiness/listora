/**
 * Where a connection's automated steps run (docs/features/phone-execution.md): Listora's cloud
 * browser runner, or the seller's own iPhone. The marketplaces that refuse the cloud runner
 * (Depop blocks its address, Mercari shows it a bot check, Poshmark serves its pages without
 * their data) run on the phone by default (each profile's `runsOn`); eBay stays in the cloud.
 * Each connection keeps its own location, and its waiting work moves with it. A marketplace
 * whose profile does not allow the cloud (`cloudAllowed`) can't move there until configured
 * back (`cloudAccess`).
 */
import { sql } from 'kysely';

import type { CloudAccess } from '@listora/connections';
import {
  inTransaction,
  type DbExecutor,
  type ExecutionLocation,
  type Marketplace,
} from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import { releasePhoneOperations } from '@listora/operations';

import {
  isAutomatedMarketplace,
  type AutomatedMarketplace,
  type AutomationProfile,
} from './profiles.ts';

import { enqueueSaleCheck } from './sale-checks/schedule.ts';
import { addSessionCheckJob, queueSessionCheckForPhone } from './session-checks/schedule.ts';

/**
 * Whether the marketplace's automated steps may run in Listora's cloud, by its profile, and the
 * line the app shows when they may not. A marketplace without automation has nothing to move.
 */
export function cloudAccess(
  profiles: Readonly<Record<AutomatedMarketplace, AutomationProfile>>,
  marketplace: Marketplace,
): CloudAccess {
  if (!isAutomatedMarketplace(marketplace) || profiles[marketplace].cloudAllowed) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `${MARKETPLACE_NAMES[marketplace]} blocks cloud servers, so Listora runs it from your phone`,
  };
}

/**
 * Moves the connection's automated steps to `location`. Work waiting for the phone that the
 * phone is not running goes to the browser runner when the connection moves to the cloud; a
 * run the phone is in the middle of finishes there. Work queued for the runner moves to the
 * phone as the runner (or the worker) next picks it up. Returns false for no such connection.
 */
export async function setExecutionLocation(
  executor: DbExecutor,
  target: { accountId: string; connectionId: string },
  location: ExecutionLocation,
): Promise<boolean> {
  return inTransaction(executor, async (trx) => {
    const connection = await trx
      .updateTable('marketplace_connection')
      .set({ runs_on: location })
      .where('account_id', '=', target.accountId)
      .where('id', '=', target.connectionId)
      .returning(['marketplace'])
      .executeTakeFirst();
    if (connection === undefined) return false;
    const check = { ...target, marketplace: connection.marketplace };
    const waiting = await trx
      .selectFrom('phone_work')
      .select(['purpose', 'check_id'])
      .where('account_id', '=', target.accountId)
      .where('connection_id', '=', target.connectionId)
      .where('purpose', 'in', ['session_check', 'sale_check'])
      .where((eb) =>
        eb.or([eb('lease_expires_at', 'is', null), eb('lease_expires_at', '<=', sql<Date>`now()`)]),
      )
      .execute();
    if (location === 'cloud') {
      await releasePhoneOperations(trx, target);
      for (const work of waiting) {
        await trx
          .deleteFrom('phone_work')
          .where('account_id', '=', target.accountId)
          .where('connection_id', '=', target.connectionId)
          .where('purpose', '=', work.purpose)
          .execute();
        if (work.purpose === 'session_check' && work.check_id !== null) {
          await addSessionCheckJob(trx, { ...check, checkId: work.check_id }, null);
        } else if (work.purpose === 'sale_check') {
          await enqueueSaleCheck(trx, check);
        }
      }
      return true;
    }
    // A pending check of the session moves to the phone at once; the rest as it comes due.
    const pending = await trx
      .selectFrom('session_check')
      .select('check_id')
      .where('account_id', '=', target.accountId)
      .where('connection_id', '=', target.connectionId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (pending !== undefined) {
      await sql`select graphile_worker.remove_job(${`session-check:${target.connectionId}`})`.execute(
        trx,
      );
      await queueSessionCheckForPhone(trx, { ...check, checkId: pending.check_id });
    }
    return true;
  });
}
