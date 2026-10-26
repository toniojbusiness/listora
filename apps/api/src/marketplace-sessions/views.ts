/**
 * The `MarketplaceSession` view: a marketplace linked by signing in, with an honest status.
 * The status is the one Marketplaces shows for the same connection: both render
 * `describeAutomationSession`. A session is `linked` only after the browser runner's check of it
 * passed (`session_check`); one stored but not checked yet is `checking`, for a bounded time; a
 * check that failed or did not finish is `check_failed`, which the seller can check again; and a
 * session the marketplace rejected is `needs_relink` (docs/features/marketplace-linking.md).
 */
import type { MarketplaceSession } from '@listora/api-contract';
import type { AutomationProfile } from '@listora/automation';
import {
  describeAutomationSession,
  type ExecutionView,
  type SessionCheckState,
} from '@listora/connections';
import type { ConnectionMode, ConnectionStatus, Marketplace } from '@listora/db';
import { assertNever } from '@listora/shared';

import { executionView } from '../connections/views.ts';
import { marketplaceName } from '../listings/views.ts';

export interface SessionRow {
  marketplace: Marketplace;
  /** Absent when the account has no connection on the marketplace. */
  connection: {
    mode: ConnectionMode;
    status: ConnectionStatus;
    displayName: string | null;
    lastError: string | null;
    lastErrorCode: string | null;
    lastErrorAt: Date | null;
    /** When the current session was linked. */
    linkedAt: Date | null;
    updatedAt: Date;
    /** Where its automated steps run (`describeExecution`). */
    execution?: ExecutionView | undefined;
    /** Present when they run on the phone (`phoneSessionState`). */
    phone?: { linked: boolean; checkWaiting: boolean } | undefined;
  } | null;
  /** The check of the newest linked session, when there is one. */
  check: SessionCheckState | null;
}

export function marketplaceSessionView(
  row: SessionRow,
  profile: Pick<AutomationProfile, 'loginUrl' | 'cookieDomains' | 'emailsSignInLinks'>,
  now: Date,
): MarketplaceSession {
  const name = marketplaceName(row.marketplace);
  const login = {
    url: profile.loginUrl,
    cookieDomains: [...profile.cookieDomains],
    emailsSignInLinks: profile.emailsSignInLinks,
  };
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

  const session = describeAutomationSession({
    marketplace: row.marketplace,
    connection,
    check,
    now,
    ...(connection.phone === undefined ? {} : { phone: connection.phone }),
  });
  return {
    ...base,
    ...(connection.displayName === null ? {} : { displayName: connection.displayName }),
    ...(connection.linkedAt === null ? {} : { linkedAt: connection.linkedAt.toISOString() }),
    ...(check?.finishedAt ? { checkedAt: check.finishedAt.toISOString() } : {}),
    status: sessionStatus(session.state),
    statusDisplay: session.statusDisplay,
    ...(connection.execution === undefined
      ? {}
      : { execution: executionView(connection.execution) }),
    ...(session.issue === undefined
      ? {}
      : {
          issue: {
            code: session.issue.code,
            message: session.issue.message,
            occurredAt: session.issue.occurredAt.toISOString(),
          },
        }),
  };
}

function sessionStatus(
  state: ReturnType<typeof describeAutomationSession>['state'],
): MarketplaceSession['status'] {
  switch (state) {
    case 'checking':
      return 'checking';
    case 'linked':
      return 'linked';
    case 'not_confirmed':
      return 'check_failed';
    case 'needs_relink':
      return 'needs_relink';
    default:
      return assertNever(state, 'session state');
  }
}
