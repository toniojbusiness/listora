import type {
  Invite,
  KnownInviteAction,
  KnownInviteStatus,
  StatusDisplay,
} from '@listora/api-contract';
import type { Invitee } from '@listora/accounts';
import type { AccountInviteTable, DbExecutor } from '@listora/db';
import { sql, type Selectable } from 'kysely';

import type { Tenant } from '../tenancy.ts';

export type InviteRow = Selectable<AccountInviteTable>;

/** Invites nobody has used yet, per account; more is refused until some are used or revoked. */
export const MAX_OPEN_INVITES = 20;
/** The newest invites `listInvites` shows. */
export const LISTED_INVITES = 100;
/** How often an invitee may move a redeemed invite to another email before signing in. */
export const MAX_EMAIL_CHANGES = 5;

/** Whether the tenant's account may invite: only one created directly, not from an invite. */
export async function canInvite(db: DbExecutor, tenant: Tenant): Promise<boolean> {
  const account = await db
    .selectFrom('account')
    .select('invited_at')
    .where('id', '=', tenant.accountId)
    .executeTakeFirstOrThrow();
  return account.invited_at === null;
}

export async function listInviteRows(db: DbExecutor, tenant: Tenant): Promise<InviteRow[]> {
  return db
    .selectFrom('account_invite')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(LISTED_INVITES)
    .execute();
}

export async function countOpenInvites(db: DbExecutor, tenant: Tenant): Promise<number> {
  const { count } = await db
    .selectFrom('account_invite')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('account_id', '=', tenant.accountId)
    .where('claimed_email', 'is', null)
    .where('revoked_at', 'is', null)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]))
    .executeTakeFirstOrThrow();
  return count;
}

export interface NewInvite {
  codeSha256: Buffer;
  codeHint: string;
  label: string | undefined;
  expiresAt: Date | undefined;
}

export async function insertInvite(
  db: DbExecutor,
  tenant: Tenant,
  invite: NewInvite,
): Promise<InviteRow> {
  return db
    .insertInto('account_invite')
    .values({
      account_id: tenant.accountId,
      code_sha256: invite.codeSha256,
      code_hint: invite.codeHint,
      label: invite.label ?? null,
      expires_at: invite.expiresAt ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** The tenant's invite, locked for the rest of the transaction; undefined when it has none. */
export async function lockInvite(
  db: DbExecutor,
  tenant: Tenant,
  inviteId: string,
): Promise<InviteRow | undefined> {
  return db
    .selectFrom('account_invite')
    .selectAll()
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', inviteId)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * The person who used a redeemed invite, as the identity provider knows them: the email they
 * claimed it with, and once they signed in, their subject, which still names them if that email
 * changed.
 */
export async function inviteeOf(
  db: DbExecutor,
  invite: Pick<InviteRow, 'claimed_email' | 'invitee_user_id'>,
): Promise<Invitee | undefined> {
  if (invite.claimed_email === null) return undefined;
  const user =
    invite.invitee_user_id === null
      ? undefined
      : await db
          .selectFrom('app_user')
          .select('auth_subject')
          .where('id', '=', invite.invitee_user_id)
          .executeTakeFirst();
  return {
    email: invite.claimed_email,
    ...(user === undefined ? {} : { subject: user.auth_subject }),
  };
}

export async function setRevoked(
  db: DbExecutor,
  tenant: Tenant,
  inviteId: string,
  revoked: boolean,
): Promise<InviteRow> {
  return db
    .updateTable('account_invite')
    .set({ revoked_at: revoked ? sql<Date>`now()` : null })
    .where('account_id', '=', tenant.accountId)
    .where('id', '=', inviteId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

function statusOf(row: InviteRow, now: Date): KnownInviteStatus {
  if (row.revoked_at !== null) return 'revoked';
  if (row.accepted_at !== null) return 'active';
  if (row.claimed_email !== null) return 'redeemed';
  if (row.expires_at !== null && row.expires_at <= now) return 'expired';
  return 'open';
}

function statusDisplay(status: KnownInviteStatus, row: InviteRow): StatusDisplay {
  switch (status) {
    case 'open':
      return { tone: 'neutral', label: 'Not used yet' };
    case 'expired':
      return { tone: 'neutral', label: 'Expired' };
    case 'redeemed':
      return {
        tone: 'in_progress',
        label: 'Waiting for them to sign in',
        detail: 'They entered the code; their account starts at their first sign-in.',
      };
    case 'active':
      return { tone: 'success', label: 'Active' };
    case 'revoked':
      return row.claimed_email === null
        ? { tone: 'neutral', label: 'Revoked' }
        : {
            tone: 'failed',
            label: 'Access turned off',
            detail: 'They cannot sign in. Their account and data are kept.',
          };
  }
}

function actionsOf(status: KnownInviteStatus, row: InviteRow): KnownInviteAction[] {
  switch (status) {
    case 'open':
    case 'redeemed':
    case 'active':
      return ['revoke'];
    case 'expired':
      return [];
    case 'revoked':
      return row.claimed_email === null ? [] : ['restore'];
  }
}

export function inviteView(row: InviteRow, now: Date = new Date()): Invite {
  const status = statusOf(row, now);
  return {
    id: row.id,
    ...(row.label === null ? {} : { label: row.label }),
    codeHint: row.code_hint,
    status,
    statusDisplay: statusDisplay(status, row),
    ...(row.claimed_email === null ? {} : { email: row.claimed_email }),
    ...(row.expires_at === null || row.claimed_at !== null
      ? {}
      : { expiresAt: row.expires_at.toISOString() }),
    ...(row.claimed_at === null ? {} : { redeemedAt: row.claimed_at.toISOString() }),
    ...(row.accepted_at === null ? {} : { joinedAt: row.accepted_at.toISOString() }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at.toISOString() }),
    availableActions: actionsOf(status, row),
    createdAt: row.created_at.toISOString(),
  };
}
