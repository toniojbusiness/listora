import type { SaleEmailTemplate } from './template.ts';

/**
 * Mercari's sold notice, as Listora understands it until real samples are checked (open item
 * in docs/features/email-sales.md): "Your item sold!" with the item, its price, the order
 * number, and a link to the item (`mercari.com/us/item/m<digits>/`).
 */
export const MERCARI_SOLD_EMAIL: SaleEmailTemplate = {
  marketplace: 'mercari',
  soldSubject: /\b(item|items) (has |have )?sold\b|\bsold on mercari\b/i,
  labels: {
    title: /item name|item/i,
    price: /item price|sale price|price/i,
    orderNumber: /order number|order id|order/i,
  },
};
