import type { MailMessage } from '../message.ts';
import type { EmailSaleMarketplace } from '../senders.ts';
import { DEPOP_SOLD_EMAIL } from './depop.ts';
import { MERCARI_SOLD_EMAIL } from './mercari.ts';
import { POSHMARK_SOLD_EMAIL } from './poshmark.ts';
import { parseWithTemplate, type SaleEmailParse, type SaleEmailTemplate } from './template.ts';

export type { ParsedSale, SaleEmailParse, SaleEmailTemplate } from './template.ts';

export const SOLD_EMAIL_TEMPLATES = {
  poshmark: POSHMARK_SOLD_EMAIL,
  mercari: MERCARI_SOLD_EMAIL,
  depop: DEPOP_SOLD_EMAIL,
} as const satisfies Record<EmailSaleMarketplace, SaleEmailTemplate>;

/** Reads a marketplace email (whose sender is verified) as a sale, a non-sale, or neither. */
export function parseSaleEmail(
  marketplace: EmailSaleMarketplace,
  message: MailMessage,
): SaleEmailParse {
  return parseWithTemplate(SOLD_EMAIL_TEMPLATES[marketplace], message);
}
