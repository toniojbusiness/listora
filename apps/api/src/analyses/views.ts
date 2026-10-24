import type { Analysis, AnalysisStatus, AnalysisTier } from '@listora/api-contract';
import { analysisResultOf, findEscalation, type AnalysisRow } from '@listora/analysis';
import type {
  AnalysisStatus as StoredStatus,
  AnalysisTier as StoredTier,
  DbExecutor,
} from '@listora/db';
import { assertNever } from '@listora/shared';

import type { Tenant } from '../tenancy.ts';

/** The contract names the standard tier "fast", after the plan's "Fast" tier. */
export function contractTier(tier: StoredTier): AnalysisTier {
  switch (tier) {
    case 'standard':
      return 'fast';
    case 'premium':
      return 'premium';
    default:
      return assertNever(tier);
  }
}

function contractStatus(status: StoredStatus): AnalysisStatus {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return assertNever(status);
  }
}

/** An analysis as the contract shows it, with the premium analysis that escalates it. */
export async function analysisView(
  db: DbExecutor,
  tenant: Tenant,
  row: AnalysisRow,
): Promise<Analysis> {
  const escalation =
    row.tier === 'standard' ? await findEscalation(db, tenant.accountId, row.id) : undefined;
  const result = analysisResultOf(row);
  return {
    id: row.id,
    itemId: row.item_id,
    photoSetHash: row.photo_set_hash,
    tier: contractTier(row.tier),
    status: contractStatus(row.status),
    ...(result === undefined ? {} : { result }),
    ...(row.status === 'failed'
      ? {
          failure: {
            code: row.error_code ?? 'internal_error',
            message: row.error_message ?? 'The analysis failed.',
            retryable: row.error_retryable ?? true,
          },
        }
      : {}),
    ...(row.escalated_from_analysis_id === null
      ? {}
      : { escalatedFromAnalysisId: row.escalated_from_analysis_id }),
    ...(escalation === undefined ? {} : { escalationAnalysisId: escalation.id }),
    createdAt: row.created_at.toISOString(),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at.toISOString() }),
  };
}
