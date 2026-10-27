/**
 * The seller's answer to an import's question (docs/features/imports.md): a listing that may be
 * an item Listora has is that item (`same_item`, one of the items it was asked about), an item of
 * its own (`new_item`, which the worker imports with its photos), or not imported (`skip`).
 */
import { sql } from 'kysely';

import { queueImportApply } from '@listora/automation';
import { inTransaction, jsonb, type DbExecutor } from '@listora/db';
import { syncItemListedStatus } from '@listora/operations';

import { insertListing, recount, settle } from './apply.ts';
import { listedListing } from './read-entry.ts';

export type ImportAnswer =
  { answer: 'same_item'; itemId: string } | { answer: 'new_item' } | { answer: 'skip' };

export type AnswerRefusal = 'not_found' | 'answered' | 'not_a_candidate' | 'listed_there';

export class AnswerRefusedError extends Error {
  readonly code: AnswerRefusal;

  constructor(code: AnswerRefusal, message: string) {
    super(message);
    this.name = 'AnswerRefusedError';
    this.code = code;
  }
}

/** Applies the seller's answer to the entry's question. */
export async function answerImportQuestion(
  executor: DbExecutor,
  question: { accountId: string; userId: string; importId: string; entryId: string },
  answer: ImportAnswer,
): Promise<void> {
  await inTransaction(executor, async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`listing_import:${question.accountId}`}, 0))`.execute(
      trx,
    );
    const entry = await trx
      .selectFrom('listing_import_entry')
      .selectAll()
      .where('account_id', '=', question.accountId)
      .where('import_id', '=', question.importId)
      .where('id', '=', question.entryId)
      .forUpdate()
      .executeTakeFirst();
    if (entry === undefined)
      throw new AnswerRefusedError('not_found', 'There is no such question.');
    if (entry.outcome !== 'needs_you') {
      throw new AnswerRefusedError('answered', 'This question is already answered.');
    }
    switch (answer.answer) {
      case 'skip':
        await settle(trx, entry, 'skipped');
        return;
      case 'new_item': {
        // Back to the worker, which imports it as an item of its own, with its photos.
        await trx
          .updateTable('listing_import_entry')
          .set({ outcome: 'pending', settled_at: null, new_item: true, candidates: jsonb([]) })
          .where('account_id', '=', entry.account_id)
          .where('id', '=', entry.id)
          .execute();
        await trx
          .updateTable('listing_import')
          .set({ status: 'importing', finished_at: null })
          .where('account_id', '=', entry.account_id)
          .where('id', '=', entry.import_id)
          .where('status', '=', 'finished')
          .execute();
        await queueImportApply(trx, { accountId: entry.account_id, importId: entry.import_id });
        await recount(trx, entry);
        return;
      }
      case 'same_item': {
        const candidates = (entry.candidates as { itemId?: unknown }[]).map(
          (candidate) => candidate.itemId,
        );
        if (!candidates.includes(answer.itemId)) {
          throw new AnswerRefusedError(
            'not_a_candidate',
            'Choose one of the items Listora asked about.',
          );
        }
        const listing = listedListing(entry.listing);
        if (listing === null) {
          await settle(trx, entry, 'failed', {
            error: "Listora couldn't read this listing's details.",
          });
          return;
        }
        const listingId = await insertListing(trx, entry, listing, answer.itemId);
        if (listingId === null) {
          throw new AnswerRefusedError(
            'listed_there',
            'That item is already listed there. Choose another, or import it as a new item.',
          );
        }
        await syncItemListedStatus(trx, entry.account_id, answer.itemId);
        await trx
          .insertInto('audit_log')
          .values({
            account_id: entry.account_id,
            item_id: answer.itemId,
            actor_kind: 'user',
            actor_user_id: question.userId,
            action: 'listing.imported',
            changes: jsonb({
              marketplace: entry.marketplace,
              externalListingId: entry.external_listing_id,
              importId: entry.import_id,
              match: 'seller',
            }),
          })
          .execute();
        await settle(trx, entry, 'merged', {
          itemId: answer.itemId,
          listingId,
          match: 'seller',
        });
        return;
      }
    }
  });
}
