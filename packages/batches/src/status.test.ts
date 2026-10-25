import { describe, expect, it } from 'vitest';

import { batchProgress, describeBatchItem, type BatchItemFacts } from './status.ts';

const ready = { status: 'ready', failureReason: null } as const;
const processing = { status: 'processing', failureReason: null } as const;

function facts(overrides: Partial<BatchItemFacts> = {}): BatchItemFacts {
  return {
    itemStatus: 'draft',
    submitted: true,
    photos: [ready, ready],
    startError: undefined,
    analysis: { status: 'succeeded', errorCode: null, errorMessage: null, errorRetryable: null },
    ...overrides,
  };
}

describe('describeBatchItem', () => {
  it('shows an item the app has not submitted as uploading', () => {
    expect(describeBatchItem(facts({ submitted: false, photos: [], analysis: undefined }))).toEqual(
      {
        state: 'uploading',
        display: { tone: 'in_progress', label: 'Uploading photos...' },
      },
    );
  });

  it('counts processed photos while the server prepares them', () => {
    expect(describeBatchItem(facts({ photos: [ready, processing, processing] }))).toEqual({
      state: 'preparing_photos',
      display: { tone: 'in_progress', label: 'Preparing photos (1 of 3)...' },
    });
  });

  it('shows analyzing until the analysis of the current photos finishes', () => {
    for (const analysis of [
      undefined,
      { status: 'pending', errorCode: null, errorMessage: null, errorRetryable: null },
      { status: 'running', errorCode: null, errorMessage: null, errorRetryable: null },
    ] as const) {
      expect(describeBatchItem(facts({ analysis })).state).toBe('analyzing');
    }
  });

  it('waits on the seller, never claims success, once the analysis is done', () => {
    expect(describeBatchItem(facts())).toEqual({
      state: 'ready_for_review',
      display: { tone: 'action_needed', label: 'Ready to review' },
    });
  });

  it('calls only a saved item a success', () => {
    for (const itemStatus of ['ready', 'listed', 'sold', 'archived'] as const) {
      expect(describeBatchItem(facts({ itemStatus, photos: [processing] }))).toEqual({
        state: 'saved',
        display: { tone: 'success', label: 'Saved' },
      });
    }
  });

  it("names a failed photo's reason before anything else", () => {
    const photo = { status: 'failed', failureReason: 'This file is not a JPEG.' } as const;
    expect(describeBatchItem(facts({ submitted: false, photos: [ready, photo] }))).toEqual({
      state: 'failed',
      display: {
        tone: 'failed',
        label: 'Photo failed - replace it',
        detail: 'This file is not a JPEG.',
      },
      problem: { code: 'photo_failed', message: 'This file is not a JPEG.', retryable: false },
    });
  });

  it('shows a failed analysis with its reason and whether a retry may help', () => {
    const failed = describeBatchItem(
      facts({
        analysis: {
          status: 'failed',
          errorCode: 'invalid_output',
          errorMessage: 'The AI answer was unreadable twice. Try again.',
          errorRetryable: true,
        },
      }),
    );
    expect(failed).toEqual({
      state: 'failed',
      display: {
        tone: 'failed',
        label: 'Analysis failed - Retry',
        detail: 'The AI answer was unreadable twice. Try again.',
      },
      problem: {
        code: 'invalid_output',
        message: 'The AI answer was unreadable twice. Try again.',
        retryable: true,
      },
    });
    const final = describeBatchItem(
      facts({
        analysis: {
          status: 'failed',
          errorCode: 'photo_set_changed',
          errorMessage: 'Change the photos.',
          errorRetryable: false,
        },
      }),
    );
    expect(final.display.label).toBe('Analysis failed');
  });

  it('pauses on a budget or quota and fails on any other refusal to start', () => {
    const budget = describeBatchItem(
      facts({
        startError: { code: 'ai_budget_exceeded', message: 'Used up.', retryable: true },
        analysis: undefined,
      }),
    );
    expect(budget.state).toBe('failed');
    expect(budget.display).toEqual({
      tone: 'action_needed',
      label: "Paused - today's AI budget is used up",
      detail: 'Used up.',
    });
    const quota = describeBatchItem(
      facts({ startError: { code: 'quota_exceeded', message: 'Plan.', retryable: false } }),
    );
    expect(quota.display.label).toBe("Paused - your plan's limit is reached");
    const blocked = describeBatchItem(
      facts({ startError: { code: 'ai_account_blocked', message: 'Off.', retryable: false } }),
    );
    expect(blocked.display).toEqual({
      tone: 'failed',
      label: "Couldn't start the analysis",
      detail: 'Off.',
    });
  });
});

describe('batchProgress', () => {
  it('counts every state, zero for those no item is in', () => {
    expect(batchProgress(['saved', 'analyzing', 'saved', 'failed'])).toEqual({
      total: 4,
      uploading: 0,
      preparing_photos: 0,
      analyzing: 1,
      ready_for_review: 0,
      saved: 2,
      failed: 1,
    });
  });
});
