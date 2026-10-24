import type { AiClient } from '@listora/ai';
import {
  analysisResultOf,
  findAnalysis,
  findItemAnalysis,
  requestAnalysis,
  type AnalysisJobQueue,
} from '@listora/analysis';
import { inTransaction, type InventoryItem } from '@listora/db';
import { photoSetHash } from '@listora/shared';
import type { ObjectStorage } from '@listora/storage';
import type { FastifyInstance } from 'fastify';

import { writeAudit } from '../audit.ts';
import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { ApiError, notFound } from '../errors.ts';
import {
  applyAnalyzedDetails,
  changedDetails,
  columnsFromDetails,
  detailsFromRow,
  provenanceFromRow,
} from '../items/details.ts';
import { lockItem, updateItem } from '../items/repository.ts';
import { assertValidDetails, translateWriteError, versionConflict } from '../items/routes.ts';
import { itemView } from '../items/views.ts';
import { listPhotoRows } from '../photos/repository.ts';
import { assertAnalysisAllowed } from './guards.ts';
import { analysisView } from './views.ts';

export interface AnalysisRouteDependencies extends RouteDependencies {
  ai: AiClient;
  analysisJobs: AnalysisJobQueue;
  /** Photo URLs in the item an applied analysis returns. */
  storage: ObjectStorage;
  now: () => Date;
}

/**
 * Analysis: `startItemAnalysis`, `getAnalysis`, `escalateAnalysis`, `applyAnalysis`.
 * Starting or escalating creates the analysis and its job in one transaction (the worker runs
 * it, @listora/analysis) and answers at once; an analysis that exists for the photo set is
 * returned instead of paying for another. Requests a guard would refuse are refused before
 * anything is queued.
 */
