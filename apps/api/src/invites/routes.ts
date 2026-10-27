import type { InviteeDirectory, InviteeEmailState } from '@listora/accounts';
import type { InviteRedeem, InviteRedemption } from '@listora/api-contract';
import type { Db, DbExecutor } from '@listora/db';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { operationSpec } from '../contract/contract.ts';
import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { isPgError, PG_ERROR } from '../db-errors.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import {
  formatInviteCode,
  inviteCodeHint,
  inviteCodeSha256,
  newInviteCode,
  normalizeInviteCode,
} from './codes.ts';
import { RedemptionLimiter } from './limiter.ts';
import {
  canInvite,
  countOpenInvites,
  insertInvite,
  inviteView,
  listInviteRows,
  lockInvite,
  MAX_EMAIL_CHANGES,
  MAX_OPEN_INVITES,
  setRevoked,
  type InviteRow,
} from './repository.ts';

export interface InvitesDependencies {
  /** The identity provider's users invitees sign in as (Cognito, or nothing for the dev driver). */
  directory: InviteeDirectory;
}

export interface InviteRouteDependencies extends RouteDependencies {
  invites: InvitesDependencies;
  now: () => Date;
}

/** The app's link that opens its sign-up with the code filled in. */
export const INVITE_LINK_PREFIX = 'listora://invite/';
const DAY_MS = 86_400_000;

/**
 * Invites (docs/features/invites.md): the inviting account's `listInvites`, `createInvite`,
 * `revokeInvite`, and `restoreInvite`, and the public `redeemInvite` an invitee calls before
 * they can sign in.
 */
export function registerInviteRoutes(app: FastifyInstance, deps: InviteRouteDependencies): void {
  const { directory } = deps.invites;

  contractRoute(app, deps, 'listInvites', async ({ tenant, db }) => {
    if (!(await canInvite(db, tenant))) {
      return { status: 200, body: { canInvite: false, data: [] } };
    }
    const now = deps.now();
    const rows = await listInviteRows(db, tenant);
    return {
      status: 200,
      body: { canInvite: true, data: rows.map((row) => inviteView(row, now)) },
    };
  });

  contractRoute(app, deps, 'createInvite', async ({ tenant, db, body }) => {
    if (!(await canInvite(db, tenant))) {
      throw new ApiError(
        'forbidden',
        'Only the account that set up this Listora can invite people.',
      );
    }
    if ((await countOpenInvites(db, tenant)) >= MAX_OPEN_INVITES) {
      throw new ApiError(
        'invalid_state_transition',
        `You have ${String(MAX_OPEN_INVITES)} invites nobody has used yet. Revoke some first.`,
      );
    }
    const code = newInviteCode();
    const now = deps.now();
    const expiresAt =
      body.expiresInDays === undefined
        ? undefined
        : new Date(now.getTime() + body.expiresInDays * DAY_MS);
    const row = await insertInvite(db, tenant, {
      codeSha256: inviteCodeSha256(code),
      codeHint: inviteCodeHint(code),
      label: body.label?.trim() === '' ? undefined : body.label?.trim(),
      expiresAt,
    });
    const shown = formatInviteCode(code);
    const link = `${INVITE_LINK_PREFIX}${shown}`;
    return {
      status: 201,
      body: {
        invite: inviteView(row, now),
        code: shown,
        link,
        message: shareMessage(row, shown, link),
      },
    };
  });

  contractRoute(app, deps, 'revokeInvite', async ({ tenant, db, params }) => {
    const invite = await lockInvite(db, tenant, params.inviteId);
    if (!invite) throw notFound('The invite');
    if (invite.revoked_at !== null) return { status: 200, body: inviteView(invite, deps.now()) };
    // The sign-in provider first: when it fails, the transaction rolls back and nothing is
    // revoked, so the answer never claims a revocation that did not happen.
    if (invite.claimed_email !== null) {
      await atProvider(() => directory.suspend(invite.claimed_email ?? ''), 'revoke');
    }
    const revoked = await setRevoked(db, tenant, invite.id, true);
    return { status: 200, body: inviteView(revoked, deps.now()) };
  });

  contractRoute(app, deps, 'restoreInvite', async ({ tenant, db, params }) => {
    const invite = await lockInvite(db, tenant, params.inviteId);
    if (!invite) throw notFound('The invite');
    const email = invite.claimed_email;
    if (invite.revoked_at === null || email === null) {
      throw new ApiError(
        'invalid_state_transition',
        invite.revoked_at === null
          ? 'This invite is not revoked.'
          : 'Nobody used this invite before it was revoked. Create a new one instead.',
      );
    }
    await atProvider(() => directory.resume(email), 'restore');
    const restored = await setRevoked(db, tenant, invite.id, false);
    return { status: 200, body: inviteView(restored, deps.now()) };
  });

  registerRedemption(app, deps);
}

