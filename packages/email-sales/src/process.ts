/**
 * Processing one forwarded email, from either ingest driver. In order:
 *
 * 1. **Whose is it?** The forwarding address it was delivered to names the account
 *    (`sales+<token>@<inbound domain>`); mail to any other address is dropped.
 * 2. **Who sent it?** Its From domain: a marketplace (Poshmark, Mercari, Depop), an email
 *    provider confirming the forwarding, or anyone else (dropped).
 * 3. **Is that true?** SPF and an aligned DKIM signature must pass (authentication.ts). A
 *    marketplace email that fails is stored as a rejected `inbound_event` with the reason and
 *    logged, and nothing else happens: no sale, no task, no sale check.
 * 4. **What does it say?** The marketplace's parser reads it (parsers/): a sale, not a sale
 *    (ignored), or a sold notice in a format Listora does not know (a review task).
 * 5. **Which item?** By listing id, then SKU, then title (match.ts). One item: the sale is
 *    recorded and its auto-delist starts, or, with "ask before auto-delist" on, a confirm task
 *    waits for the seller. Several items: a review task. None: ignored.
 *
 * Each sale email is stored once (`inbound_event`, source `email`, keyed by its Message-ID),
 * with its parsed fields and a short redacted excerpt; it is finished once. A sale an automated
 * check found already is a duplicate (`recordSale`). When the email could not be acted on (an
 * unknown format, an ambiguous match, no match), it asks for an automated sale check at once
 * (`requestSaleCheck`), so the marketplace itself is read without waiting for the schedule.
 */
import { createHash } from 'node:crypto';

import { requestSaleCheck } from '@listora/automation';
import { inTransaction, type Db, type DbTransaction } from '@listora/db';
import type { AdapterLookup } from '@listora/marketplaces';
import { finishInboundEvent, recordInboundEvent } from '@listora/sales';
import type { Logger } from '@listora/shared';

import { tokenOfRecipient } from './address.ts';
import { checkSender } from './authentication.ts';
import type { ReceivedMail } from './drivers/source.ts';
import {
  createEmailSaleTask,
  recordEmailSale,
  standingSaleOf,
  type EmailSaleDetails,
} from './email-sale.ts';
import { readForwardingConfirmation } from './forwarding.ts';
import {
  lockInboxByToken,
  noteInboxEmail,
  saveForwardingConfirmation,
  type SaleEmailInbox,
} from './inbox.ts';
import { matchEmailSale } from './match.ts';
import { headerValues, readMessage, UnreadableMessageError, type MailMessage } from './message.ts';
import { parseSaleEmail, type ParsedSale } from './parsers/index.ts';
import { redactedExcerpt } from './redact.ts';
import { classifySender, type EmailSaleMarketplace } from './senders.ts';

export interface EmailProcessingDependencies {
  db: Db;
  /** The worker's adapters, which a recorded sale's auto-delist decides each delist with. */
  adapters: AdapterLookup;
  logger: Logger;
  /** The forwarding addresses' domain (`EMAIL_INBOUND_DOMAIN`). */
  inboundDomain: string;
  now?: () => Date;
}

export type EmailOutcome =
  /** Not to a forwarding address Listora gave out, or the message cannot be read. */
  | 'undeliverable'
  /** From neither a marketplace nor a known email provider. */
  | 'other_sender'
  /** SPF or DKIM did not pass: never acted on. */
  | 'rejected'
  /** A verified marketplace email that announces no sale. */
  | 'not_a_sale'
  /** The email provider's forwarding confirmation, now shown to the seller. */
  | 'confirmation'
  /** This email was processed before. */
  | 'duplicate'
  /** The sale was recorded and its auto-delist started. */
  | 'recorded'
  /** The sale was recorded before (by a sale check or another email). */
  | 'already_recorded'
  /** A confirm task waits for the seller ("ask before auto-delist"). */
  | 'confirm_task'
  /** A review task waits for the seller (an unknown format or an ambiguous match). */
  | 'review_task'
  /** No Listora listing matches the sale. */
  | 'no_match';

