import { describe, expect, it } from 'vitest';

import { automationProfile } from '../profiles.ts';
import { QUICK_PACING } from '../test-support.ts';
import type { PhoneHost } from './host.ts';
import { PHONE_RUNTIME_VERSION, runPhoneCall, type PhoneCallInput } from './runtime.ts';

/** A host whose page refuses everything, so a call that reaches the page fails there. */
const untouchable = new Proxy({} as PhoneHost, {
  get: (_, method) =>
    method === 'log' || method === 'progress'
      ? () => undefined
      : () => {
          throw new Error(`the runtime called ${String(method)}`);
        },
});

function input(call: PhoneCallInput['call'], readOnly?: boolean): PhoneCallInput {
  const profile = automationProfile('depop');
  return {
    runtimeVersion: PHONE_RUNTIME_VERSION,
    scriptSet: { name: 'depop', marketplace: 'depop', siteUrl: 'https://www.depop.com' },
    call,
    name: call.script,
    origins: [...profile.origins],
    cookieDomains: [...profile.cookieDomains],
    pacing: QUICK_PACING,
    stepTimeoutMs: 1_000,
    callTimeoutMs: 5_000,
    startDelayMs: 0,
    ...(readOnly === undefined ? {} : { readOnly }),
  };
}

describe('the phone runtime on a read-only connection', () => {
  it('refuses every write script before any step runs', async () => {
    for (const script of ['create', 'revise', 'price', 'end', 'relist', 'markSold'] as const) {
      // Only the script's name decides; the runtime never reaches the input.
      const call = { script, op: {} } as unknown as PhoneCallInput['call'];
      expect(await runPhoneCall(input(call, true), untouchable), script).toEqual({
        type: 'ran',
        result: {
          ok: false,
          mutated: false,
          steps: [],
          failure: expect.objectContaining({ kind: 'error', code: 'read_only' }) as unknown,
        },
      });
    }
  });

  it('runs a read as usual', async () => {
    // A read on a read-only connection reaches the page (here, the host that refuses it).
    const read = runPhoneCall(input({ script: 'health' }, true), untouchable);
    await expect(read).resolves.toMatchObject({ type: 'ran', result: { ok: false } });
    const { result } = await read;
    expect(result.ok ? null : result.failure).not.toMatchObject({ code: 'read_only' });
  });
});
