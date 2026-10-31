import type { ItemScan } from '@listora/api-contract';
import { AiGuardError, type AiClient } from '@listora/ai';
import {
  ScanFailedError,
  scanItem,
  ScanResearchFailedError,
  type ThriftScan,
} from '@listora/analysis';
import { inTransaction } from '@listora/db';
import { scanLabelViolations } from '@listora/pricing';
import { assertNever, photoSetHash } from '@listora/shared';
import type { ObjectStorage } from '@listora/storage';
import type { FastifyInstance } from 'fastify';

import { aiGuardApiError } from '../analyses/guards.ts';
import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import { findItem } from '../items/repository.ts';
import { itemView } from '../items/views.ts';
import type { ListingViewContext } from '../listings/views.ts';
import { assertThriftScanOn, countScan, findRun, lockRun } from '../sourcing-runs/repository.ts';

import { assessScan } from './assess.ts';
import { decodeScanImages } from './images.ts';
import { keepAsItem } from './keep.ts';
import {
  findScan,
  insertScan,
  lockScan,
  markReplaced,
  saveResearch,
  scansSince,
} from './repository.ts';
import { researchFor } from './research.ts';
import { scanView } from './views.ts';

export interface ScanRouteDependencies extends RouteDependencies {
  ai: AiClient;
  /** Photo URLs of a kept scan's item. */
  storage: ObjectStorage;
  /** Each marketplace's capabilities, for the item's listings. */
  connections: ListingViewContext;
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
    const read = outcome.scan;

    const detail = await assessScan(db, tenant, read, undefined, now);
    const readMs = Math.round(performance.now() - started);
    const row = await insertScan(db, tenant, {
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
    await countScan(db, tenant, run.id, 'scanned');
    if (body.replacesScanId !== undefined) await markReplaced(db, tenant, body.replacesScanId);

    const view = checked(scanView(row));
    request.log.info(
      {
        scanId: row.id,
        call: row.call,
        confidence: row.confidence,
        basis: row.basis,
        readMs,
        aiAttempts: outcome.attempts,
      },
      'scan read',
    );
    return { status: 201, body: view };
  });

  contractRoute(app, deps, 'researchScan', async ({ tenant, db, params, request }) => {
    const started = performance.now();
    const now = deps.now();
    await assertThriftScanOn(db, tenant);
    const scan = await findScan(db, tenant, params.scanId);
    if (!scan) throw notFound('Scan');
    if (scan.research !== null) return { status: 200, body: checked(scanView(scan)) };
    const read = scan.read as unknown as ThriftScan;
    let found;
    try {
      found = await researchFor(db, deps.ai, tenant, read, now);
    } catch (error) {
      throw scanFailure(error, now);
    }
    const detail = await assessScan(db, tenant, read, found.stored.research, now);
    const researchMs = Math.round(performance.now() - started);
    const row = await saveResearch(db, tenant, scan.id, found.stored, detail, researchMs);
    request.log.info(
      {
        scanId: row.id,
        status: found.stored.status,
        cached: found.stored.cached,
        researchMs,
        searches: found.searches,
        costMicros: found.costMicros,
        call: row.call,
        basis: row.basis,
      },
      'scan researched',
    );
    return { status: 200, body: checked(scanView(row)) };
  });

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
    (failure instanceof ScanFailedError || failure instanceof ScanResearchFailedError) &&
    failure.cause instanceof AiGuardError
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
  if (error instanceof ScanResearchFailedError) {
    return new ApiError('service_unavailable', "Couldn't look it up on the web just now.", {
      cause: error,
    });
  }
  return error;
}