/** The share sheet's text: who it is for, the code, the link, and when it expires. */
function shareMessage(row: InviteRow, code: string, link: string): string {
  const greeting = row.label === null ? '' : `Hi ${row.label}! `;
  const expiry =
    row.expires_at === null
      ? ''
      : ` The code works until ${row.expires_at.toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        })}.`;
  return (
    `${greeting}I'm inviting you to Listora, the app I use to list and manage what I sell ` +
    `everywhere. In the Listora app, tap "Sign up with an invite" and enter this code: ${code}` +
    ` (or open ${link} on your iPhone). You'll sign in with your own email; your account is ` +
    `yours alone.${expiry}`
  );
}

/** Runs a sign-in provider call; its failure is a retryable `503` that changed nothing. */
async function atProvider<T>(call: () => Promise<T>, action: string): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new ApiError(
      'service_unavailable',
      `Listora could not ${action} this invite with the sign-in service right now. Try again.`,
      { cause: error },
    );
  }
}

/**
 * `redeemInvite`, public: the invite code is the credential. It binds the invite to the email in
 * one transaction that locks the invite, then lets the email sign in at the provider. Repeating
 * it is safe, so a lost answer or a provider failure is fixed by redeeming again.
 */
function registerRedemption(app: FastifyInstance, deps: InviteRouteDependencies): void {
  const spec = operationSpec('redeemInvite');
  const limiter = new RedemptionLimiter(() => deps.now().getTime());
  const ownerEmail = deps.signUp.mode === 'invite' ? deps.signUp.ownerEmail : undefined;
  app.route({
    method: spec.method,
    url: spec.url,
    handler: async (request, reply) => {
      limiter.check();
      const validated = spec.validateBody?.(request.body);
      if (validated === undefined || request.body === undefined) {
        throw new ApiError('invalid_request', 'This request needs a JSON body.');
      }
      if (!validated.ok) throw validationFailed(validated.errors);
      const body = validated.value as InviteRedeem;
      const code = normalizeInviteCode(body.code);
      if (code === undefined) {
        limiter.failed();
        throw validationFailed(
          [{ field: 'code', message: 'is not an invite code' }],
          "That isn't an invite code. It has 16 letters and digits, like K7QD-3M9P-XW2T-H8RA.",
        );
      }
      const email = body.email.trim().toLowerCase();
      const bound = await bindInvite(deps.db, code, email, ownerEmail, deps.now());
      if (bound.kind === 'unknown') {
        limiter.failed();
        throw new ApiError('not_found', "That invite code isn't right. Check it and try again.");
      }
      const redemption = await admitInvitee(deps.invites.directory, bound, request.log);
      return reply.code(200).header('cache-control', 'no-store').send(redemption);
    },
  });
}

type Binding =
  | { kind: 'unknown' }
  | { kind: 'bound'; email: string; inviteId: string; replaced: string | undefined };

