import { describe, expect, it } from 'vitest';

import { OPERATION_STATUSES } from '@listora/db';

import {
  canTransition,
  OPERATION_TRANSITIONS,
  SCHEDULED_STATUSES,
  SETTLED_STATUSES,
  UNFINISHED_STATUSES,
} from './state-machine.ts';

describe('operation state machine', () => {
  it('covers every status the database allows', () => {
    expect(Object.keys(OPERATION_TRANSITIONS).sort()).toEqual([...OPERATION_STATUSES].sort());
    expect([...UNFINISHED_STATUSES, ...SETTLED_STATUSES].sort()).toEqual(
      [...OPERATION_STATUSES].sort(),
    );
  });

  it('reaches succeeded only from a step that can verify, or from the user', () => {
    const into = OPERATION_STATUSES.filter((from) => canTransition(from, 'succeeded'));
    expect(into).toEqual(['running', 'verifying', 'needs_user_action']);
  });

  it('never cancels or retries a step whose request may be in flight', () => {
    for (const status of ['running', 'verifying'] as const) {
      expect(canTransition(status, 'canceled')).toBe(false);
      expect(canTransition(status, 'queued')).toBe(false);
    }
  });

  it('keeps succeeded and canceled final, and lets failed go back only through Retry', () => {
    expect(OPERATION_TRANSITIONS.succeeded).toEqual([]);
    expect(OPERATION_TRANSITIONS.canceled).toEqual([]);
    expect(OPERATION_TRANSITIONS.failed).toEqual(['queued']);
  });

  it('schedules a job exactly for the statuses that wait for a next step', () => {
    expect([...SCHEDULED_STATUSES]).toEqual(['queued', 'retrying', 'verifying']);
  });
});
