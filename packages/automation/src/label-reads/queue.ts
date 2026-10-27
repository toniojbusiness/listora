/**
 * Label reads for Pack check (docs/features/pack-check.md, "Reading labels"): a read of a
 * marketplace's order pages for the shipping labels of its orders that still need a package,
 * through the seller's own session. `@listora/pack-check` decides which orders a read covers and
 * records what it found; this module asks for the read where the connection's automated steps
 * run. Poshmark, Mercari, and Depop run on the seller's iPhone, so a read waits in `phone_work`
 * (purpose `label_read`, one per connection) for the app, and phone/work.ts runs it.
 *
 * A connection whose steps run in the cloud is not read: no marketplace with a label read may
 * run there today (`cloudAllowed`), and the seller scans those labels instead.
 */
import { inTransaction, type DbExecutor, type Marketplace } from '@listora/db';
import { ordersToRead } from '@listora/pack-check';

/** The marketplaces whose automation adapters read order labels. */
export const LABEL_READ_MARKETPLACES = ['depop', 'poshmark', 'mercari'] as const satisfies readonly Marketplace[];

/** Label reads go with routine changes: a seller packing waits on them. */
const PHONE_LABEL_READ_PRIORITY = 0;

/** What a request for label reads did on one marketplace. */
export interface QueuedLabelRead {
  marketplace: Marketplace;
  /** How many orders the read will look at. */
  orders: number;
  /** `phone`: the read waits for the seller's iPhone; `none`: nothing to read there now. */
  where: 'phone' | 'none';
}

/**
 * Asks for a read of the labels of every automation connection's orders that need one (or only
 * `marketplace`'s), where the connection runs. A read already waiting covers the new orders too:
 * which orders it reads is decided when the phone claims it.
 */
export async function queueLabelReads(
  executor: DbExecutor,
  request: { accountId: string; marketplace?: Marketplace; now: Date },
): Promise<QueuedLabelRead[]> {
  return inTransaction(executor, async (trx) => {
    let query = trx
      .selectFrom('marketplace_connection')
      .select(['id', 'marketplace', 'runs_on'])
      .where('account_id', '=', request.accountId)
      .where('mode', '=', 'automation')
      .where('status', 'in', ['connected', 'degraded'])
      .where('marketplace', 'in', LABEL_READ_MARKETPLACES);
    if (request.marketplace !== undefined) query = query.where('marketplace', '=', request.marketplace);
    const connections = await query.orderBy('marketplace').execute();
    const queued: QueuedLabelRead[] = [];
    for (const connection of connections) {
      const orders = await ordersToRead(trx, request.accountId, connection.marketplace, request.now);
      if (orders.length === 0 || connection.runs_on !== 'phone') {
        queued.push({ marketplace: connection.marketplace, orders: 0, where: 'none' });
        continue;
      }
      await trx
        .insertInto('phone_work')
        .values({
          account_id: request.accountId,
          connection_id: connection.id,
          marketplace: connection.marketplace,
          purpose: 'label_read',
          priority: PHONE_LABEL_READ_PRIORITY,
        })
        .onConflict((conflict) =>
          conflict.columns(['account_id', 'connection_id']).where('purpose', '=', 'label_read').doNothing(),
        )
        .execute();
      queued.push({ marketplace: connection.marketplace, orders: orders.length, where: 'phone' });
    }
    return queued;
  });
}
