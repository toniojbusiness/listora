import { describe, expect, it } from 'vitest';

import { KeyedSignals } from './signals.ts';

describe('KeyedSignals', () => {
  it("wakes a key's waits, and keeps a signal that came before the wait", async () => {
    const signals = new KeyedSignals();
    const early = signals.subscribe('item-1');
    signals.signal('item-1');
    expect(await early.wait(10_000)).toBe('signaled');
    early.cancel();

    const later = signals.subscribe('item-1');
    const waiting = later.wait(10_000);
    signals.signal('item-1');
    expect(await waiting).toBe('signaled');
    later.cancel();
  });

  it("times out on another key's signal, and ends on abort", async () => {
    const signals = new KeyedSignals();
    const subscription = signals.subscribe('item-1');
    const waiting = subscription.wait(50);
    signals.signal('item-2');
    expect(await waiting).toBe('timeout');
    const gone = new AbortController();
    const aborted = subscription.wait(10_000, gone.signal);
    gone.abort();
    expect(await aborted).toBe('aborted');
    subscription.cancel();
  });

  it('says whether its source is listening', () => {
    expect(new KeyedSignals().listening).toBe(true);
    expect(new KeyedSignals(() => false).listening).toBe(false);
  });
});