/** Binds the invite with `code` to `email`, or explains in an `ApiError` why it cannot. */
async function bindInvite(
  db: Db,
  code: string,
  email: string,
  ownerEmail: string | undefined,
  now: Date,
): Promise<Binding> {
  try {
    return await db.transaction().execute(async (trx): Promise<Binding> => {
      const invite = await trx
        .selectFrom('account_invite')
        .selectAll()
        .where('code_sha256', '=', inviteCodeSha256(code))
        .forUpdate()
        .executeTakeFirst();
      if (!invite) return { kind: 'unknown' };
      if (invite.revoked_at !== null) {
        throw new ApiError(
          'invalid_state_transition',
          'This invite was turned off. Ask the person who invited you for a new one.',
        );
      }
      if (invite.claimed_email === email) {
        return { kind: 'bound', email, inviteId: invite.id, replaced: undefined };
      }
      if (invite.accepted_at !== null) {
        throw new ApiError(
          'invalid_state_transition',
          'This invite was already used. Ask the person who invited you for a new one.',
        );
      }
      if (invite.claimed_email === null && invite.expires_at !== null && invite.expires_at <= now) {
        throw new ApiError(
          'invalid_state_transition',
          'This invite has expired. Ask the person who invited you for a new one.',
        );
      }
      if (invite.email_changes >= MAX_EMAIL_CHANGES) {
        throw new ApiError(
          'invalid_state_transition',
          "This invite's email was changed too many times. Ask for a new invite.",
        );
      }
      if (email === ownerEmail || (await emailHasAccount(trx, email))) {
        throw new ApiError(
          'already_exists',
          'This email already has a Listora account. Sign in with it instead.',
        );
      }
      await trx
        .updateTable('account_invite')
        .set({
          claimed_email: email,
          claimed_at: invite.claimed_at ?? sql<Date>`now()`,
          email_changes: invite.claimed_email === null ? 0 : invite.email_changes + 1,
        })
        .where('id', '=', invite.id)
        .execute();
      return {
        kind: 'bound',
        email,
        inviteId: invite.id,
        replaced: invite.claimed_email ?? undefined,
      };
    });
  } catch (error) {
    // Another invite claimed the same email meanwhile.
    if (isPgError(error, PG_ERROR.uniqueViolation)) {
      throw new ApiError(
        'already_exists',
        'This email already has a Listora invite. Sign in with it instead.',
      );
    }
    throw error;
  }
}

/** A person with this email has signed in, or another invite holds it. */
async function emailHasAccount(db: DbExecutor, email: string): Promise<boolean> {
  const user = await db
    .selectFrom('app_user')
    .select('id')
    .where(sql<string>`lower(email)`, '=', email)
    .executeTakeFirst();
  if (user) return true;
  const invite = await db
    .selectFrom('account_invite')
    .select('id')
    .where('claimed_email', '=', email)
    .executeTakeFirst();
  return invite !== undefined;
}

/** Lets the bound email sign in at the provider, and says what the invitee does next. */
async function admitInvitee(
  directory: InviteeDirectory,
  bound: Extract<Binding, { kind: 'bound' }>,
  log: FastifyBaseLogger,
): Promise<InviteRedemption> {
  if (bound.replaced !== undefined) {
    // The address the invitee corrected: its user never signed in (an accepted invite cannot
    // move). Leaving it is harmless, since no invite names it any more, so a failure only logs.
    try {
      await directory.forget(bound.replaced);
    } catch (error) {
      log.warn({ err: error, inviteId: bound.inviteId }, 'the replaced invitee user remains');
    }
  }
  let state: InviteeEmailState;
  try {
    state = await directory.admit(bound.email);
  } catch (error) {
    throw new ApiError(
      'service_unavailable',
      'Listora could not set up your sign-in right now. Try again in a moment.',
      { cause: error },
    );
  }
  log.info({ inviteId: bound.inviteId, state }, 'invite redeemed');
  switch (state) {
    case 'deliverable':
      return {
        email: bound.email,
        status: 'ready',
        message: `Sign in with ${bound.email}. We'll email you a one-time code.`,
      };
    case 'verification_sent':
      return {
        email: bound.email,
        status: 'email_verification_sent',
        message:
          `Amazon Web Services emailed ${bound.email} a link to verify the address, so ` +
          `Listora's sign-in codes can reach it. Open that email and tap the link, then come ` +
          `back and tap Continue.`,
      };
  }
}
