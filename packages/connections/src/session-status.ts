/**
 * How an automation connection's linked browser session is shown (decision D1;
 * docs/features/marketplace-linking.md). Link accounts (the API's `MarketplaceSession`) and
 * Marketplaces (`Connection` and the health summary) both render this one description, so the
 * two screens always say the same thing about the same session.
 *
 * A session is `linked` only after the browser runner's check of it passed (`session_check`).
 * Until then it is `checking`, for at most `SESSION_CHECK_DEADLINE_MS`. A check that failed,
 * that has not finished by then (a runner that never started, a lost job), or that was never
 * asked for is `not_confirmed`, with the reason, and the seller can check the same session
 * again without signing in (`requestConnectionCheck`). A session the marketplace rejected, or
 * one that met a check automation must not pass, is `needs_relink`.
 */
import type { ConnectionStatus, DbExecutor, Marketplace, SessionCheckStatus } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import { assertNever } from '@listora/shared';

/**
 * How long a session check may run before it is shown as not confirmed. Its attempts (each up
 * to 2 minutes, 30 seconds and then 2 minutes apart) and the runner's starts fit well within it.
 */
export const SESSION_CHECK_DEADLINE_MS = 15 * 60_000;

/** The check of the newest session linked on an automation connection (`session_check`). */
export interface SessionCheckState {
  status: SessionCheckStatus;
  failureCode: string | null;
  failureMessage: string | null;
  /** When this check was asked for: by the link, or by checking again. */
  requestedAt: Date;
  finishedAt: Date | null;
}

export type AutomationSessionState = 'checking' | 'linked' | 'not_confirmed' | 'needs_relink';

export interface AutomationSessionInput {
  marketplace: Marketplace;
  connection: {
    status: ConnectionStatus;
    displayName: string | null;
    lastError: string | null;
    lastErrorCode: string | null;
    lastErrorAt: Date | null;
    updatedAt: Date;
  };
  check: SessionCheckState | null;
  now: Date;
  /**
   * Present when the connection's automated steps run on the phone
   * (docs/features/phone-execution.md): whether a phone linked it (only that phone holds the
   * session it runs with), and whether its session check waits for that phone.
   */
  phone?: { linked: boolean; checkWaiting: boolean };
}

export interface AutomationSessionView {
  state: AutomationSessionState;
  statusDisplay: { tone: 'success' | 'checking' | 'action_needed'; label: string; detail?: string };
  /** Why the session is not confirmed or needs a relink. */
  issue?: { code: string; message: string; occurredAt: Date };
  /** Whether the seller is offered to check the stored session again (Retry check). */
  canCheck: boolean;
}

export function describeAutomationSession(input: AutomationSessionInput): AutomationSessionView {
  const { connection, check, now, phone } = input;
  const name = MARKETPLACE_NAMES[input.marketplace];
  if (phone?.linked === false) {
    // It runs from the phone, and no phone holds a session for it: whatever the cloud found,
    // linking it on the phone is what makes it work.
    const message = `Listora runs ${name} from your iPhone, in your own session. Link ${name} on your iPhone to start.`;
    return {
      state: 'needs_relink',
      statusDisplay: { tone: 'action_needed', label: 'Link on your iPhone', detail: message },
      issue: { code: 'phone_link_needed', message, occurredAt: connection.updatedAt },
      canCheck: false,
    };
  }
  switch (connection.status) {
    case 'reauth_required':
    case 'revoked': {
      const message =
        connection.lastError ??
        (check?.status === 'failed' ? check.failureMessage : null) ??
        `Sign in to ${name} again to keep automating.`;
      return {
        state: 'needs_relink',
        statusDisplay: { tone: 'action_needed', label: 'Sign in again', detail: message },
        issue: {
          code:
            connection.lastErrorCode ??
            (check?.status === 'failed' ? check.failureCode : null) ??
            'reauth_required',
          message,
          occurredAt: connection.lastErrorAt ?? connection.updatedAt,
        },
        canCheck: false,
      };
    }
    case 'connected':
    case 'degraded':
      break;
    default:
      return assertNever(connection.status, 'connection status');
  }

  if (check?.status === 'passed') {
    const signedIn =
      connection.displayName === null ? null : `Signed in as ${connection.displayName}.`;
    const detail =
      phone === undefined
        ? signedIn
        : [signedIn, 'Runs from your iPhone.'].filter(Boolean).join(' ');
    return {
      state: 'linked',
      statusDisplay: {
        tone: 'success',
        label: 'Linked',
        ...(detail === null || detail === '' ? {} : { detail }),
      },
      canCheck: false,
    };
  }
  if (check?.status === 'pending' && phone?.checkWaiting === true) {
    // The phone checks it the next time Listora runs there; it is waiting, not stuck.
    return {
      state: 'checking',
      statusDisplay: {
        tone: 'checking',
        label: 'Checking on your iPhone...',
        detail: `Open Listora on your iPhone to finish checking your ${name} sign-in.`,
      },
      canCheck: false,
    };
  }
  if (
    check?.status === 'pending' &&
    now.getTime() - check.requestedAt.getTime() < SESSION_CHECK_DEADLINE_MS
  ) {
    return {
      state: 'checking',
      statusDisplay: {
        tone: 'checking',
        label: 'Checking...',
        detail: `Listora is checking that ${name} accepts your sign-in.`,
      },
      canCheck: false,
    };
  }
  const issue = unconfirmed(name, check, connection.updatedAt);
  return {
    state: 'not_confirmed',
    statusDisplay: {
      tone: 'action_needed',
      label: 'Not confirmed',
      detail: `${issue.message} Check again, or link ${name} again if it keeps failing.`,
    },
    issue,
    canCheck: true,
  };
}

/** Why a session that is not linked and not being checked is not confirmed. */
function unconfirmed(
  name: string,
  check: SessionCheckState | null,
  linkedAt: Date,
): { code: string; message: string; occurredAt: Date } {
  if (check === null) {
    return {
      code: 'check_missing',
      message: `Listora hasn't checked your ${name} sign-in yet.`,
      occurredAt: linkedAt,
    };
  }
  if (check.status === 'pending') {
    return {
      code: 'check_timed_out',
      message: `Listora's check of your ${name} sign-in didn't finish.`,
      occurredAt: new Date(check.requestedAt.getTime() + SESSION_CHECK_DEADLINE_MS),
    };
  }
  return {
    code: check.failureCode ?? 'check_failed',
    message: check.failureMessage ?? `Listora couldn't check your ${name} sign-in.`,
    occurredAt: check.finishedAt ?? check.requestedAt,
  };
}

/** The account's session checks, by connection id. */
export async function accountSessionChecks(
  db: DbExecutor,
  accountId: string,
): Promise<Map<string, SessionCheckState>> {
  const rows = await db
    .selectFrom('session_check')
    .select([
      'connection_id',
      'status',
      'failure_code',
      'failure_message',
      'requested_at',
      'finished_at',
    ])
    .where('account_id', '=', accountId)
    .execute();
  return new Map(
    rows.map((row) => [
      row.connection_id,
      {
        status: row.status,
        failureCode: row.failure_code,
        failureMessage: row.failure_message,
        requestedAt: row.requested_at,
        finishedAt: row.finished_at,
      },
    ]),
  );
}
