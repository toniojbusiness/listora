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
import { sql } from 'kysely';

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

/**
 * Who gets an account on their first sign-in (`SIGN_UP`, docs/features/invites.md): anyone the
 * auth driver verified (`open`, local development), or only a person whose email redeemed an
 * invite, and the owner (`invite`, the personal environment). The owner is the deploy's
 * `ownerEmail`, so they can sign up again after deleting their account.
 */
export type SignUpPolicy =
  { readonly mode: 'open' } | { readonly mode: 'invite'; readonly ownerEmail: string | undefined };

/** Why a sign-in without an account gets none under the `invite` policy. */
export const NOT_INVITED_MESSAGE =
  'Listora is invite-only for now. Ask the person who invited you for an invite code, then ' +
  'sign up with it.';
/** Why an invited person whose invite was revoked is refused. */
export const ACCESS_REVOKED_MESSAGE =
  'Your access to Listora was turned off by the person who invited you.';

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
  signUp: SignUpPolicy,
): Promise<Authenticated> {
  const match = BEARER.exec(request.headers.authorization ?? '');
  const identity = match?.[1] === undefined ? undefined : await auth.verifyAccessToken(match[1]);
  if (!identity) {
    throw new ApiError('unauthenticated', 'Sign in to continue.');
  }
  return { identity, tenant: await resolveTenant(db, identity, signUp) };
}

/**
 * The tenant of a verified identity. On a person's first request this creates their user,
 * their account (named after the email, SKU prefix from its initials), and the owner
 * membership, in one transaction; an invite their email redeemed is linked to the new account
 * in the same transaction. Fails closed with `401 unauthenticated` when the person
 * deleted their account after the token was issued, or the deletion still waits for the
 * identity provider (so the token cannot provision a new account), and with `403 forbidden`
 * when the sign-up policy gives them no account, when their invite was revoked, or when the user
 * has no account, or more than one (choosing an account is not supported yet).
 */
export async function resolveTenant(
  db: Db,
  identity: Identity,
  signUp: SignUpPolicy,
): Promise<Tenant> {
  let found = await findMemberships(db, identity);
  if (found === undefined) {
    await provisionUser(db, identity, signUp);
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
  if (membership.revoked) throw new ApiError('forbidden', ACCESS_REVOKED_MESSAGE);
  return { accountId: membership.accountId, userId: membership.userId, role: membership.role };
}

/** A membership, and whether the invite its account was created from is revoked. */
interface FoundMembership extends Tenant {
  readonly revoked: boolean;
}

/** Undefined when the user does not exist yet; otherwise their memberships (possibly none). */
async function findMemberships(db: Db, identity: Identity): Promise<FoundMembership[] | undefined> {
  const rows = await db
    .selectFrom('app_user')
    .leftJoin('membership', 'membership.user_id', 'app_user.id')
    // The invite (in the inviter's account) the membership's account was created from.
    .leftJoin('account_invite', 'account_invite.invitee_account_id', 'membership.account_id')
    .select([
      'app_user.id as userId',
      'membership.account_id',
      'membership.role',
      'account_invite.revoked_at',
    ])
    .where('app_user.auth_provider', '=', identity.provider)
    .where('app_user.auth_subject', '=', identity.subject)
    .execute();
  if (rows.length === 0) return undefined;
  return rows.flatMap((row) =>
    row.account_id === null || row.role === null
      ? []
      : [
          {
            accountId: row.account_id as AccountId,
            userId: row.userId,
            role: row.role,
            revoked: row.revoked_at !== null,
          },
        ],
  );
}

async function provisionUser(db: Db, identity: Identity, signUp: SignUpPolicy): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // The lock account deletion takes: a deletion that committed before this point is seen
    // here, and one that starts later waits for this transaction.
    await lockIdentity(trx, identity);
    if (await isIdentityDeleted(trx, identity)) {
      throw new ApiError('unauthenticated', 'Sign in to continue.');
    }
    const email = identity.email?.toLowerCase();
    // The invite this email redeemed, locked so it is linked to one account only.
    const invite =
      email === undefined
        ? undefined
        : await trx
            .selectFrom('account_invite')
            .select(['id', 'invitee_user_id', 'revoked_at'])
            .where('claimed_email', '=', email)
            .forUpdate()
            .executeTakeFirst();
    if (invite !== undefined && invite.revoked_at !== null) {
      throw new ApiError('forbidden', ACCESS_REVOKED_MESSAGE);
    }
    // Another identity with this email already joined through it (a user the pool recreated).
    if (invite !== undefined && invite.invitee_user_id !== null) {
      throw new ApiError('forbidden', NOT_INVITED_MESSAGE);
    }
    const owner = signUp.mode === 'invite' && email !== undefined && email === signUp.ownerEmail;
    if (signUp.mode === 'invite' && invite === undefined && !owner) {
      throw new ApiError('forbidden', NOT_INVITED_MESSAGE);
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
        invited_at: invite === undefined ? null : sql<Date>`now()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('membership')
      .values({ account_id: account.id, user_id: user.id, role: 'owner' })
      .execute();
    if (invite !== undefined) {
      await trx
        .updateTable('account_invite')
        .set({
          invitee_user_id: user.id,
          invitee_account_id: account.id,
          accepted_at: sql<Date>`now()`,
        })
        .where('id', '=', invite.id)
        .execute();
    }
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
