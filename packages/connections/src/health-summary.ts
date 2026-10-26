/**
 * The account's connection health summary (the API's `getConnectionHealth`): every connection,
 * the ones that need the seller's attention, the banner the app shows while any does, and sale
 * email forwarding. Like `describeConnection`, the server renders the words, so every client
 * says the same honest thing.
 */
import type { Marketplace } from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import { assertNever } from '@listora/shared';

import type {
  ConnectionAttentionReason,
  ConnectionTone,
  ConnectionView,
} from './status-display.ts';

export interface StatusDisplayView {
  tone: ConnectionTone;
  label: string;
  detail?: string;
}

export interface ConnectionAttentionView {
  marketplace: Marketplace;
  reason: ConnectionAttentionReason;
  statusDisplay: StatusDisplayView;
}

export interface SaleForwardingView {
  status: 'needs_domain';
  statusDisplay: StatusDisplayView;
}

export interface ConnectionHealthSummaryView {
  needsAttention: boolean;
  /** Present exactly when `needsAttention`. */
  banner?: StatusDisplayView;
  attention: ConnectionAttentionView[];
  saleForwarding: SaleForwardingView;
  /** The latest check of any connection. */
  lastCheckedAt?: Date;
}

/**
 * Forwarding marketplace sale emails needs Listora's inbound email domain (SES inbound,
 * docs/features/email-sales.md). This is the summary's row where there is none; with one, the
 * API reports the account's own forwarding instead (apps/api/src/sale-emails/views.ts).
 */
export const SALE_FORWARDING: SaleForwardingView = {
  status: 'needs_domain',
  statusDisplay: {
    tone: 'neutral',
    label: 'Set up when you add a domain',
    detail:
      "Forwarding your marketplaces' sale emails to Listora lets it spot sales sooner. It needs Listora's email domain, which isn't set up yet.",
  },
};

/** `views`: every marketplace's connection, in display order. */
export function summarizeConnectionHealth(
  views: readonly ConnectionView[],
): ConnectionHealthSummaryView {
  const attention = views
    .flatMap((view): ConnectionAttentionView[] =>
      view.attention === undefined
        ? []
        : [
            {
              marketplace: view.marketplace,
              reason: view.attention,
              statusDisplay: view.statusDisplay,
            },
          ],
    )
    // Stable: what only the seller can fix comes first, in display order.
    .sort((a, b) => urgency(a.reason) - urgency(b.reason));
  const lastCheckedAt = views.reduce<Date | undefined>(
    (latest, view) =>
      view.lastCheckedAt !== undefined && (latest === undefined || view.lastCheckedAt > latest)
        ? view.lastCheckedAt
        : latest,
    undefined,
  );
  const banner = bannerFor(attention);
  return {
    needsAttention: banner !== undefined,
    ...(banner === undefined ? {} : { banner }),
    attention,
    saleForwarding: SALE_FORWARDING,
    ...(lastCheckedAt === undefined ? {} : { lastCheckedAt }),
  };
}

function bannerFor(attention: readonly ConnectionAttentionView[]): StatusDisplayView | undefined {
  const [first] = attention;
  if (first === undefined) return undefined;
  const tone: ConnectionTone = attention.every((entry) => entry.reason === 'connection_problem')
    ? 'checking'
    : 'action_needed';
  if (attention.length === 1) {
    const name = MARKETPLACE_NAMES[first.marketplace];
    return {
      tone,
      label: bannerLabel(first.reason, name),
      ...(first.statusDisplay.detail === undefined ? {} : { detail: first.statusDisplay.detail }),
    };
  }
  const names = attention.map((entry) => MARKETPLACE_NAMES[entry.marketplace]);
  return {
    tone,
    label: `${String(attention.length)} marketplaces need attention`,
    detail: `${listOf(names)} need you to look at their connections.`,
  };
}

function bannerLabel(reason: ConnectionAttentionReason, name: string): string {
  switch (reason) {
    case 'reconnect':
    case 'access_removed':
      return `Reconnect ${name}`;
    case 'expiring':
      return `Reconnect ${name} soon`;
    case 'connection_problem':
      return `${name} connection problem`;
    case 'not_confirmed':
      return `${name} sign-in not confirmed`;
    default:
      return assertNever(reason, 'connection attention reason');
  }
}

function urgency(reason: ConnectionAttentionReason): number {
  switch (reason) {
    case 'reconnect':
    case 'access_removed':
      return 0;
    case 'expiring':
    case 'not_confirmed':
      return 1;
    case 'connection_problem':
      return 2;
    default:
      return assertNever(reason, 'connection attention reason');
  }
}

/** `eBay`, `eBay and Depop`, `eBay, Depop, and Mercari`. */
function listOf(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1) ?? ''}`;
}
