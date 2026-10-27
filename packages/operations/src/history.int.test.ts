/**
 * Whether an earlier send may have changed the listing (`mayHaveSentBefore`), read from the
 * results the operation's history recorded: a send that shows it changed nothing lets the next
 * attempt go straight to sending (no lookup first); anything else may have.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { jsonb, type JsonObject, type OperationStatus } from '@listora/db';

import { mayHaveSentBefore } from './history.ts';
import { createEngineHarness, type EngineHarness } from './test-support.ts';
import type { OperationRow } from './transitions.ts';

describe('mayHaveSentBefore (real Postgres)', () => {
  let harness: EngineHarness;

  beforeAll(async () => {
    harness = await createEngineHarness('history');
  });

  afterAll(async () => {
    await harness.close();
  });

  /** A create whose history is exactly `steps`: each a send that started and what it recorded. */
  async function withHistory(
    steps: { start?: JsonObject; recorded?: { to: OperationStatus; detail: JsonObject } }[],
  ): Promise<OperationRow> {
    const listing = await harness.createListing('depop');
    const op = await harness.enqueue(listing, 'create', { status: 'active', title: 'Denim' });
    for (const step of steps) {
      await event(op, 'queued', 'running', step.start ?? { step: 'send', mode: 'automation' });
      if (step.recorded !== undefined) {
        await event(op, 'running', step.recorded.to, step.recorded.detail);
      }
    }
    return op;
  }

  async function event(
    op: OperationRow,
    from: OperationStatus,
    to: OperationStatus,
    detail: JsonObject,
  ): Promise<void> {
    await harness.db
      .insertInto('operation_event')
      .values({
        account_id: op.account_id,
        operation_id: op.id,
        from_status: from,
        to_status: to,
        attempt: 1,
        detail: jsonb(detail),
      })
      .execute();
  }

  const retried = (detail: JsonObject) => ({ to: 'retrying' as const, detail });

  it('knows nothing was sent before the first send', async () => {
    expect(await mayHaveSentBefore(harness.db, await withHistory([]))).toBe(false);
  });

  it('knows a send changed nothing when its script stopped before any step that changes it', async () => {
    const op = await withHistory([
      {
        recorded: retried({
          step: 'send',
          outcome: { type: 'transient', code: 'element_timeout' },
          excerpt: { script: 'create', steps: ['fill in the listing'], mutated: false },
        }),
      },
      // A session that never opened, and a refusal, changed nothing either.
      {
        recorded: retried({
          step: 'send',
          outcome: { type: 'transient', code: 'automation_paced' },
        }),
      },
      { recorded: retried({ step: 'send', outcome: { type: 'rejected', code: 'invalid' } }) },
      // Nor did a step that sent nothing, or whose read before the send decided nothing.
      { recorded: retried({ step: 'send', sent: false }) },
      { recorded: retried({ step: 'send', precheck: { error: 'timeout' } }) },
    ]);
    expect(await mayHaveSentBefore(harness.db, op)).toBe(false);
  });

  it('counts every send that may have reached the marketplace', async () => {
    const cases: JsonObject[] = [
      // The script reached its post step before it stopped.
      {
        step: 'send',
        outcome: { type: 'unknown', code: 'step_timeout' },
        excerpt: { mutated: true },
      },
      // A 5xx can hide an applied change.
      { step: 'send', outcome: { type: 'transient', code: 'server_error' } },
      { step: 'send', outcome: { type: 'confirmed' } },
      // The user's task: they may have done it themselves.
      { step: 'send', outcome: { type: 'pendingUser' } },
      // Recovered after an interruption: nothing recorded what the send did.
      { recovered: true },
    ];
    for (const detail of cases) {
      const op = await withHistory([{ recorded: retried(detail) }]);
      expect(await mayHaveSentBefore(harness.db, op), JSON.stringify(detail)).toBe(true);
    }
  });

  it('counts a send that never recorded its result, and one that changed nothing does not hide it', async () => {
    expect(await mayHaveSentBefore(harness.db, await withHistory([{}]))).toBe(true);
    const op = await withHistory([
      { recorded: retried({ step: 'send', outcome: { type: 'unknown', code: 'aborted' } }) },
      { recorded: retried({ step: 'send', outcome: { type: 'rejected', code: 'invalid' } }) },
    ]);
    expect(await mayHaveSentBefore(harness.db, op)).toBe(true);
  });

  it('reads a send to several listings as changing nothing only when none of them changed', async () => {
    const nothing = { step: 'send', outcome: { type: 'rejected', code: 'not_listed' } };
    const some = { step: 'send', outcome: { type: 'unknown', code: 'step_timeout' } };
    const each = (...targets: JsonObject[]) =>
      withHistory([{ recorded: retried({ step: 'send', targets }) }]);
    expect(await mayHaveSentBefore(harness.db, await each(nothing, nothing))).toBe(false);
    expect(await mayHaveSentBefore(harness.db, await each(nothing, some))).toBe(true);
  });

  it('never counts a verify operation’s check as a send', async () => {
    const op = await withHistory([
      {
        start: { step: 'check', mode: 'automation' },
        recorded: { to: 'verifying', detail: { step: 'check' } },
      },
    ]);
    expect(await mayHaveSentBefore(harness.db, op)).toBe(false);
  });
});
