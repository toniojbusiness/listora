/**
 * Each account's sale email inbox (`sale_email_inbox`): its private forwarding address, the
 * "ask before auto-delist" setting, and what the app shows about forwarding (the latest emails,
 * the provider's confirmation). An account gets its address the first time it asks for it.
 */
import { sql } from 'kysely';

import type { DbExecutor } from '@listora/db';

import { newAddressToken } from './address.ts';
import type { ForwardingConfirmation } from './forwarding.ts';

export interface SaleEmailInbox {
  accountId: string;
  addressToken: string;
  askBeforeDelist: boolean;
  lastEmailAt: Date | null;
  lastVerifiedEmailAt: Date | null;
  lastSaleEmailAt: Date | null;
  confirmation: (ForwardingConfirmation & { receivedAt: Date }) | null;
}

const COLUMNS = [
  'account_id',
  'address_token',
  'ask_before_delist',
  'last_email_at',
  'last_verified_email_at',
  'last_sale_email_at',
  'confirmation_provider',
  'confirmation_code',
  'confirmation_url',
  'confirmation_received_at',
] as const;

interface InboxRow {
  account_id: string;
  address_token: string;
  ask_before_delist: boolean;
  last_email_at: Date | null;
  last_verified_email_at: Date | null;
  last_sale_email_at: Date | null;
  confirmation_provider: string | null;
  confirmation_code: string | null;
  confirmation_url: string | null;
  confirmation_received_at: Date | null;
}

function inboxOf(row: InboxRow): SaleEmailInbox {
  return {
    accountId: row.account_id,
    addressToken: row.address_token,
    askBeforeDelist: row.ask_before_delist,
    lastEmailAt: row.last_email_at,
    lastVerifiedEmailAt: row.last_verified_email_at,
    lastSaleEmailAt: row.last_sale_email_at,
    confirmation:
      row.confirmation_provider === null || row.confirmation_received_at === null
        ? null
        : {
            provider: row.confirmation_provider,
            code: row.confirmation_code,
            url: row.confirmation_url,
            receivedAt: row.confirmation_received_at,
          },
  };
}

/** The account's inbox, created with a new address on first use. */
export async function ensureSaleEmailInbox(
  executor: DbExecutor,
  accountId: string,
): Promise<SaleEmailInbox> {
  const existing = await findSaleEmailInbox(executor, accountId);
  if (existing !== undefined) return existing;
  // A token that is taken (about 2^-100 likely) or an inbox made meanwhile: insert nothing.
  await executor
    .insertInto('sale_email_inbox')
    .values({ account_id: accountId, address_token: newAddressToken() })
    .onConflict((conflict) => conflict.doNothing())
    .execute();
  const created = await findSaleEmailInbox(executor, accountId);
  if (created === undefined) return ensureSaleEmailInbox(executor, accountId);
  return created;
}

export async function findSaleEmailInbox(
  executor: DbExecutor,
  accountId: string,
): Promise<SaleEmailInbox | undefined> {
  const row = await executor
    .selectFrom('sale_email_inbox')
    .select(COLUMNS)
    .where('account_id', '=', accountId)
    .executeTakeFirst();
  return row === undefined ? undefined : inboxOf(row);
}

/** The inbox an address token belongs to, locked for the email being processed. */
export async function lockInboxByToken(
  executor: DbExecutor,
  token: string,
): Promise<SaleEmailInbox | undefined> {
  const row = await executor
    .selectFrom('sale_email_inbox')
    .select(COLUMNS)
    .where('address_token', '=', token)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? undefined : inboxOf(row);
}

export async function saveAskBeforeDelist(
  executor: DbExecutor,
  accountId: string,
  askBeforeDelist: boolean,
): Promise<SaleEmailInbox> {
  await ensureSaleEmailInbox(executor, accountId);
  await executor
    .updateTable('sale_email_inbox')
    .set({ ask_before_delist: askBeforeDelist })
    .where('account_id', '=', accountId)
    .execute();
  const saved = await findSaleEmailInbox(executor, accountId);
  if (saved === undefined) throw new Error('the sale email inbox vanished');
  return saved;
}

/** What an email told about forwarding: it arrived, it was a verified marketplace email, a sale. */
export async function noteInboxEmail(
  executor: DbExecutor,
  accountId: string,
  seen: { verifiedMarketplace: boolean; sale: boolean },
): Promise<void> {
  await executor
    .updateTable('sale_email_inbox')
    .set({
      last_email_at: sql<Date>`now()`,
      ...(seen.verifiedMarketplace ? { last_verified_email_at: sql<Date>`now()` } : {}),
      ...(seen.sale ? { last_sale_email_at: sql<Date>`now()` } : {}),
    })
    .where('account_id', '=', accountId)
    .execute();
}

/** Keeps the provider's newest forwarding confirmation, which the app shows until forwarding works. */
export async function saveForwardingConfirmation(
  executor: DbExecutor,
  accountId: string,
  confirmation: ForwardingConfirmation,
): Promise<void> {
  await executor
    .updateTable('sale_email_inbox')
    .set({
      confirmation_provider: confirmation.provider,
      confirmation_code: confirmation.code,
      confirmation_url: confirmation.url,
      confirmation_received_at: sql<Date>`now()`,
    })
    .where('account_id', '=', accountId)
    .execute();
}
