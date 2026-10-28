/**
 * Test mode (docs/features/test-mode.md): the deployment owner's account may turn on every
 * marketplace feature that is built but has not passed live, to live-test it, while customers
 * only ever get the verified ones. The account's flag (`account.test_mode`) is the one source
 * every gate reads; only the API turns it on, and only for the owner. A read-only connection
 * stays read-only in Test mode: its gates are separate (docs/features/read-only.md).
 *
 * Each run of a feature on only because of Test mode is kept in `feature_test_run`, the owner's
 * log, so a passed live run can be cited when the feature is marked verified (which still takes
 * a reviewed change to `VERIFIED_FEATURES`).
 */
import type { DbExecutor, Marketplace } from '@listora/db';

import {
  isFeatureInTesting,
  SELLER_FEATURES,
  type FeatureGate,
  type MarketplaceFeature,
} from './features.ts';

/** The account's gate: whether it is in Test mode. */
export async function loadFeatureGate(db: DbExecutor, accountId: string): Promise<FeatureGate> {
  const row = await db
    .selectFrom('account')
    .select('test_mode')
    .where('id', '=', accountId)
    .executeTakeFirst();
  return row?.test_mode === true ? { testMode: true } : SELLER_FEATURES;
}

/** The accounts in Test mode, for the schedulers that look across every account. */
export async function testModeAccountIds(db: DbExecutor): Promise<string[]> {
  const rows = await db.selectFrom('account').select('id').where('test_mode', '=', true).execute();
  return rows.map((row) => row.id);
}

/** One run's result, for the owner's log. */
export interface FeatureTestRun {
  readonly accountId: string;
  readonly marketplace: Marketplace;
  readonly feature: MarketplaceFeature;
  readonly outcome: 'passed' | 'failed';
  /** What ran: the operation, the offer answer, or the connection whose read it was. */
  readonly subjectId: string;
  /** A failure's code and its sanitized words (never page text or anything typed). */
  readonly errorCode?: string | null;
  readonly detail?: string | null;
}

/**
 * Records the run in the owner's log when the feature ran only because the account is in Test
 * mode; a verified feature, or an account not in Test mode, records nothing. Returns whether it
 * recorded the run.
 */
export async function recordFeatureTestRun(db: DbExecutor, run: FeatureTestRun): Promise<boolean> {
  const gate = await loadFeatureGate(db, run.accountId);
  if (!isFeatureInTesting(run.marketplace, run.feature, gate)) return false;
  const failed = run.outcome === 'failed';
  await db
    .insertInto('feature_test_run')
    .values({
      account_id: run.accountId,
      marketplace: run.marketplace,
      feature: run.feature,
      outcome: run.outcome,
      subject_id: run.subjectId,
      error_code: failed ? (clip(run.errorCode, 100) ?? 'error') : null,
      detail: clip(run.detail, 500),
    })
    .execute();
  return true;
}

function clip(text: string | null | undefined, max: number): string | null {
  const line = text?.replace(/\s+/g, ' ').trim() ?? '';
  return line === '' ? null : line.slice(0, max);
}
