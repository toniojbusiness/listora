import { describe, expect, it } from 'vitest';

import { PageBackendError } from '../runner/script-session.ts';
import { BridgeBackend } from './backend.ts';
import type { HostPageState, PhoneHost } from './host.ts';

const LISTING: HostPageState = {
  url: 'https://poshmark.com/listing/abc',
  status: 200,
  retryAfterSeconds: null,
};

/** A host whose page functions answer in turn: an `Error` is thrown, anything else returned. */
function host(answers: unknown[]): PhoneHost & { evaluated: number; settled: number } {
  const fake = {
    evaluated: 0,
    settled: 0,
    evaluate: () => {
      fake.evaluated += 1;
      const next = answers.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    settle: () => {
      fake.settled += 1;
      return Promise.resolve(LISTING);
    },
    state: () => Promise.resolve(LISTING),
    navigate: () => Promise.resolve(LISTING),
    pageData: () => Promise.resolve(null),
    acceptNextDialog: () => Promise.resolve(),
    fetchPhoto: () => Promise.reject(new Error('unused')),
    handOff: () => Promise.resolve('unavailable' as const),
    log: () => undefined,
    progress: () => undefined,
  };
  return fake;
}

describe('BridgeBackend', () => {
  it('reads the page again once a navigation that cut a read short has loaded', async () => {
    const page = host([new Error('navigated'), 2]);
    const backend = new BridgeBackend(page);

    await expect(backend.count('.tile')).resolves.toBe(2);
    expect(page.evaluated).toBe(2);
    expect(page.settled).toBe(1);
    expect(backend.url()).toBe(LISTING.url);
  });

  it("runs a script's own read again after a navigation too", async () => {
    const page = host([new Error('navigated'), { found: true }]);

    await expect(new BridgeBackend(page).read('({ found: true })')).resolves.toEqual({
      found: true,
    });
  });

  it('takes a click the page navigated away from as done, never clicking twice', async () => {
    const page = host([new Error('navigated')]);

    await new BridgeBackend(page).click('button[data-et-name="update"]');
    expect(page.evaluated).toBe(1);
    expect(page.settled).toBe(1);
  });

  it('gives up on a read the page keeps navigating away from once the wait is over', async () => {
    const page = host(Array.from({ length: 1000 }, () => new Error('navigated')));
    const backend = new BridgeBackend(page);
    backend.setTimeout(0);

    const failure = await backend.count('.tile').catch((thrown: unknown) => thrown);
    expect(failure).toBeInstanceOf(PageBackendError);
    expect((failure as PageBackendError).failure).toBe('other');
    expect(page.evaluated).toBe(1);
  });

  it('never repeats an action that changes the page', async () => {
    const page = host([new Error('navigated'), true]);

    await expect(new BridgeBackend(page).fill('input#title', 'Jeans')).rejects.toThrow('navigated');
    expect(page.evaluated).toBe(1);
  });
});
