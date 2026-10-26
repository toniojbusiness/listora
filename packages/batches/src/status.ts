/**
 * Where each item of a batch is, in the honest status vocabulary (docs/features/batch.md),
 * worked out from the rows themselves (the item, its photos, its analysis, the batch item) every
 * time it is read, so it can never disagree with them. Pure, so every rule is unit-tested.
 *
 * Only a saved item is `success`: the seller saved it. Anything that waits on Listora is
 * `in_progress`, anything that waits on the seller is `action_needed`, and a failure says why
 * and whether asking again may help.
 */
import type { AnalysisStatus, ItemStatus, PhotoStatus } from '@listora/db';

/** The API contract's `KnownItemBatchItemState`, in the order an item moves through them. */
export const BATCH_ITEM_STATES = [
  'uploading',
  'preparing_photos',
  'analyzing',
  'ready_for_review',
  'saved',
  'failed',
] as const;
export type BatchItemState = (typeof BATCH_ITEM_STATES)[number];

/** How to style a status (the API contract's `KnownStatusTone`). */
export type StatusTone =
  'success' | 'in_progress' | 'checking' | 'failed' | 'action_needed' | 'neutral';

export interface StatusDisplay {
  tone: StatusTone;
  label: string;
  /** Extra context: what went wrong, in words the seller can act on. */
  detail?: string;
}

/** Why an item stopped, and whether asking again (submitting it again) may help. */
export interface BatchItemProblem {
  code: string;
  message: string;
  retryable: boolean;
}

export interface BatchItemFacts {
  itemStatus: ItemStatus;
  /** The app has attached every photo. */
  submitted: boolean;
  /** The item's photos, in display order. */
  photos: readonly { status: PhotoStatus; failureReason: string | null }[];
  /** Why the worker did not start the analysis, if it did not. */
  startError: BatchItemProblem | undefined;
  /** The standard analysis of the item's current photo set, when there is one. */
  analysis:
    | {
        status: AnalysisStatus;
        errorCode: string | null;
        errorMessage: string | null;
        errorRetryable: boolean | null;
      }
    | undefined;
}

export interface BatchItemStatus {
  state: BatchItemState;
  display: StatusDisplay;
  /** Present exactly for `failed`. */
  problem?: BatchItemProblem;
}

const PHOTO_FAILED_MESSAGE = 'A photo could not be processed. Remove or replace it.';

export function describeBatchItem(facts: BatchItemFacts): BatchItemStatus {
  if (facts.itemStatus !== 'draft') {
    return { state: 'saved', display: { tone: 'success', label: 'Saved' } };
  }
  const failedPhoto = facts.photos.find((photo) => photo.status === 'failed');
  if (failedPhoto !== undefined) {
    return failed(
      {
        code: 'photo_failed',
        message: failedPhoto.failureReason ?? PHOTO_FAILED_MESSAGE,
        retryable: false,
      },
      { tone: 'failed', label: 'Photo failed - replace it' },
    );
  }
  if (!facts.submitted) {
    return { state: 'uploading', display: { tone: 'in_progress', label: 'Uploading photos...' } };
  }
  if (facts.startError !== undefined) {
    return failed(facts.startError, startErrorDisplay(facts.startError));
  }
  const ready = facts.photos.filter((photo) => photo.status === 'ready').length;
  if (ready < facts.photos.length) {
    return {
      state: 'preparing_photos',
      display: {
        tone: 'in_progress',
        label: `Preparing photos (${String(ready)} of ${String(facts.photos.length)})...`,
      },
    };
  }
  const { analysis } = facts;
  if (analysis === undefined || analysis.status === 'pending' || analysis.status === 'running') {
    return { state: 'analyzing', display: { tone: 'in_progress', label: 'Analyzing...' } };
  }
  if (analysis.status === 'failed') {
    const retryable = analysis.errorRetryable ?? true;
    return failed(
      {
        code: analysis.errorCode ?? 'analysis_failed',
        message: analysis.errorMessage ?? 'The analysis stopped without a reason. Try again.',
        retryable,
      },
      { tone: 'failed', label: retryable ? 'Analysis failed - Retry' : 'Analysis failed' },
    );
  }
  return {
    state: 'ready_for_review',
    display: { tone: 'action_needed', label: 'Ready to review' },
  };
}

/** A guard that only waits (the day's budget, the plan's limit) pauses; anything else failed. */
function startErrorDisplay(error: BatchItemProblem): StatusDisplay {
  switch (error.code) {
    case 'ai_budget_exceeded':
      return { tone: 'action_needed', label: "Paused - today's AI budget is used up" };
    case 'quota_exceeded':
      return { tone: 'action_needed', label: "Paused - your plan's limit is reached" };
    default:
      return {
        tone: 'failed',
        label: error.retryable
          ? "Couldn't start the analysis - Retry"
          : "Couldn't start the analysis",
      };
  }
}

function failed(problem: BatchItemProblem, display: StatusDisplay): BatchItemStatus {
  return { state: 'failed', display: { ...display, detail: problem.message }, problem };
}

/** How many items of a batch are in each state. */
export type BatchProgress = Record<BatchItemState, number> & { total: number };

export function batchProgress(states: readonly BatchItemState[]): BatchProgress {
  const progress: BatchProgress = {
    total: states.length,
    uploading: 0,
    preparing_photos: 0,
    analyzing: 0,
    ready_for_review: 0,
    saved: 0,
    failed: 0,
  };
  for (const state of states) progress[state] += 1;
  return progress;
}
