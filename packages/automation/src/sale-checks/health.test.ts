import { describe, expect, it } from 'vitest';

import { AutomationReadError } from '../adapter/automation-adapter.ts';
import {
  saleCheckError,
  saleCheckProblemNotification,
  saleCheckProblemWords,
  type SaleCheckProblem,
} from './health.ts';

const NOW = new Date('2026-10-26T18:00:00Z');
const problem: SaleCheckProblem = {
  connectionId: '0199f3a2-7c4e-7d10-8a55-1b2c3d4e5f60',
  marketplace: 'mercari',
  health: 'failing',
  failuresInARow: 3,
  lastErrorMessage: "Mercari's sold items page has changed, so Listora couldn't read it.",
  lastSucceededAt: new Date('2026-10-26T09:00:00Z'),
  unhealthySince: new Date('2026-10-26T14:00:00Z'),
  runsOn: 'phone',
};

describe('sale-check health words', () => {
  it('names the marketplace and the reason, and what it means for a sale', () => {
    expect(saleCheckProblemWords(problem, NOW)).toEqual({
      title: "Listora can't check Mercari for sales",
      detail:
        "The last 3 checks failed: Mercari's sold items page has changed, so Listora couldn't " +
        'read it. Listora keeps trying. Until it can, a sale on Mercari is not delisted ' +
        'elsewhere automatically.',
    });
  });

  it("says when a check last worked, and asks to open Listora when the phone hasn't run it", () => {
    expect(saleCheckProblemWords({ ...problem, health: 'overdue' }, NOW)).toEqual({
      title: "Listora hasn't checked Mercari for sales in 9 hours",
      detail:
        'Open Listora on your iPhone so it can check. Until it can, a sale on Mercari is not ' +
        'delisted elsewhere automatically.',
    });
    expect(
      saleCheckProblemWords(
        { ...problem, health: 'overdue', runsOn: 'cloud', lastSucceededAt: null },
        NOW,
      ).title,
    ).toBe("Listora hasn't checked Mercari for sales yet");
  });

  it('is a notification that opens Today, one thread per marketplace', () => {
    expect(saleCheckProblemNotification('account-1', problem, NOW)).toMatchObject({
      accountId: 'account-1',
      category: 'sale_checks_need_attention',
      title: "Listora can't check Mercari for sales",
      urgency: 'normal',
      threadId: 'sale_checks:mercari',
      data: { connectionId: problem.connectionId, marketplace: 'mercari' },
    });
  });

  it("words a failed check's code for the seller, never repeating the raw error", () => {
    expect(
      saleCheckError(
        new AutomationReadError('element_missing', 'read the sold items', 'x'),
        'depop',
      ),
    ).toEqual({
      code: 'element_missing',
      message: "Depop's sold items page has changed, so Listora couldn't read it.",
    });
    expect(saleCheckError(new Error('socket hang up at 10.0.0.1'), 'depop')).toEqual({
      code: 'error',
      message: "Listora couldn't read your Depop sales.",
    });
  });
});