/** Processes one received email; throws only when the database fails (the mail is read again). */
export async function processInboundEmail(
  deps: EmailProcessingDependencies,
  mail: ReceivedMail,
): Promise<EmailOutcome> {
  const log = deps.logger.child({ task: 'email_ingest', mailId: mail.id });
  let message: MailMessage;
  try {
    message = await readMessage(mail.raw);
  } catch (error) {
    if (!(error instanceof UnreadableMessageError)) throw error;
    log.warn({ reason: error.message }, 'unreadable email dropped');
    return 'undeliverable';
  }
  const recipients = mail.envelopeRecipients ?? deliveryRecipients(message);
  const token = recipients
    .map((recipient) => tokenOfRecipient(recipient, deps.inboundDomain))
    .find((found) => found !== undefined);
  if (token === undefined) {
    log.info('email to no forwarding address dropped');
    return 'undeliverable';
  }

  return inTransaction(deps.db, async (trx) => {
    const inbox = await lockInboxByToken(trx, token);
    if (inbox === undefined) {
      log.info('email to an unknown forwarding address dropped');
      return 'undeliverable';
    }
    const accountLog = log.child({ accountId: inbox.accountId });
    const sender =
      message.from === null ? ({ kind: 'other' } as const) : classifySender(message.from.domain);
    const auth = mail.authenticate(message);

    if (sender.kind === 'other') {
      await noteInboxEmail(trx, inbox.accountId, { verifiedMarketplace: false, sale: false });
      accountLog.info(
        { fromDomain: message.from?.domain ?? null },
        'email from no marketplace or email provider dropped',
      );
      return 'other_sender';
    }

    const check = checkSender(auth, sender.domain);
    if (sender.kind === 'provider') {
      await noteInboxEmail(trx, inbox.accountId, { verifiedMarketplace: false, sale: false });
      if (!check.ok) {
        accountLog.warn(
          { fromDomain: sender.domain, reason: check.reason },
          'unverified provider email rejected',
        );
        return 'rejected';
      }
      const confirmation = readForwardingConfirmation(sender, message);
      if (confirmation === null) return 'other_sender';
      await saveForwardingConfirmation(trx, inbox.accountId, confirmation);
      accountLog.info({ provider: confirmation.provider }, 'forwarding confirmation received');
      return 'confirmation';
    }

    const { marketplace } = sender;
    const key = eventKey(message, mail.raw);
    // A rejected email has its own key, so a forged copy can never block the real email.
    const providerEventId = `email:${key}`;
    if (!check.ok) {
      const event = await recordInboundEvent(trx, {
        accountId: inbox.accountId,
        source: 'email',
        marketplace,
        providerEventId: `email-rejected:${key}`,
        signatureOk: false,
        payload: { fromDomain: message.from?.domain ?? null, reason: check.reason },
        externalUserId: null,
      });
      if (event.duplicate) return 'duplicate';
      await finishInboundEvent(
        trx,
        inbox.accountId,
        event.id,
        'failed',
        `Rejected: ${check.reason}`,
      );
      await noteInboxEmail(trx, inbox.accountId, { verifiedMarketplace: false, sale: false });
      accountLog.warn(
        {
          marketplace,
          fromDomain: message.from?.domain ?? null,
          reason: check.reason,
          inboundEventId: event.id,
        },
        'unverified marketplace email rejected',
      );
      return 'rejected';
    }

    const parsed = parseSaleEmail(marketplace, message);
    if (parsed.type === 'not_a_sale') {
      await noteInboxEmail(trx, inbox.accountId, { verifiedMarketplace: true, sale: false });
      return 'not_a_sale';
    }
    const receivedAt = deps.now?.() ?? new Date();
    const soldAt = message.date !== null && message.date < receivedAt ? message.date : receivedAt;
    const excerpt = redactedExcerpt(message.text);
    const event = await recordInboundEvent(trx, {
      accountId: inbox.accountId,
      source: 'email',
      marketplace,
      providerEventId,
      signatureOk: true,
      payload: {
        receivedAt: receivedAt.toISOString(),
        soldAt: soldAt.toISOString(),
        excerpt,
        ...(parsed.type === 'sale'
          ? { sale: { ...parsed.sale } }
          : { unknownFormat: parsed.reason }),
      },
      externalUserId: null,
    });
    if (event.duplicate) return 'duplicate';
    await noteInboxEmail(trx, inbox.accountId, { verifiedMarketplace: true, sale: true });
    const eventLog = accountLog.child({ marketplace, inboundEventId: event.id });

    const details = (
      reason: EmailSaleDetails['reason'],
      sale: ParsedSale | null,
      candidates: string[],
    ) => ({
      reason,
      receivedAt: receivedAt.toISOString(),
      excerpt,
      title: sale?.title ?? null,
      priceCents: sale?.priceCents ?? null,
      soldAt: soldAt.toISOString(),
      orderNumber: sale?.orderNumber ?? null,
      externalListingId: sale?.externalListingId ?? null,
      sku: sale?.sku ?? null,
      candidateItemIds: candidates,
    });

    if (parsed.type === 'unknown_format') {
      await review(trx, inbox, marketplace, event.id, details('unknown_format', null, []));
      eventLog.warn({ reason: parsed.reason }, 'sale email in an unknown format: review task');
      return 'review_task';
    }

    const match = await matchEmailSale(trx, inbox.accountId, marketplace, parsed.sale);
    if (match.type === 'ambiguous') {
      await review(
        trx,
        inbox,
        marketplace,
        event.id,
        details('ambiguous_match', parsed.sale, match.candidateItemIds),
      );
      eventLog.info(
        { candidates: match.candidateItemIds.length },
        'sale email matches several items: review task',
      );
      return 'review_task';
    }
    if (match.type === 'none') {
      await finishInboundEvent(trx, inbox.accountId, event.id, 'ignored');
      await requestSaleCheck(trx, { accountId: inbox.accountId, marketplace });
      eventLog.info('sale email matches no Listora listing');
      return 'no_match';
    }

    if (inbox.askBeforeDelist) {
      const recorded = await standingSaleOf(trx, inbox.accountId, marketplace, match.itemId);
      if (recorded !== undefined) {
        await finishInboundEvent(trx, inbox.accountId, event.id, 'ignored');
        eventLog.info(
          { itemId: match.itemId, saleId: recorded },
          'sale email of a sale recorded before',
        );
        return 'already_recorded';
      }
      await createEmailSaleTask(trx, {
        kind: 'confirm_sale',
        accountId: inbox.accountId,
        marketplace,
        inboundEventId: event.id,
        itemId: match.itemId,
        listingId: match.listing?.id ?? null,
        details: details('ask_before_delist', parsed.sale, []),
      });
      await finishInboundEvent(trx, inbox.accountId, event.id, 'processed');
      eventLog.info(
        { itemId: match.itemId, by: match.by },
        'sale email waits for the seller to confirm',
      );
      return 'confirm_task';
    }

    const sale = await recordEmailSale(trx, deps.adapters, {
      accountId: inbox.accountId,
      marketplace,
      itemId: match.itemId,
      listingId: match.listing?.id ?? null,
      priceCents: parsed.sale.priceCents,
      soldAt,
      orderNumber: parsed.sale.orderNumber,
      inboundEventId: event.id,
    });
    await finishInboundEvent(
      trx,
      inbox.accountId,
      event.id,
      sale.type === 'recorded' ? 'processed' : 'ignored',
    );
    eventLog.info(
      { itemId: match.itemId, by: match.by, outcome: sale.type },
      'sale email processed',
    );
    return sale.type === 'recorded' ? 'recorded' : 'already_recorded';
  });
}

