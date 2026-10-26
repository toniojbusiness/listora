import type { SaleEmailTemplate } from './template.ts';

/**
 * Depop's sold notice, as Listora understands it until real samples are checked (open item in
 * docs/features/email-sales.md): "You've sold an item" with the item, its price, the order
 * number, and a link to the listing (`depop.com/products/<slug>/`).
 */
export const DEPOP_SOLD_EMAIL: SaleEmailTemplate = {
  marketplace: 'depop',
  soldSubject: /\b(you('ve| have)? sold|item (has )?sold|sold on depop)\b/i,
  labels: {
    title: /item|product/i,
    price: /price|total|sold for/i,
    orderNumber: /order number|order id|order/i,
  },
};
