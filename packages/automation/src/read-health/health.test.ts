import { describe, expect, it } from 'vitest';

import { AutomationReadError } from '../adapter/automation-adapter.ts';
import {
  readAlertEmail,
  readFailure,
  readFailureReason,
  readProblem,
  type ReadAlert,
} from './health.ts';

const HOUR = 3_600_000;
const SETTINGS = { alertAfterFailures: 3, noSuccessMs: 24 * HOUR };
const NOW = new Date('2026-10-28T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

describe('when a failing read reaches the owner', () => {
  it('never for a read that works or has not failed since it last did', () => {
    expect(
      readProblem(
        { failuresInARow: 0, failingSince: null, lastSucceededAt: hoursAgo(100) },
        NOW,
        SETTINGS,
      ),
    ).toBeNull();
  });

  it('at the third failure in a row, not before', () => {
    const state = { failingSince: hoursAgo(2), lastSucceededAt: hoursAgo(3) };
    expect(readProblem({ ...state, failuresInARow: 2 }, NOW, SETTINGS)).toBeNull();
    expect(readProblem({ ...state, failuresInARow: 3 }, NOW, SETTINGS)).toBe('failures_in_a_row');
    expect(readProblem({ ...state, failuresInARow: 7 }, NOW, SETTINGS)).toBe('failures_in_a_row');
  });

  it('when it has not worked for 24 hours, even after one failure', () => {
    const once = { failuresInARow: 1, failingSince: hoursAgo(1) };
    expect(readProblem({ ...once, lastSucceededAt: hoursAgo(23.9) }, NOW, SETTINGS)).toBeNull();
    expect(readProblem({ ...once, lastSucceededAt: hoursAgo(24) }, NOW, SETTINGS)).toBe(
      'no_success',
    );
  });

  it('for a read that never worked, 24 hours after its first failure', () => {
    const never = { failuresInARow: 2, lastSucceededAt: null };
    expect(readProblem({ ...never, failingSince: hoursAgo(23) }, NOW, SETTINGS)).toBeNull();
    expect(readProblem({ ...never, failingSince: hoursAgo(25) }, NOW, SETTINGS)).toBe('no_success');
  });

  it('counts failures first when both are true', () => {
    expect(
      readProblem(
        { failuresInARow: 5, failingSince: hoursAgo(30), lastSucceededAt: hoursAgo(40) },
        NOW,
        SETTINGS,
      ),
    ).toBe('failures_in_a_row');
  });
});

describe('what a read failure says', () => {
  it("keeps the reader's code, step, and own words", () => {
    const error = new AutomationReadError(
      'element_missing',
      'read the in progress sales',
      "Listora couldn't read sales on Mercari (element_missing).",
      "Mercari's in progress tab has rows that link to no listing.",
    );
    expect(readFailure(error)).toEqual({
      code: 'element_missing',
      step: 'read the in progress sales',
      detail: "Mercari's in progress tab has rows that link to no listing.",
    });
  });

  it("calls Listora's own exception Listora's, with its message", () => {
    expect(readFailure(new TypeError('orders is not iterable'))).toEqual({
      code: 'error',
      step: null,
      detail: 'TypeError: orders is not iterable',
    });
  });

  it('never says a page changed: a missing element does not prove it', () => {
    const words = readFailureReason('element_missing');
    expect(words).toBe(
      "The page did not have what Listora's reader expected. This does not prove the page changed: a page still loading its rows, or a page shape the reader does not handle, fails the same way.",
    );
    for (const code of [
      'element_missing',
      'step_timeout',
      'rate_limited',
      'server_error',
      'unreachable',
      'browser_unavailable',
      'script_error',
      'error',
      'something_new',
    ]) {
      expect(readFailureReason(code)).not.toMatch(/(has|have|may have) changed/i);
    }
  });

  it('says what each code means', () => {
    expect(readFailureReason('step_timeout')).toBe(
      'The step ran out of time before the page had what it waits for.',
    );
    expect(readFailureReason('browser_unavailable')).toBe(
      "Listora's browser did not start, so the marketplace was never asked.",
    );
    expect(readFailureReason('something_new')).toBe(
      'The reader stopped with the code something_new.',
    );
  });
});

describe("the owner's email", () => {
  const alert: ReadAlert = {
    accountId: '0199f3a2-0000-7000-8000-00000000000a',
    connectionId: '0199f3a2-0000-7000-8000-00000000000c',
    marketplace: 'mercari',
    read: 'sale_check',
    reason: 'failures_in_a_row',
    failuresInARow: 7,
    failingSince: new Date('2026-10-27T10:00:00Z'),
    lastSucceededAt: new Date('2026-10-27T06:00:00Z'),
    lastFailedAt: new Date('2026-10-28T11:30:00Z'),
    lastErrorCode: 'element_missing',
    lastErrorStep: 'read the in progress sales',
    lastErrorDetail: "Mercari's in progress tab has rows that link to no listing.",
    connectionStatus: 'connected',
    runsOn: 'phone',
    readOnly: false,
  };

  it('names the marketplace, the read, the step, and the last error', () => {
    expect(readAlertEmail(alert, 'personal', NOW)).toEqual({
      subject: '[Listora personal] Mercari sale check failed 7 times in a row',
      text: [
        'Mercari sale check failed 7 times in a row.',
        '',
        'Marketplace: Mercari',
        'Read: sale check',
        'Step: read the in progress sales',
        'Last error: element_missing',
        "What it means: The page did not have what Listora's reader expected. This does not prove the page changed: a page still loading its rows, or a page shape the reader does not handle, fails the same way.",
        "Reader's words: Mercari's in progress tab has rows that link to no listing.",
        'Failed in a row: 7, since 2026-10-27T10:00:00.000Z',
        'Last failed: 2026-10-28T11:30:00.000Z',
        'Last worked: 2026-10-27T06:00:00.000Z (30 hours ago)',
        '',
        'Account: 0199f3a2-0000-7000-8000-00000000000a',
        'Connection: 0199f3a2-0000-7000-8000-00000000000c (connected, runs on the iPhone)',
        '',
        'The seller is not told: a working connection whose reads fail is for Listora to fix.',
        "Every connection's reads and when each last worked: npm run admin -- read-health --account 0199f3a2-0000-7000-8000-00000000000a",
        '(in AWS: scripts/admin-remote.sh personal -- read-health --account 0199f3a2-0000-7000-8000-00000000000a).',
        'What this alert means and what to do first: docs/features/read-health.md in the Listora repository.',
      ].join('\n'),
    });
  });

  it('says how long a read has not worked, and a read that never did', () => {
    const quiet = readAlertEmail(
      {
        ...alert,
        marketplace: 'depop',
        read: 'listing_import',
        reason: 'no_success',
        failuresInARow: 1,
        failingSince: new Date('2026-10-27T09:00:00Z'),
        lastSucceededAt: null,
        lastErrorCode: 'step_timeout',
        lastErrorStep: null,
        lastErrorDetail: null,
        runsOn: 'cloud',
        readOnly: true,
      },
      'prod',
      NOW,
    );
    expect(quiet.subject).toBe('[Listora prod] Depop listing import has not worked for 27 hours');
    expect(quiet.text).toContain('Step: (before any step ran)');
    expect(quiet.text).toContain(
      'What it means: The step ran out of time before the page had what it waits for.',
    );
    expect(quiet.text).toContain("Reader's words: (none recorded)");
    expect(quiet.text).toContain('Last worked: never');
    expect(quiet.text).toContain('(connected, runs on the cloud, read only)');
  });

  it('says one time, not one times', () => {
    expect(readAlertEmail({ ...alert, failuresInARow: 1 }, 'x', NOW).subject).toBe(
      '[Listora x] Mercari sale check failed 1 time in a row',
    );
  });
});