export function registerAnalysisRoutes(
  app: FastifyInstance,
  deps: AnalysisRouteDependencies,
): void {
  contractRoute(app, deps, 'startItemAnalysis', async ({ tenant, db, params }) =>
    inTransaction(db, async (trx) => {
      // The item lock orders this against photo changes and concurrent starts.
      if (!(await lockItem(trx, tenant, params.itemId))) throw notFound('Item');
      const photos = await listPhotoRows(trx, tenant, params.itemId);
      if (photos.length === 0) {
        throw new ApiError(
          'invalid_state_transition',
          'This item has no photos. Add photos, then analyze it.',
        );
      }
      const hash = photoSetHash(
        photos.map((photo) => {
          // The API stores the hash when it attaches a file.
          if (photo.sha256 === null) throw new Error(`photo ${photo.id} has no sha256`);
          return photo.sha256;
        }),
      );
      const key = { itemId: params.itemId, photoSetHash: hash, tier: 'standard' } as const;
      const existing = await findItemAnalysis(trx, tenant.accountId, key);
      if (existing !== undefined && existing.status !== 'failed') {
        return { status: 202, body: await analysisView(trx, tenant, existing) };
      }
      if (photos.some((photo) => photo.status === 'processing')) {
        throw new ApiError(
          'invalid_state_transition',
          'Some photos are still processing. Analyze the item once they are ready.',
        );
      }
      if (photos.some((photo) => photo.status === 'failed')) {
        throw new ApiError(
          'invalid_state_transition',
          'A photo could not be processed. Remove or replace it, then analyze the item.',
        );
      }
      await assertAnalysisAllowed(deps.ai, tenant, 'standard', deps.now());
      const { row } = await requestAnalysis(trx, deps.analysisJobs, {
        accountId: tenant.accountId,
        ...key,
        model: deps.ai.modelFor('standard'),
        requestedByUserId: tenant.userId,
      });
      return { status: 202, body: await analysisView(trx, tenant, row) };
    }),
  );

  contractRoute(app, deps, 'getAnalysis', async ({ tenant, db, params }) => {
    const row = await findAnalysis(db, tenant.accountId, params.analysisId);
    if (!row) throw notFound('Analysis');
    return { status: 200, body: await analysisView(db, tenant, row) };
  });

  contractRoute(app, deps, 'escalateAnalysis', async ({ tenant, db, params }) =>
    inTransaction(db, async (trx) => {
      const source = await findAnalysis(trx, tenant.accountId, params.analysisId);
      if (!source) throw notFound('Analysis');
      if (source.tier === 'premium') {
        throw new ApiError(
          'invalid_state_transition',
          'This analysis already is the premium identification.',
        );
      }
      if (source.status !== 'succeeded') {
        throw new ApiError(
          'invalid_state_transition',
          source.status === 'failed'
            ? 'This analysis failed. Analyze the item again first.'
            : 'This analysis has not completed yet. Try again when it has.',
        );
      }
      // Serializes concurrent escalations of the item's analyses.
      if (!(await lockItem(trx, tenant, source.item_id))) throw notFound('Analysis');
      const key = {
        itemId: source.item_id,
        photoSetHash: source.photo_set_hash,
        tier: 'premium',
      } as const;
      const existing = await findItemAnalysis(trx, tenant.accountId, key);
      if (existing !== undefined && existing.status !== 'failed') {
        return { status: 202, body: await analysisView(trx, tenant, existing) };
      }
      await assertAnalysisAllowed(deps.ai, tenant, 'premium', deps.now());
      const { row } = await requestAnalysis(trx, deps.analysisJobs, {
        accountId: tenant.accountId,
        ...key,
        model: deps.ai.modelFor('premium'),
        requestedByUserId: tenant.userId,
        escalatedFromAnalysisId: source.id,
      });
      return { status: 202, body: await analysisView(trx, tenant, row) };
    }),
  );

  contractRoute(app, deps, 'applyAnalysis', async ({ tenant, db, params, body }) =>
    inTransaction(db, async (trx) => {
      const analysis = await findAnalysis(trx, tenant.accountId, params.analysisId);
      if (!analysis) throw notFound('Analysis');
      const row = await lockItem(trx, tenant, analysis.item_id);
      if (!row) throw notFound('Analysis');
      if (row.version !== body.expectedVersion) throw versionConflict();
      const result = analysisResultOf(analysis);
      if (result === undefined) {
        throw new ApiError(
          'invalid_state_transition',
          analysis.status === 'failed'
            ? 'This analysis failed, so it has nothing to apply.'
            : 'This analysis has not completed yet. Apply it when it has.',
        );
      }

      const before = detailsFromRow(row);
      const applied = applyAnalyzedDetails(
        before,
        provenanceFromRow(row),
        result.details,
        analysis.id,
      );
      await assertValidDetails(trx, tenant, row.id, applied.details);
      const columns = columnsFromDetails(applied.details);
      const changes = changedDetails(before, detailsFromRow({ ...row, ...columns }));
      if (Object.keys(changes).length === 0 && sameProvenance(row, applied.provenance)) {
        return { status: 200, body: await itemView(trx, tenant, row, deps.storage) };
      }

      let updated: InventoryItem | undefined;
      try {
        updated = await updateItem(trx, tenant, row.id, body.expectedVersion, {
          columns,
          status: row.status,
          preArchiveStatus: row.pre_archive_status,
          provenance: applied.provenance,
        });
      } catch (error) {
        throw translateWriteError(error);
      }
      if (!updated) throw versionConflict();
      await writeAudit(trx, tenant, {
        itemId: row.id,
        action: 'item.analysis_applied',
        changes: {
          analysisId: analysis.id,
          fromVersion: row.version,
          toVersion: updated.version,
          ...changes,
        },
      });
      return { status: 200, body: await itemView(trx, tenant, updated, deps.storage) };
    }),
  );
}

function sameProvenance(row: InventoryItem, provenance: Record<string, unknown>): boolean {
  const current = provenanceFromRow(row) as Record<string, unknown>;
  const keys = new Set([...Object.keys(current), ...Object.keys(provenance)]);
  return [...keys].every((key) => current[key] === provenance[key]);
}
