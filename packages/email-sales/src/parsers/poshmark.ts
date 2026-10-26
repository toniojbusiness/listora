import type { SaleEmailTemplate } from './template.ts';

/**
 * Poshmark's sold notice, as Listora understands it until real samples are checked (open item
 * in docs/features/email-sales.md): "You made a sale!" with the item, its price, the order id,
 * and a link to the listing (`poshmark.com/listing/<title>-<24 hex id>`).
 */
export const POSHMARK_SOLD_EMAIL: SaleEmailTemplate = {
  marketplace: 'poshmark',
  soldSubject: /\b(made a sale|(item|listing) (has )?sold|sold on poshmark)\b/i,
  labels: {
    title: /item|listing/i,
    price: /price|sold for|order total/i,
    orderNumber: /order id|order number|order/i,
  },
};
