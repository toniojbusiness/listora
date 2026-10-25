/**
 * A marketplace's notice that a seller's authorization of Listora was revoked (eBay
 * `AUTHORIZATION_REVOCATION`; the notifications task, T-17, verifies and delivers it). It flips
 * every connection of that seller to `revoked` at once and deletes their tokens, so nothing
 * keeps using a dead grant and the app asks the seller to reconnect. A notice dated before a
 * connection's current grant is about an older grant and changes nothing; repeated deliveries
 * change nothing either.
 */
import type { DbExecutor, Marketplace } from '@listora/db';
import {
  MARKETPLACE_NAMES,
  type EbayAuthorizationRevocation,
  type EbayRevokeReason,
} from '@listora/marketplaces';
import { assertNever } from '@listora/shared';

export interface AuthorizationRevocation {
  marketplace: Marketplace;
  /** The marketplace's immutable id of the seller. */
  externalUserId: string;
  revokedAt: Date;
  /** Stable machine-readable reason, for `last_error_code`. */
  code: string;
  /** User-readable, names the marketplace and what to do. */
  message: string;
}

/**
 * Marks the seller's connections revoked; returns the ids of the connections it changed (one per
 * Listora account that had connected that seller).
 */
export async function recordAuthorizationRevocation(
  db: DbExecutor,
  revocation: AuthorizationRevocation,
  now: Date = new Date(),
): Promise<string[]> {
  const rows = await db
    .updateTable('marketplace_connection')
    .set({
      status: 'revoked',
      token_ciphertext: null,
      last_error: revocation.message,
      last_error_code: revocation.code,
      last_error_at: now,
    })
    .where('marketplace', '=', revocation.marketplace)
    .where('external_user_id', '=', revocation.externalUserId)
    .where('mode', '=', 'api')
    .where('status', '<>', 'revoked')
    .where((eb) =>
      eb.or([eb('granted_at', 'is', null), eb('granted_at', '<=', revocation.revokedAt)]),
    )
    .returning('id')
    .execute();
  return rows.map((row) => row.id);
}

/** An eBay `AUTHORIZATION_REVOCATION` notification as a revocation. */
export function ebayRevocation(notice: EbayAuthorizationRevocation): AuthorizationRevocation {
  return {
    marketplace: 'ebay',
    externalUserId: notice.externalUserId,
    revokedAt: notice.revokedAt,
    code: REASON_CODES[notice.reason],
    message: revocationMessage(notice.reason),
  };
}

const REASON_CODES = {
  REVOKED_BY_APP: 'revoked_by_listora',
  REVOKED_BY_USER: 'revoked_by_seller',
  REVOKED_BY_EBAY: 'revoked_by_marketplace',
  PASSWORD_CHANGE: 'credentials_changed',
} as const satisfies Record<EbayRevokeReason, string>;

function revocationMessage(reason: EbayRevokeReason): string {
  const name = MARKETPLACE_NAMES.ebay;
  switch (reason) {
    case 'REVOKED_BY_APP':
      return `Listora's access to your ${name} account was removed. Reconnect ${name} to keep your listings in sync.`;
    case 'REVOKED_BY_USER':
      return `You removed Listora's access in your ${name} account settings. Reconnect ${name} to keep your listings in sync.`;
    case 'REVOKED_BY_EBAY':
      return `${name} ended Listora's access to your account. Reconnect ${name} to keep your listings in sync.`;
    case 'PASSWORD_CHANGE':
      return `${name} ended Listora's access because your ${name} password or user name changed. Reconnect ${name}.`;
    default:
      return assertNever(reason, 'eBay revoke reason');
  }
}
