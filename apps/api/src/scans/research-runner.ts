/**
 * The web research of a scan, started the moment its read lands (docs/features/thrift-scan.md,
 * "Prices after the facts"), so its prices wait as little as they can. A scan's lookup is
 * claimed in its row (`research_started_at`), so of two API tasks, or a read and the app's own
 * ask, only one pays for it; a claim older than `CLAIM_STALE_MS` (its task stopped) can be taken
 * again. A lookup that fails is stored as `failed`: the prices then show without the web, and
 * the next ask tries again. Every lookup this process runs is tracked, so closing the API waits
 * for them instead of cutting them off.
 */
import type { AiClient } from '@listora/ai';
import type { ThriftScan } from '@listora/analysis';
import { inTransaction, KeyedSignals, type Db } from '@listora/db';
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';

import type { Tenant } from '../tenancy.ts';
import { assessScan } from './assess.ts';
import {
  lockScan,
  saveResearch,
  type ItemScanRow,
  type ScanCallDetail,
  type StoredResearch,
} from './repository.ts';
import { researchFor, researchWanted } from './research.ts';

/** A claim this old is of a lookup whose task stopped: it can be claimed again. */
export const CLAIM_STALE_MS = 60_000;

export interface ResearchRunnerDependencies {
  db: Db;
  ai: AiClient;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  now: () => Date;
}

export class ScanResearchRunner {
  readonly #deps: ResearchRunnerDependencies;
  readonly #running = new Map<string, Promise<void>>();
  /** Wakes a wait for a scan's prices when this process saved something of it. */
  readonly changes = new KeyedSignals();

  constructor(deps: ResearchRunnerDependencies) {
    this.#deps = deps;
  }

  /**
   * Starts the scan's lookup unless it needs none, has one, or another one runs: its claim is
   * taken in the row first, so it starts at most once anywhere.
   */
  async start(tenant: Tenant, scanId: string): Promise<void> {
    if (this.#running.has(scanId)) return;
    // Claimed in the row, so a lookup starts at most once anywhere.
    const claimed = await this.#claim(tenant, scanId);
    if (claimed === undefined || this.#running.has(scanId)) return;
    const run = this.#run(tenant, claimed).finally(() => {
      this.#running.delete(scanId);
    });
    this.#running.set(scanId, run);
  }

  /** Signals a change of the scan saved elsewhere (a comparison's answer), once committed. */
  changed(scanId: string): void {
    this.changes.signal(scanId);
  }

  /** Waits for every lookup this process runs. */
  async drain(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running.values()]);
  }

  async #claim(tenant: Tenant, scanId: string): Promise<ItemScanRow | undefined> {
    // On the database's clock, like the row's `created_at` the prices' wait counts from.
    const stale = sql<Date>`now() - make_interval(secs => ${CLAIM_STALE_MS / 1000})`;
    const row = await this.#deps.db
      .updateTable('item_scan')
      .set({ research: null, research_started_at: sql<Date>`now()` })
      .where('account_id', '=', tenant.accountId)
      .where('id', '=', scanId)
      .where((eb) =>
        eb.or([
          eb.and([
            eb('research', 'is', null),
            eb.or([eb('research_started_at', 'is', null), eb('research_started_at', '<', stale)]),
          ]),
          eb(sql<string>`research->>'status'`, '=', 'failed'),
        ]),
      )
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return researchWanted(row.read as unknown as ThriftScan) ? row : undefined;
  }

  async #run(tenant: Tenant, scan: ItemScanRow): Promise<void> {
    const { db, ai, logger, now } = this.#deps;
    const started = performance.now();
    const read = scan.read as unknown as ThriftScan;
    let stored: StoredResearch;
    let found: Awaited<ReturnType<typeof researchFor>> | undefined;
    try {
      found = await researchFor(db, ai, tenant, read, now());
      stored = found.stored;
    } catch (error) {
      // Never thrown on: the prices show without the web, and the next ask tries again.
      logger.warn({ err: error, scanId: scan.id }, 'scan research failed');
      stored = { status: 'failed', cached: false };
    }
    const researchMs = Math.round(performance.now() - started);
    try {
      // Made again under the scan's lock, with the comparisons as they are now: a comparison
      // the phone answered while the research ran is kept.
      const row = await inTransaction(db, async (trx) => {
        const current = await lockScan(trx, tenant, scan.id);
        if (!current) return undefined;
        const detail = await assessScan(
          trx,
          tenant,
          read,
          stored.research,
          now(),
          (current.call_detail as unknown as ScanCallDetail).comparisons ?? [],
        );
        return saveResearch(trx, tenant, scan.id, stored, detail, researchMs);
      });
      logger.info(
        {
          scanId: scan.id,
          status: stored.status,
          cached: stored.cached,
          ...(found === undefined
            ? {}
            : { pulse: found.pulse, searches: found.searches, costMicros: found.costMicros }),
          researchMs,
          ...(row === undefined ? {} : { call: row.call, basis: row.basis }),
        },
        'scan researched',
      );
    } catch (error) {
      logger.error({ err: error, scanId: scan.id }, 'scan research not saved');
    } finally {
      this.changes.signal(scan.id);
    }
  }
}
