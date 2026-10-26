/**
 * Who a forwarded email is from, by its From address's domain: a marketplace whose sold
 * notices Listora reads, an email provider confirming the forwarding rule, or anyone else.
 * The domains are each sender's registered domain; a subdomain (`email.poshmark.com`) counts,
 * a look-alike (`poshmark.com.example`, `notposhmark.com`) never does.
 */
import { isWithinDomain } from './authentication.ts';

/** The marketplaces that report sales only by email (and their apps). */
export const EMAIL_SALE_MARKETPLACES = ['poshmark', 'mercari', 'depop'] as const;
export type EmailSaleMarketplace = (typeof EMAIL_SALE_MARKETPLACES)[number];

/** Each marketplace's sending domain. To check against real sold emails (open item). */
export const MARKETPLACE_SENDER_DOMAINS = {
  poshmark: 'poshmark.com',
  mercari: 'mercari.com',
  depop: 'depop.com',
} as const satisfies Record<EmailSaleMarketplace, string>;

/** Email providers whose forwarding confirmation Listora shows the user. */
export const FORWARDING_PROVIDERS: readonly { name: string; domain: string }[] = [
  { name: 'Gmail', domain: 'google.com' },
  { name: 'Yahoo Mail', domain: 'yahoo.com' },
  { name: 'Outlook', domain: 'outlook.com' },
  { name: 'Outlook', domain: 'microsoft.com' },
  { name: 'iCloud Mail', domain: 'icloud.com' },
  { name: 'iCloud Mail', domain: 'apple.com' },
  { name: 'AOL Mail', domain: 'aol.com' },
  { name: 'Proton Mail', domain: 'proton.me' },
  { name: 'Fastmail', domain: 'fastmail.com' },
];

export type Sender =
  | { kind: 'marketplace'; marketplace: EmailSaleMarketplace; domain: string }
  | { kind: 'provider'; name: string; domain: string }
  | { kind: 'other' };

export function classifySender(fromDomain: string): Sender {
  for (const marketplace of EMAIL_SALE_MARKETPLACES) {
    const domain = MARKETPLACE_SENDER_DOMAINS[marketplace];
    if (isWithinDomain(fromDomain, domain)) return { kind: 'marketplace', marketplace, domain };
  }
  const provider = FORWARDING_PROVIDERS.find(({ domain }) => isWithinDomain(fromDomain, domain));
  return provider === undefined ? { kind: 'other' } : { kind: 'provider', ...provider };
}
