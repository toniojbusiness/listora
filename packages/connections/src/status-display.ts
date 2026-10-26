/**
 * How a marketplace connection is shown (the API's `Connection.statusDisplay` and
 * `availableActions`). The server renders it so every client says the same honest thing:
 * "Connected" only for a connection the marketplace accepted, a warning 30 days before the
 * grant expires, and a reconnect action whenever only the seller's consent can fix it.
 */
import type { ConnectionMode, ConnectionStatus, Marketplace } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import { assertNever } from '@listora/shared';

import { describeAutomationSession, type SessionCheckState } from './session-status.ts';
import { checkPending, type ConnectionRow } from './store.ts';

/** The expiry warning starts this long before the grant ends. */
export const EXPIRY_WARNING_MS = 30 * 24 * 60 * 60_000;

export type ConnectionViewStatus = 'not_connected' | ConnectionStatus;
export type ConnectionAction = 'connect' | 'reconnect' | 'check';
export type ConnectionTone = 'success' | 'checking' | 'action_needed' | 'neutral';
/** Why a connection needs the seller's attention (the health summary's `attention`). */
export type ConnectionAttentionReason =
  'reconnect' | 'access_removed' | 'connection_problem' | 'expiring' | 'not_confirmed';

export interface ConnectionView {
  marketplace: Marketplace;
  mode: ConnectionMode;
  status: ConnectionViewStatus;
  statusDisplay: { tone: ConnectionTone; label: string; detail?: string };
  actions: ConnectionAction[];
  displayName?: string;
  connectedAt?: Date;
  grantExpiresAt?: Date;
  lastOkAt?: Date;
  lastCheckedAt?: Date;
  lastIssue?: { code: string; message: string; occurredAt: Date };
  /** Set while the connection needs the seller's attention. */
  attention?: ConnectionAttentionReason;
}

export interface DescribeConnectionInput {
  marketplace: Marketplace;
  /** The account's connection, if it has one. */
  row: ConnectionRow | undefined;
  /** How the marketplace works without a connection: `api` (eBay) or `assisted`. */
  defaultMode: ConnectionMode;
  /**
   * Whether this process can connect the marketplace now (an OAuth client and a vault). The
   * worker that checks connections reads the same settings, so it also decides `check`.
   */
  canConnect: boolean;
  /**
   * The check of the session linked on an `automation` connection; none (or absent) means it was
   * never checked. Ignored for other modes.
   */
  sessionCheck?: SessionCheckState | null;
  /** Where an automation connection runs, when on the phone (`phoneSessionState`). */
  phone?: { linked: boolean; checkWaiting: boolean };
  now: Date;
}

