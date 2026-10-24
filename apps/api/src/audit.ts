import { jsonb, type DbExecutor, type JsonObject } from '@listora/db';

import type { Tenant } from './tenancy.ts';

export interface AuditEntry {
  /** Omit for an entry that must outlive the item (its deletion). */
  itemId?: string;
  /** Dotted lowercase verb, for example `item.updated` or `photo.added`. */
  action: string;
  changes: JsonObject;
}

/** Appends a user-visible history entry for a change the signed-in user made. */
export async function writeAudit(db: DbExecutor, tenant: Tenant, entry: AuditEntry): Promise<void> {
  await db
    .insertInto('audit_log')
    .values({
      account_id: tenant.accountId,
      item_id: entry.itemId ?? null,
      actor_kind: 'user',
      actor_user_id: tenant.userId,
      action: entry.action,
      changes: jsonb(entry.changes),
    })
    .execute();
}
