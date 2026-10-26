/**
 * How the seller sets forwarding up, as the app shows it (Settings > Link accounts > Sale
 * emails). The steps are the server's, so they change without an app update.
 */
import { MARKETPLACE_SENDER_DOMAINS } from './senders.ts';

/** A Gmail search that finds the marketplaces' sold notices, for the forwarding filter. */
export function forwardingFilter(): string {
  const senders = Object.values(MARKETPLACE_SENDER_DOMAINS).join(' OR ');
  return `from:(${senders}) subject:(sold OR sale)`;
}

export const FORWARDING_STEPS: readonly string[] = [
  'Copy your Listora address.',
  'In Gmail on a computer, open Settings > See all settings > Forwarding and POP/IMAP. Choose Add a forwarding address and paste it.',
  'Gmail sends Listora a confirmation code. It appears here: type it into Gmail, or open the link, to confirm.',
  'In Gmail, search with the filter below, choose Create filter, and forward the matches to your Listora address.',
  'With another email provider, add a rule that forwards the same emails to your Listora address.',
];
