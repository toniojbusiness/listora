import type { ItemScan } from '@listora/api-contract';
import { AiGuardError, type AiClient } from '@listora/ai';
import { ScanFailedError, scanItem, type ThriftScan } from '@listora/analysis';
import { inTransaction } from '@listora/db';
import { isFeatureOn, loadFeatureGate } from '@listora/marketplaces';
import { scanLabelViolations } from '@listora/pricing';
import { assertNever, photoSetHash } from '@listora/shared';
import type { ObjectStorage } from '@listora/storage';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { aiGuardApiError } from '../analyses/guards.ts';
import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import { findItem } from '../items/repository.ts';
import { itemView } from '../items/views.ts';
import type { ListingViewContext } from '../listings/views.ts';
import { assertThriftScanOn, countScan, findRun, lockRun } from '../sourcing-runs/repository.ts';

import { assessScan, scanSales, snappedRead } from './assess.ts';
import {
  answerComparison,
  comparisonAnswerErrors,
  planComparisons,
  startComparisons,
} from './comparisons.ts';
import { decodeScanImages } from './images.ts';
import { keepAsItem } from './keep.ts';
import { PRICE_WAIT_MS } from './pricing.ts';
import {
  findScan,
  insertScan,
  lockScan,
  markReplaced,
  saveDetail,
  scansSince,
  type ScanCallDetail,
  type StoredResearch,
} from './repository.ts';
import { researchWanted } from './research.ts';
import { ScanResearchRunner } from './research-runner.ts';
import { waitForPrices } from './wait.ts';
import { scanAnswer } from './views.ts';

export interface ScanRouteDependencies extends RouteDependencies {
  ai: AiClient;
  /** Photo URLs of a kept scan's item. */
  storage: ObjectStorage;
  /** Each marketplace's capabilities, for the item's listings. */
  connections: ListingViewContext;
  /** Whether scans hand the iPhone marketplace comparison reads (`MARKET_COMPARISONS`). */
  marketComparisons: boolean;
  /** How long a scan's prices wait for what they rest on (`PRICE_WAIT_MS`; tests shorten it). */
  scanPriceWaitMs?: number | undefined;
  now: () => Date;
}

/**
 * Scans an account may make in a day: a guard against a stuck client, far above a trip's
 * hundred or so. Each one is also metered in the daily AI budget.
 */
export const MAX_SCANS_PER_DAY = 300;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The thrift scan (docs/features/thrift-scan.md): `createScan` reads one item at the store
 * with the AI and makes the call from the household's own sales or the AI's labeled estimate;
 * `keepScan` turns a scan the seller is buying into a draft item. Neither ever calls a
 * marketplace: every price comes from Listora's own records or the AI.
 */
