import { describe, expect, it } from 'vitest';

import { AutomationReadError } from '../adapter/automation-adapter.ts';
import { saleCheckError, saleCheckProblemNotification, type SaleCheckProblem } from './health.ts';

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
  it('asks the seller to open Listora when the checks on their iPhone are overdue', () => {
    expect(saleCheckProblemNotification('account-1', { ...problem, health: 'overdue' })).toEqual({
      accountId: 'account-1',
      category: 'sale_checks_need_attention',
      title: 'Open Listora to keep Mercari in sync',
      body:
        'Listora checks your Mercari sales from your iPhone. Open the app so a sale there is ' +
        'delisted everywhere else.',
      urgency: 'normal',
      threadId: 'sale_checks:mercari',
      data: { connectionId: problem.connectionId, marketplace: 'mercari' },
    });
  });

  it("tells the seller nothing about Listora's own problems, which are the owner's to fix", () => {
    expect(saleCheckProblemNotification('account-1', problem)).toBeNull();
    expect(
      saleCheckProblemNotification('account-1', { ...problem, health: 'overdue', runsOn: 'cloud' }),
    ).toBeNull();
  });

  it("words a failed check's code for the seller, never repeating the raw error", () => {
    expect(
      saleCheckError(
        new AutomationReadError('element_missing', 'read the sold items', 'x'),
        'depop',
      ),
    ).toEqual({
      code: 'element_missing',
      message: "Listora couldn't read Depop's sold items page.",
    });
    expect(saleCheckError(new Error('socket hang up at 10.0.0.1'), 'depop')).toEqual({
      code: 'error',
      message: "Listora couldn't read your Depop sales.",
    });
  });
});
