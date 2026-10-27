/**
 * The pre-fill's stored state (docs/features/marketplace-prefill.md): the seller's answers and
 * the AI's picks. Every function takes the `Tenant` and filters on its account.
 */
import type { DbExecutor } from '@listora/db';

import type { Tenant } from '../tenancy.ts';

/** The item's answers given for these details (`basis`), by key. */
export async function loadAnswers(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
  basis: string,
): Promise<Map<string, string>> {
  const rows = await db
    .selectFrom('item_prefill_answer')
    .select(['key', 'value'])
    .where('account_id', '=', tenant.accountId)
    .where('item_id', '=', itemId)
    .where('basis', '=', basis)
    .execute();
  return new Map(rows.map((row) => [row.key, row.value]));
}

/** Records the seller's answer, or clears it (`value` null). */
export async function saveAnswer(
  db: DbExecutor,
  tenant: Tenant,
  answer: { itemId: string; key: string; value: string | null; basis: string },
): Promise<void> {
  if (answer.value === null) {
    await db
      .deleteFrom('item_prefill_answer')
      .where('account_id', '=', tenant.accountId)
      .where('item_id', '=', answer.itemId)
      .where('key', '=', answer.key)
      .execute();
    return;
  }
  await db
    .insertInto('item_prefill_answer')
    .values({
      account_id: tenant.accountId,
      item_id: answer.itemId,
      key: answer.key,
      value: answer.value,
      basis: answer.basis,
    })
    .onConflict((conflict) =>
      conflict
        .columns(['account_id', 'item_id', 'key'])
        .doUpdateSet({ value: answer.value ?? '', basis: answer.basis }),
    )
    .execute();
}

export interface StoredPick {
  decisionHash: string;
  key: string;
  value: string | null;
  confidence: number;
}

/** The AI's picks among these questions (`decisionHashes`) the item already has. */
export async function loadPicks(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
  decisionHashes: readonly string[],
): Promise<StoredPick[]> {
  if (decisionHashes.length === 0) return [];
  const rows = await db
    .selectFrom('item_prefill_pick')
    .select(['decision_hash', 'key', 'value', 'confidence'])
    .where('account_id', '=', tenant.accountId)
    .where('item_id', '=', itemId)
    .where('decision_hash', 'in', decisionHashes)
    .execute();
  return rows.map((row) => ({
    decisionHash: row.decision_hash,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
  }));
}

/** Keeps the AI's picks; a concurrent request that stored the same question first wins. */
export async function savePicks(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
  picks: readonly StoredPick[],
): Promise<void> {
  if (picks.length === 0) return;
  await db
    .insertInto('item_prefill_pick')
    .values(
      picks.map((pick) => ({
        account_id: tenant.accountId,
        item_id: itemId,
        decision_hash: pick.decisionHash,
        key: pick.key,
        value: pick.value,
        confidence: pick.confidence,
      })),
    )
    .onConflict((conflict) =>
      conflict.columns(['account_id', 'item_id', 'decision_hash']).doNothing(),
    )
    .execute();
}