export function registerScanRoutes(app: FastifyInstance, deps: ScanRouteDependencies): void {
  const waitMs = deps.scanPriceWaitMs ?? PRICE_WAIT_MS;
  const researcher = new ScanResearchRunner({
    db: deps.db,
    ai: deps.ai,
    logger: app.log,
    now: deps.now,
  });
  // The prices' wait is real seconds since the row's own database timestamps (`created_at`,
  // `research_started_at`), so it runs on the real clock, never the requests' (`deps.now`).
  const realNow = (): Date => new Date();
  const answer = (row: Parameters<typeof scanAnswer>[0]) =>
    checked(scanAnswer(row, realNow(), waitMs));
  // Work that must see the request's change committed (an idempotent POST commits after its
  // handler): the scan's web research, and the wake of a wait for its prices.
  const afterCommit = new WeakMap<FastifyRequest, () => Promise<void>>();
  app.addHook('onResponse', async (request) => {
    const after = afterCommit.get(request);
    if (after === undefined) return;
    afterCommit.delete(request);
    try {
      await after();
    } catch (error) {
      request.log.error({ err: error }, 'scan work after the answer failed');
    }
  });
  app.addHook('onClose', async () => {
    await researcher.drain();
  });

  contractRoute(app, deps, 'createScan', async ({ tenant, db, body, request }) => {
    const started = performance.now();
    const now = deps.now();
    await assertThriftScanOn(db, tenant);
    const decoded = decodeScanImages(body.images);
    if (!decoded.ok) throw validationFailed(decoded.errors);
    const run = await findRun(db, tenant, body.runId);
    if (!run) throw notFound('Run');
    if (run.ended_at !== null) {
      throw new ApiError('invalid_state_transition', 'This run ended. Start a new one to scan.');
    }
    if (body.replacesScanId !== undefined) {
      const replaced = await findScan(db, tenant, body.replacesScanId);
      if (replaced?.run_id !== run.id) {
        throw validationFailed([{ field: 'replacesScanId', message: 'is not a scan of this run' }]);
      }
    }
    if ((await scansSince(db, tenant, new Date(now.getTime() - DAY_MS))) >= MAX_SCANS_PER_DAY) {
      throw new ApiError(
        'rate_limited',
        `That's ${String(MAX_SCANS_PER_DAY)} scans today, the most Listora reads in a day. Try again tomorrow.`,
        { retryAfterSeconds: 60 * 60 },
      );
    }

    const images = decoded.images;
    const note = body.note?.trim();
    let outcome;
    try {
      outcome = await scanItem(deps.ai, {
        accountId: tenant.accountId,
        userId: tenant.userId,
        photoSetHash: photoSetHash(images.map((image) => image.sha256)),
        images: images.map((image) => image.image),
        ...(note === undefined || note === '' ? {} : { note }),
        ...(body.tagText === undefined ? {} : { tagText: body.tagText }),
      });
    } catch (error) {
      throw scanFailure(error, now);
    }
    const sales = await scanSales(db, tenant, now);
    const { read, snappedFrom } = snappedRead(outcome.scan, sales);

    const gate = await loadFeatureGate(db, tenant.accountId);
    const planned = deps.marketComparisons
      ? await planComparisons(db, tenant, read, gate, now)
      : [];
    const detail = await assessScan(db, tenant, read, undefined, now, planned, sales);
    const readMs = Math.round(performance.now() - started);
    let row = await insertScan(db, tenant, {
      runId: run.id,
      imageSha256: images[0]?.sha256 ?? '',
      imageCount: images.length,
      read,
      detail,
      model: outcome.model,
      attempts: outcome.attempts,
      costMicros: outcome.costMicros,
      readMs,
    });
    // The reads for the phone name the scan, so they are written once it is.
    if (planned.some((comparison) => comparison.status === 'checking')) {
      const comparisons = await startComparisons(db, tenant, row.id, planned);
      row = await saveDetail(db, tenant, row.id, { ...detail, comparisons });
    }
    await countScan(db, tenant, run.id, 'scanned');
    if (body.replacesScanId !== undefined) await markReplaced(db, tenant, body.replacesScanId);

    const view = answer(row);
    // The web research starts as soon as the scan is stored, so its prices wait as little as
    // they can; nothing is looked up for a read without a brand.
    if (researchWanted(read)) {
      const scanId = row.id;
      afterCommit.set(request, () => researcher.start(tenant, scanId));
    }
    request.log.info(
      {
        scanId: row.id,
        call: row.call,
        confidence: row.confidence,
        basis: row.basis,
        readMs,
        aiAttempts: outcome.attempts,
        ...(snappedFrom === undefined ? {} : { brandSnapped: true }),
        comparisons: planned.map((comparison) => `${comparison.marketplace}:${comparison.status}`),
        pricing: view.pricing?.status,
      },
      'scan read',
    );
    return { status: 201, body: view };
  });

  // The scan once its prices are in: starts the web research if it is not running (it starts
  // with the read; this asks again after a failure, or for a scan read before a restart), then
  // waits for the research and the comparisons, up to the prices' wait.
  contractRoute(app, deps, 'researchScan', async ({ tenant, db, params, request }) => {
    await assertThriftScanOn(db, tenant);
    const scan = await findScan(db, tenant, params.scanId);
    if (!scan) throw notFound('Scan');
    if (researchWanted(scan.read as unknown as ThriftScan)) await researcher.start(tenant, scan.id);
    // The wait ends when the app gives up on it (its connection closes).
    const gone = new AbortController();
    const abort = (): void => {
      gone.abort();
    };
    const socket = request.raw.socket;
    socket.once('close', abort);
    try {
      const row = await waitForPrices(deps.db, researcher.changes, tenant, scan.id, {
        now: realNow,
        waitMs,
        signal: gone.signal,
      });
      if (!row) throw notFound('Scan');
      return { status: 200, body: answer(row) };
    } finally {
      socket.off('close', abort);
    }
  });

  contractRoute(app, deps, 'saveScanComparison', async ({ tenant, db, params, body, request }) =>
    inTransaction(db, async (trx) => {
      const now = deps.now();
      await assertThriftScanOn(trx, tenant);
      const scan = await lockScan(trx, tenant, params.scanId);
      if (!scan) throw notFound('Scan');
      const stored = scan.call_detail as unknown as ScanCallDetail;
      const gate = await loadFeatureGate(trx, tenant.accountId);
      const comparison = (stored.comparisons ?? []).find(
        (one) => one.comparisonId === params.comparisonId,
      );
      if (comparison === undefined || !isFeatureOn(comparison.marketplace, 'market_comps', gate)) {
        throw notFound('Comparison');
      }
      const invalid = comparisonAnswerErrors(body);
      if (invalid.length > 0) throw validationFailed(invalid);
      const answered = await answerComparison(
        trx,
        tenant,
        scan.id,
        stored.comparisons ?? [],
        params.comparisonId,
        body,
        now,
      );
      if (answered === null) throw notFound('Comparison');
      if (!answered.changed) return { status: 200, body: answer(scan) };
      const research = (scan.research as unknown as StoredResearch | null)?.research;
      const detail = await assessScan(
        trx,
        tenant,
        scan.read as unknown as ThriftScan,
        research,
        now,
        answered.comparisons,
      );
      const row = await saveDetail(trx, tenant, scan.id, detail);
      // A wait for the scan's prices looks again once this answer is committed.
      afterCommit.set(request, () => {
        researcher.changed(scan.id);
        return Promise.resolve();
      });
      request.log.info(
        {
          scanId: row.id,
          marketplace: comparison.marketplace,
          outcome: body.outcome,
          ms: body.ms,
          level: body.stats?.level ?? null,
          forSale: body.stats?.forSale?.count ?? 0,
          ...(body.message === undefined ? {} : { reason: body.message }),
          call: row.call,
          basis: row.basis,
        },
        'scan comparison answered',
      );
      return { status: 200, body: answer(row) };
    }),
  );

  contractRoute(app, deps, 'keepScan', async ({ tenant, db, params }) =>
    inTransaction(db, async (trx) => {
      await assertThriftScanOn(trx, tenant);
      const scan = await lockScan(trx, tenant, params.scanId);
      if (!scan) throw notFound('Scan');
      if (scan.decision === 'kept') {
        const kept = scan.item_id === null ? undefined : await findItem(trx, tenant, scan.item_id);
        if (!kept) {
          throw new ApiError(
            'invalid_state_transition',
            'The item this scan was kept as was deleted.',
          );
        }
        return { status: 200, body: await itemView(trx, tenant, kept, deps) };
      }
      if (scan.decision === 'replaced') {
        throw new ApiError(
          'invalid_state_transition',
          'A later scan of this item replaced this one. Keep that one instead.',
        );
      }
      const run = await lockRun(trx, tenant, scan.run_id);
      if (run?.ended_at !== null || scan.decision === 'skipped') {
        throw new ApiError(
          'invalid_state_transition',
          'This run ended without the item, so it can no longer be kept.',
        );
      }

      const item = await keepAsItem(trx, tenant, scan);
      return { status: 201, body: await itemView(trx, tenant, item, deps) };
    }),
  );
}

