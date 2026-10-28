import { describe, expect, it } from 'vitest';

import type { OperationRow } from '../listings/repository.ts';
import { operationView } from './views.ts';

const AT = new Date('2026-10-26T08:00:00Z');

describe('operationView', () => {
  it('offers Retry for a delist the marketplace refused, never for content Listora refused', () => {
    const listing = {
      item_id: '0199f0b4-0000-7000-8000-0000000000bb',
      marketplace: 'poshmark' as const,
    };
    const refusedDelist = operationView(
      operation({
        kind: 'end',
        status: 'failed',
        error_code: 'validation_failed',
        error_message: "Poshmark: This listing can't be changed right now.",
      }),
      listing,
    );
    expect(refusedDelist.error).toMatchObject({ code: 'validation_failed', retryable: true });

    const refusedContent = operationView(
      operation({
        kind: 'create',
        status: 'failed',
        error_code: 'validation_failed',
        error_message: 'Poshmark needs a size for Men’s Shirts. Fix it, then try again.',
        content: {},
      }),
      listing,
    );
    expect(refusedContent.error).toMatchObject({ code: 'validation_failed', retryable: false });
  });
});

function operation(overrides: Partial<OperationRow> = {}): OperationRow {
  return {
    id: '0199f0b4-0000-7000-8000-0000000000cc',
    account_id: '0199f0b4-0000-7000-8000-0000000000aa',
    listing_id: '0199f0b4-0000-7000-8000-000000000001',
    kind: 'create',
    idempotency_key: 'k',
    desired: { status: 'active' },
    status: 'queued',
    success_evidence: null,
    attempts: 1,
    next_attempt_at: null,
    error_code: null,
    error_message: null,
    origin: 'user',
    delist_run_id: null,
    deleted_listing_id: null,
    created_at: AT,
    updated_at: AT,
    content: null,
    ...overrides,
  };
}