export function describeConnection(input: DescribeConnectionInput): ConnectionView {
  const { marketplace, row, canConnect, now } = input;
  const name = MARKETPLACE_NAMES[marketplace];
  const mode = row?.mode ?? input.defaultMode;
  const connect = (action: ConnectionAction): ConnectionAction[] => (canConnect ? [action] : []);

  if (row === undefined || row.mode === 'assisted') {
    if (mode === 'assisted') {
      return {
        marketplace,
        mode,
        status: 'not_connected',
        statusDisplay: {
          tone: 'neutral',
          label: 'Not linked',
          detail: `Listora works with ${name} in assisted mode: it prepares each listing and change, and you finish it in the ${name} app, then confirm it.`,
        },
        actions: connect('connect'),
      };
    }
    return {
      marketplace,
      mode,
      status: 'not_connected',
      statusDisplay: canConnect
        ? {
            tone: 'neutral',
            label: 'Not connected',
            detail: `Connect your ${name} account so Listora can list, update, and end your items there, and confirm every change with ${name}.`,
          }
        : {
            tone: 'neutral',
            label: 'Coming soon',
            detail: `Listora can't connect to ${name} yet.`,
          },
      actions: connect('connect'),
    };
  }

  if (row.mode === 'automation') return describeAutomationConnection(input, row);

  const expired = row.refresh_expires_at !== null && row.refresh_expires_at <= now;
  const status: ConnectionStatus =
    expired && (row.status === 'connected' || row.status === 'degraded')
      ? 'reauth_required'
      : row.status;
  const details = {
    marketplace,
    mode,
    status,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    ...(row.granted_at === null ? {} : { connectedAt: row.granted_at }),
    ...(row.refresh_expires_at === null ? {} : { grantExpiresAt: row.refresh_expires_at }),
    ...(row.last_ok_at === null ? {} : { lastOkAt: row.last_ok_at }),
    ...(row.last_checked_at === null ? {} : { lastCheckedAt: row.last_checked_at }),
    ...(row.last_error === null || row.last_error_code === null || row.last_error_at === null
      ? {}
      : {
          lastIssue: {
            code: row.last_error_code,
            message: row.last_error,
            occurredAt: row.last_error_at,
          },
        }),
  };

  // The seller asked for a check, and the worker has not finished it: say so, and offer nothing
  // until it has. A check only runs on a connection that still holds its grant.
  if ((status === 'connected' || status === 'degraded') && checkPending(row, now)) {
    return {
      ...details,
      statusDisplay: {
        tone: 'checking',
        label: 'Checking...',
        detail: `Listora is checking your ${name} connection now.`,
      },
      actions: [],
      ...(status === 'degraded' ? { attention: 'connection_problem' as const } : {}),
    };
  }

  switch (status) {
    case 'connected': {
      const expiresAt = row.refresh_expires_at;
      if (expiresAt !== null && expiresAt.getTime() - now.getTime() <= EXPIRY_WARNING_MS) {
        const days = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000));
        return {
          ...details,
          statusDisplay: {
            tone: 'action_needed',
            label: `Reconnect within ${String(days)} ${days === 1 ? 'day' : 'days'}`,
            detail: `Listora's ${name} access ends on ${formatDate(expiresAt)}. Reconnect ${name} before then to keep your listings in sync.`,
          },
          actions: connect('reconnect'),
          attention: 'expiring',
        };
      }
      return {
        ...details,
        statusDisplay: {
          tone: 'success',
          label: 'Connected',
          ...(row.display_name === null ? {} : { detail: `Signed in as ${row.display_name}.` }),
        },
        actions: [],
      };
    }
    case 'degraded':
      return {
        ...details,
        statusDisplay: {
          tone: 'checking',
          label: 'Connection problem',
          detail: `${row.last_error ?? `Listora could not reach ${name}.`} Listora keeps checking.`,
        },
        // Retry check first: the problem may be gone. Reconnecting also fixes a refused grant.
        actions: canConnect ? ['check', 'reconnect'] : [],
        attention: 'connection_problem',
      };
    case 'reauth_required':
      return {
        ...details,
        statusDisplay: {
          tone: 'action_needed',
          label: 'Reconnect needed',
          detail: expired
            ? `Listora's ${name} access expired. Reconnect ${name} to keep your listings in sync.`
            : (row.last_error ??
              `Sign in to ${name} again so Listora can keep your listings in sync.`),
        },
        actions: connect('reconnect'),
        attention: 'reconnect',
      };
    case 'revoked':
      return {
        ...details,
        statusDisplay: {
          tone: 'action_needed',
          label: 'Access removed',
          detail:
            row.last_error ??
            `Listora's access to your ${name} account was removed. Reconnect ${name}.`,
        },
        actions: connect('reconnect'),
        attention: 'access_removed',
      };
    default:
      return assertNever(status, 'connection status');
  }
}

/**
 * An automation connection: the linked browser session as `describeAutomationSession` shows it,
 * so Marketplaces says exactly what Link accounts says about it.
 */
function describeAutomationConnection(
  input: DescribeConnectionInput,
  row: ConnectionRow,
): ConnectionView {
  const check = input.sessionCheck ?? null;
  const session = describeAutomationSession({
    marketplace: input.marketplace,
    connection: {
      status: row.status,
      displayName: row.display_name,
      lastError: row.last_error,
      lastErrorCode: row.last_error_code,
      lastErrorAt: row.last_error_at,
      updatedAt: row.updated_at,
    },
    check,
    now: input.now,
    ...(input.phone === undefined ? {} : { phone: input.phone }),
  });
  // Only a session the marketplace accepted has a last good check: its passed check, or a later
  // run whose refreshed cookies the marketplace sent.
  const lastOkAt =
    session.state === 'linked' ? latest(check?.finishedAt ?? null, row.last_ok_at) : null;
  const lastCheckedAt = check?.finishedAt ?? row.last_checked_at;
  const attention = automationAttention(session.state, row.status);
  return {
    marketplace: input.marketplace,
    mode: 'automation',
    status: row.status,
    statusDisplay: session.statusDisplay,
    actions: session.canCheck ? ['check'] : [],
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    ...(row.granted_at === null ? {} : { connectedAt: row.granted_at }),
    ...(lastOkAt === null ? {} : { lastOkAt }),
    ...(lastCheckedAt === null ? {} : { lastCheckedAt }),
    ...(session.issue === undefined ? {} : { lastIssue: session.issue }),
    ...(attention === undefined ? {} : { attention }),
  };
}

function automationAttention(
  state: ReturnType<typeof describeAutomationSession>['state'],
  status: ConnectionStatus,
): ConnectionAttentionReason | undefined {
  switch (state) {
    case 'needs_relink':
      return status === 'revoked' ? 'access_removed' : 'reconnect';
    case 'not_confirmed':
      return 'not_confirmed';
    case 'checking':
    case 'linked':
      return undefined;
    default:
      return assertNever(state, 'session state');
  }
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/** `March 3, 2027`, in UTC. */
function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
