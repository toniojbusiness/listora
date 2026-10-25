/**
 * The `MarketplaceSession` view: a marketplace linked by signing in, with an honest status.
 * It is `linked` only after the browser runner's check of the current session passed
 * (`session_check`); a session that is stored but not checked yet is `checking`, and one the
 * marketplace rejected is `needs_relink` (docs/features/marketplace-linking.md).
 */
import type { MarketplaceSession, StatusDisplay } from '@listora/api-contract';
import type { AutomationProfile } from '@listora/automation';
import type {
  ConnectionMode,
  ConnectionStatus,
  Marketplace,
  SessionCheckStatus,
} from '@listora/db';
import { assertNever } from '@listora/shared';

import { marketplaceName } from '../listings/views.ts';

export interface SessionRow {
  marketplace: Marketplace;
  /** Absent when the account has no connection on the marketplace. */
  connection: {
    mode: ConnectionMode;
    status: ConnectionStatus;
    displayName: string | null;
    lastError: string | null;
    updatedAt: Date;
  } | null;
  /** The check of the newest linked session, when there is one. */
  check: {
    status: SessionCheckStatus;
    failureCode: string | null;
    failureMessage: string | null;
    requestedAt: Date;
    finishedAt: Date | null;
  } | null;
}

export function marketplaceSessionView(
  row: SessionRow,
  profile: Pick<AutomationProfile, 'loginUrl' | 'cookieDomains'>,
): MarketplaceSession {
  const name = marketplaceName(row.marketplace);
  const login = { url: profile.loginUrl, cookieDomains: [...profile.cookieDomains] };
  const base = { marketplace: row.marketplace, login };
  const { connection, check } = row;
  if (connection === null || connection.mode === 'assisted') {
    return {
      ...base,
      status: 'not_linked',
      statusDisplay: { tone: 'neutral', label: 'Not linked' },
    };
  }
  if (connection.mode === 'api') {
    return {
      ...base,
      status: 'api_connected',
      statusDisplay: { tone: 'neutral', label: `Connected through the ${name} API` },
    };
  }

  const linked = {
    ...base,
    ...(connection.displayName === null ? {} : { displayName: connection.displayName }),
    ...(check === null ? {} : { linkedAt: check.requestedAt.toISOString() }),
    ...(check?.finishedAt ? { checkedAt: check.finishedAt.toISOString() } : {}),
  };
  switch (connection.status) {
    case 'reauth_required':
    case 'revoked': {
      const message =
        connection.lastError ??
        check?.failureMessage ??
        `Sign in to ${name} again to keep automating.`;
      return {
        ...linked,
        status: 'needs_relink',
        statusDisplay: { tone: 'action_needed', label: 'Sign in again', detail: message },
        issue: {
          code:
            check?.status === 'failed'
              ? (check.failureCode ?? 'reauth_required')
              : 'reauth_required',
          message,
          occurredAt: connection.updatedAt.toISOString(),
        },
      };
    }
    case 'connected':
    case 'degraded':
      return { ...linked, ...checkedStatus(check) };
    default:
      return assertNever(connection.status, 'connection status');
  }
}

function checkedStatus(
  check: SessionRow['check'],
): Pick<MarketplaceSession, 'status' | 'statusDisplay' | 'issue'> {
  const checking: StatusDisplay = { tone: 'checking', label: 'Checking...' };
  if (check === null) return { status: 'checking', statusDisplay: checking };
  switch (check.status) {
    case 'pending':
      return { status: 'checking', statusDisplay: checking };
    case 'passed':
      return { status: 'linked', statusDisplay: { tone: 'success', label: 'Linked' } };
    case 'failed': {
      const message = check.failureMessage ?? 'Listora could not check this sign-in.';
      return {
        status: 'check_failed',
        statusDisplay: { tone: 'failed', label: 'Not confirmed - Link again', detail: message },
        issue: {
          code: check.failureCode ?? 'check_failed',
          message,
          occurredAt: (check.finishedAt ?? check.requestedAt).toISOString(),
        },
      };
    }
    default:
      return assertNever(check.status, 'session check status');
  }
}
