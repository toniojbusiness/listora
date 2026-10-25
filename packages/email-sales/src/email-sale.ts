/**
 * What a sale email turns into: a recorded sale (the sale intake's `recordSale`, which starts
 * the auto-delist), or a task in the seller's inbox when Listora must not act alone:
 *
 * - `confirm_sale`: the email matched an item, but the seller asked to confirm sale emails
 *   before anything is delisted ("ask before auto-delist"). Confirming records the sale.
 * - `review_match`: the email is a sold notice Listora cannot read, or its listing could be
 *   more than one item. The seller picks the item (which records the sale) or says none is.
 *
 * Both tasks hold what the email said (`EmailSaleDetails`): its parsed fields and a short
 * redacted excerpt, never the message.
 */
import { jsonb, type DbExecutor, type DbTransaction, type Marketplace } from '@listora/db';
import type { AdapterLookup } from '@listora/marketplaces';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import { enqueuePush } from '@listora/push';
import { recordSale, STANDING_SALE_STATUSES, type RecordSaleResult } from '@listora/sales';
import { z } from 'zod';

/** Why a sale email waits for the seller. */
export const EMAIL_SALE_TASK_REASONS = [
  'ask_before_delist',
  'ambiguous_match',
  'unknown_format',
] as const;
export type EmailSaleTaskReason = (typeof EMAIL_SALE_TASK_REASONS)[number];

/** What a confirm or review task keeps of its sale email (`user_task.payload.emailSale`). */
export interface EmailSaleDetails {
  reason: EmailSaleTaskReason;
  receivedAt: string;
  excerpt: string;
  title: string | null;
  priceCents: number | null;
  soldAt: string;
  orderNumber: string | null;
  externalListingId: string | null;
  sku: string | null;
  /** For an ambiguous match, the items it could be. */
  candidateItemIds: string[];
}

const detailsSchema = z.object({
  reason: z.enum(EMAIL_SALE_TASK_REASONS),
  receivedAt: z.iso.datetime(),
  excerpt: z.string(),
  title: z.string().nullable(),
  priceCents: z.number().int().positive().nullable(),
  soldAt: z.iso.datetime(),
  orderNumber: z.string().nullable(),
  externalListingId: z.string().nullable(),
  sku: z.string().nullable(),
  candidateItemIds: z.array(z.uuid()),
});

const taskPayloadSchema = z.object({
  marketplace: z.enum(['poshmark', 'mercari', 'depop']),
  inboundEventId: z.uuid(),
  emailSale: detailsSchema,
});

export type EmailSaleTaskPayload = z.infer<typeof taskPayloadSchema>;

/** The email sale a task's payload holds, or undefined for a task of another origin. */
export function emailSaleOfTask(payload: unknown): EmailSaleTaskPayload | undefined {
  const parsed = taskPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

export interface EmailSaleToRecord {
  accountId: string;
  marketplace: Marketplace;
  itemId: string;
  /** The item's listing on the marketplace; null records the item's newest one there, if any. */
  listingId: string | null;
  priceCents: number;
  soldAt: Date;
  orderNumber: string | null;
  inboundEventId: string;
}

/**
 * Records the email's sale through the sale intake, in the caller's transaction: the sale,
 * its estimated fees, and its auto-delist. A sale the scheduled check (or another email)
 * recorded already is a duplicate and changes nothing (`recordSale`).
 */
export async function recordEmailSale(
  trx: DbTransaction,
  adapters: AdapterLookup,
  sale: EmailSaleToRecord,
): Promise<RecordSaleResult> {
  return recordSale(
    trx,
    {
      accountId: sale.accountId,
      marketplace: sale.marketplace,
      externalOrderId: sale.orderNumber,
      soldAt: sale.soldAt,
      currency: 'USD',
      // The sold emails Listora reads show the item's price; shipping is the buyer's own line.
      shippingChargedCents: 0,
      detectionSource: 'email',
      inboundEventId: sale.inboundEventId,
      shipBy: null,
      lines: [
        {
          itemId: sale.itemId,
          listingId: sale.listingId,
          quantity: 1,
          priceCents: sale.priceCents,
        },
      ],
    },
    { adapters },
  );
}

/** The item's standing sale on the marketplace (a sale check or another email recorded it). */
export async function standingSaleOf(
  executor: DbExecutor,
  accountId: string,
  marketplace: Marketplace,
  itemId: string,
): Promise<string | undefined> {
  const row = await executor
    .selectFrom('sale_item')
    .innerJoin('sale', (join) =>
      join
        .onRef('sale.account_id', '=', 'sale_item.account_id')
        .onRef('sale.id', '=', 'sale_item.sale_id'),
    )
    .select('sale.id')
    .where('sale_item.account_id', '=', accountId)
    .where('sale_item.marketplace', '=', marketplace)
    .where('sale_item.item_id', '=', itemId)
    .where('sale.status', 'in', STANDING_SALE_STATUSES)
    .executeTakeFirst();
  return row?.id;
}

export interface NewEmailSaleTask {
  kind: 'confirm_sale' | 'review_match';
  accountId: string;
  marketplace: 'poshmark' | 'mercari' | 'depop';
  inboundEventId: string;
  /** The matched item and its listing (a confirm task). */
  itemId: string | null;
  listingId: string | null;
  details: EmailSaleDetails;
}

/**
 * Creates the task and pushes it to the seller's phone: an item may have sold. The caller holds
 * the email's inbound event, so each email makes one task (`user_task_sale_email_key` holds it).
 */
export async function createEmailSaleTask(
  executor: DbExecutor,
  task: NewEmailSaleTask,
): Promise<string> {
  const payload: EmailSaleTaskPayload = {
    marketplace: task.marketplace,
    inboundEventId: task.inboundEventId,
    emailSale: task.details,
  };
  const inserted = await executor
    .insertInto('user_task')
    .values({
      account_id: task.accountId,
      kind: task.kind,
      item_id: task.itemId,
      listing_id: task.listingId,
      urgency: 'urgent',
      payload: jsonb(payload),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const name = MARKETPLACE_NAMES[task.marketplace];
  await enqueuePush(
    executor,
    {
      accountId: task.accountId,
      category: 'sale_email_task',
      title: task.kind === 'confirm_sale' ? `Sold on ${name}?` : `Something sold on ${name}`,
      body:
        task.kind === 'confirm_sale'
          ? `A ${name} sale email says ${task.details.title ?? 'an item'} sold. Confirm it to delist it everywhere else.`
          : `Listora couldn't tell which item a ${name} sale email is about. Pick it to delist it everywhere else.`,
      urgency: 'time_sensitive',
      threadId: null,
      data: { taskId: inserted.id },
    },
    { key: `sale_email_task:${inserted.id}` },
  );
  return inserted.id;
}