/** A review task for the email, and a sale check, since Listora could not act on the email. */
async function review(
  trx: DbTransaction,
  inbox: SaleEmailInbox,
  marketplace: EmailSaleMarketplace,
  inboundEventId: string,
  details: EmailSaleDetails,
): Promise<void> {
  await createEmailSaleTask(trx, {
    kind: 'review_match',
    accountId: inbox.accountId,
    marketplace,
    inboundEventId,
    itemId: null,
    listingId: null,
    details,
  });
  await finishInboundEvent(trx, inbox.accountId, inboundEventId, 'processed');
  await requestSaleCheck(trx, { accountId: inbox.accountId, marketplace });
}

/** Where the message says it was delivered: the forwarding address, for the folder driver. */
function deliveryRecipients(message: MailMessage): string[] {
  return ['delivered-to', 'x-original-to', 'to', 'cc'].flatMap((name) =>
    headerValues(message, name).flatMap((value) => value.split(',')),
  );
}

/** One key per email: its Message-ID, else its bytes (a forwarded copy keeps the Message-ID). */
function eventKey(message: MailMessage, raw: Uint8Array): string {
  const hash = createHash('sha256');
  if (message.messageId !== null) hash.update(`message-id:${message.messageId}`);
  else hash.update(raw);
  return hash.digest('hex');
}
