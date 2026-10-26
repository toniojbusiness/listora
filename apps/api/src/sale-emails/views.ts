/**
 * The contract's `SaleEmails`: the forwarding address, the setup steps, and an honest status.
 * Forwarding reads as working only once a marketplace email passed Listora's sender checks.
 */
import type { SaleEmails, SaleForwarding, StatusDisplay } from '@listora/api-contract';
import { SALE_FORWARDING } from '@listora/connections';
import {
  FORWARDING_STEPS,
  forwardingAddress,
  forwardingFilter,
  type SaleEmailInbox,
} from '@listora/email-sales';

type Status = 'unavailable' | 'not_set_up' | 'confirming' | 'working';

const DISPLAY: Record<Status, StatusDisplay> = {
  unavailable: {
    tone: 'neutral',
    label: 'Not available yet',
    detail:
      'Listora reads sale emails once it has its own email domain. Sales are still found by the scheduled checks.',
  },
  not_set_up: {
    tone: 'action_needed',
    label: 'Not set up',
    detail:
      'Forward your Poshmark, Mercari, and Depop sold emails to your Listora address, in Settings > Link accounts.',
  },
  confirming: {
    tone: 'action_needed',
    label: 'Confirm forwarding',
    detail:
      'Your email provider sent a confirmation. Enter its code in your email settings, or open its link.',
  },
  working: {
    tone: 'success',
    label: 'Working',
    detail: 'Listora reads your sold emails and delists the item everywhere else within minutes.',
  },
};

function statusOf(inbox: SaleEmailInbox | undefined, inboundDomain: string | undefined): Status {
  if (inboundDomain === undefined) return 'unavailable';
  if (inbox === undefined) return 'not_set_up';
  if (inbox.lastVerifiedEmailAt !== null) return 'working';
  return inbox.confirmation !== null ? 'confirming' : 'not_set_up';
}

/** The connection health summary's sale forwarding row (`getConnectionHealth`). */
export function saleForwardingView(
  inbox: SaleEmailInbox | undefined,
  inboundDomain: string | undefined,
): SaleForwarding {
  const status = statusOf(inbox, inboundDomain);
  return status === 'unavailable' ? SALE_FORWARDING : { status, statusDisplay: DISPLAY[status] };
}

export function saleEmailsView(
  inbox: SaleEmailInbox | undefined,
  inboundDomain: string | undefined,
): SaleEmails {
  const status = inbox === undefined ? 'unavailable' : statusOf(inbox, inboundDomain);
  const confirmation = status === 'confirming' ? inbox?.confirmation : null;
  return {
    ...(inbox === undefined || inboundDomain === undefined
      ? {}
      : { address: forwardingAddress(inbox.addressToken, inboundDomain) }),
    status,
    statusDisplay: DISPLAY[status],
    askBeforeDelist: inbox?.askBeforeDelist ?? false,
    steps: [...FORWARDING_STEPS],
    filter: forwardingFilter(),
    ...(confirmation === null || confirmation === undefined
      ? {}
      : {
          confirmation: {
            provider: confirmation.provider,
            ...(confirmation.code === null ? {} : { code: confirmation.code }),
            ...(confirmation.url === null ? {} : { url: confirmation.url }),
            receivedAt: confirmation.receivedAt.toISOString(),
          },
        }),
    ...(inbox?.lastSaleEmailAt === undefined || inbox.lastSaleEmailAt === null
      ? {}
      : { lastSaleEmailAt: inbox.lastSaleEmailAt.toISOString() }),
    ...(inbox?.lastEmailAt === undefined || inbox.lastEmailAt === null
      ? {}
      : { lastEmailAt: inbox.lastEmailAt.toISOString() }),
  };
}
