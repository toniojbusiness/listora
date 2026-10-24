/**
 * Tenancy guard. Every `/v1` request runs as one account, and every repository function takes
 * that `Tenant` and filters on its account id. A `Tenant` can only come from `resolveTenant`,
 * after the bearer token was verified, because `AccountId` is a branded type that no other
 * module can create. A route therefore cannot reach the database without an account, and cannot
 * pass a raw id from a request in place of one: cross-tenant access fails closed by construction.
 * The database backs this up with composite `(account_id, id)` foreign keys.
 */
import { isIdentityDeleted, lockIdentity } from '@listora/accounts';
import type { Db, MembershipRole } from '@listora/db';
import type { FastifyRequest } from 'fastify';

import type { AuthDriver, Identity } from './auth/driver.ts';
import { ApiError } from './errors.ts';

declare const accountIdBrand: unique symbol;
/** An account id that was resolved from a verified identity. Never cast a string to it. */
export type AccountId = string & { readonly [accountIdBrand]: true };

/** The account and user a request acts for. */
export interface Tenant {
  readonly accountId: AccountId;
  readonly userId: string;
  readonly role: MembershipRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authentication hook of every secured contract route; null elsewhere. */
    tenant: Tenant | null;
    /** The verified identity behind `tenant`; set and null exactly when it is. */
    identity: Identity | null;
  }
}

/** A verified bearer token and the tenant it acts as. */
export interface Authenticated {
  identity: Identity;
  tenant: Tenant;
}

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]+)$/;

/** Authenticates the request's bearer token and resolves the account it acts for. */
export async function authenticate(
  request: FastifyRequest,
  auth: AuthDriver,
  db: Db,
): Promise<Authenticated> {
  const match = BEARER.exec(request.headers.authorization ?? '');
  const identity = match?.[1] === undefined ? undefined : await auth.verifyAccessToken(match[1]);
  if (!identity) {
    throw new ApiError('unauthenticated', 'Sign in to continue.');
  }
  return { identity, tenant: await resolveTenant(db, identity) };
}

/**
 * The tenant of a verified identity. On a person's first request this creates their user,
 * their account (named after the email, SKU prefix from its initials), and the owner
 * membership, in one transaction. Fails closed with `401 unauthenticated` when the person
 * deleted their account after the token was issued, or the deletion still waits for the
 * identity provider (so the token cannot provision a new account), and with `403 forbidden` when the user has no account, or more than one (choosing an account is
 * not supported yet).
 */
export async function resolveTenant(db: Db, identity: Identity): Promise<Tenant> {
  let found = await findMemberships(db, identity);
  if (found === undefined) {
    await provisionUser(db, identity);
    found = await findMemberships(db, identity);
    if (found === undefined) throw new Error('provisioned user is missing');
  }
  if (found.length !== 1) {
    throw new ApiError(
      'forbidden',
      found.length === 0
        ? 'This sign-in is not a member of any Listora account.'
        : 'This sign-in belongs to several accounts, which is not supported yet.',
    );
  }
  const [membership] = found;
  if (!membership) throw new Error('unreachable: one membership expected');
  return membership;
}

/** Undefined when the user does not exist yet; otherwise their memberships (possibly none). */
async function findMemberships(db: Db, identity: Identity): Promise<Tenant[] | undefined> {
  const rows = await db
    .selectFrom('app_user')
    .leftJoin('membership', 'membership.user_id', 'app_user.id')
    .select(['app_user.id as userId', 'membership.account_id', 'membership.role'])
    .where('app_user.auth_provider', '=', identity.provider)
    .where('app_user.auth_subject', '=', identity.subject)
    .execute();
  if (rows.length === 0) return undefined;
  return rows.flatMap((row) =>
    row.account_id === null || row.role === null
      ? []
      : [{ accountId: row.account_id as AccountId, userId: row.userId, role: row.role }],
  );
}

async function provisionUser(db: Db, identity: Identity): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // The lock account deletion takes: a deletion that committed before this point is seen
    // here, and one that starts later waits for this transaction.
    await lockIdentity(trx, identity);
    if (await isIdentityDeleted(trx, identity)) {
      throw new ApiError('unauthenticated', 'Sign in to continue.');
    }
    // Two first requests can race: the loser's insert waits for the winner and then does
    // nothing, and both go on to read the winner's membership.
    const user = await trx
      .insertInto('app_user')
      .values({
        auth_provider: identity.provider,
        auth_subject: identity.subject,
        email: identity.email ?? null,
      })
      .onConflict((conflict) => conflict.columns(['auth_provider', 'auth_subject']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!user) return;
    const account = await trx
      .insertInto('account')
      .values({
        name: (identity.email ?? 'My account').slice(0, 200),
        sku_prefix: skuPrefixFor(identity.email),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('membership')
      .values({ account_id: account.id, user_id: user.id, role: 'owner' })
      .execute();
  });
}

/** Fallback SKU prefix when an email gives no usable initials. */
export const DEFAULT_SKU_PREFIX = 'LS';

/**
 * Default SKU prefix (decision D12: the owner's initials): `antonio.jenkins@...` → `AJ`,
 * `maria@...` → `MA`.
 */
export function skuPrefixFor(email: string | undefined): string {
  const words = (email?.split('@')[0] ?? '').split(/[^A-Za-z]+/).filter((word) => word !== '');
  const [first = '', second] = words;
  const prefix = (
    second === undefined ? first.slice(0, 2) : `${first[0] ?? ''}${second[0] ?? ''}`
  ).toUpperCase();
  return /^[A-Z]{2,4}$/.test(prefix) ? prefix : DEFAULT_SKU_PREFIX;
}
