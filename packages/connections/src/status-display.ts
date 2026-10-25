/**
 * How a marketplace connection is shown (the API's `Connection.statusDisplay` and
 * `availableActions`). The server renders it so every client says the same honest thing:
 * "Connected" only for a connection the marketplace accepted, a warning 30 days before the
 * grant expires, and a reconnect action whenever only the seller's consent can fix it.
 */
import type { ConnectionMode, ConnectionStatus, Marketplace } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import { assertNever } from '@listora/shared';

import type { ConnectionRow } from './store.ts';

/** The expiry warning starts this long before the grant ends. */
export const EXPIRY_WARNING_MS = 30 * 24 * 60 * 60_000;

export type ConnectionViewStatus = 'not_connected' | ConnectionStatus;
export type ConnectionAction = 'connect' | 'reconnect';
export type ConnectionTone = 'success' | 'checking' | 'action_needed' | 'neutral';

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
  lastIssue?: { code: string; message: string; occurredAt: Date };
}

export interface DescribeConnectionInput {
  marketplace: Marketplace;
  /** The account's connection, if it has one. */
  row: ConnectionRow | undefined;
  /** How the marketplace works without a connection: `api` (eBay) or `assisted`. */
  defaultMode: ConnectionMode;
  /** Whether this process can connect the marketplace now (an OAuth client and a vault). */
  canConnect: boolean;
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
          label: 'Assisted',
          detail: `Listora prepares each listing and change, and you finish it in the ${name} app, then confirm it.`,
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
        actions: connect('reconnect'),
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
      };
    default:
      return assertNever(status, 'connection status');
  }
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