/** The answer, held to the label rules: a misleading label is a bug, so it fails the request. */
function checked(view: ItemScan): ItemScan {
  const violations = scanLabelViolations(view);
  if (violations.length > 0) {
    throw new Error(`the scan's answer breaks the label rules: ${violations.join('; ')}`);
  }
  return view;
}

function scanFailure(failure: unknown, now: Date): unknown {
  // A guard that refused the call arrives as the scan failure's cause.
  const error =
    failure instanceof ScanFailedError && failure.cause instanceof AiGuardError
      ? failure.cause
      : failure;
  if (error instanceof AiGuardError) {
    const { reason } = error;
    switch (reason.kind) {
      case 'kill_switch':
        return aiGuardApiError(
          error,
          'Scans are paused right now. Try again in a little while.',
          now,
        );
      case 'account_blocked':
        return aiGuardApiError(error, 'AI is turned off for this account. Contact support.', now);
      case 'daily_budget':
        return aiGuardApiError(
          error,
          "Today's AI budget for this account is used up, so scans wait until tomorrow.",
          now,
        );
      case 'quota':
        return aiGuardApiError(error, "Your plan's AI limit is reached.", now);
      default:
        return assertNever(reason);
    }
  }
  if (error instanceof ScanFailedError) {
    return new ApiError('service_unavailable', "Couldn't read this one. Try again.", {
      cause: error,
    });
  }
  return error;
}
