import { describe, expect, it } from 'vitest';

import type { AssistedListingPayload, OperationRequest } from '@listora/marketplaces';

import type { PageDriver, StepRunner } from '../runner/types.ts';
import {
  runScriptCall,
  SELLER_MISMATCH,
  sellerIdentity,
  type AutomationScripts,
  type ScriptCall,
} from './script-call.ts';

const OP = {
  operationId: 'op-1',
  kind: 'price',
  attempt: 1,
} as unknown as OperationRequest<AssistedListingPayload>;

/** Scripts whose health page shows `seen`, recording what ran. */
function scripts(seen: string | null): {
  scripts: AutomationScripts<AssistedListingPayload>;
  ran: string[];
} {
  const ran: string[] = [];
  return {
    ran,
    scripts: {
      read: () => Promise.reject(new Error('not read')),
      health: () => {
        ran.push('health');
        return Promise.resolve(seen);
      },
      price: () => {
        ran.push('price');
        return Promise.resolve({ type: 'applied' });
      },
      answerOffer: () => {
        ran.push('answerOffer');
        return Promise.resolve({ type: 'applied' });
      },
    },
  };
}

const step: StepRunner = (_name, _options, body) =>
  body({} as PageDriver, new AbortController().signal);

const price = (expectedSeller?: string): ScriptCall => ({
  script: 'price',
  op: OP,
  ...(expectedSeller === undefined ? {} : { expectedSeller }),
});

describe('the seller a write expects', () => {
  it('changes nothing when another seller is signed in', async () => {
    const run = scripts('test-shop');
    const result = await runScriptCall(run.scripts, price('live-shop'), step);
    expect(result).toMatchObject({ type: 'rejected', code: SELLER_MISMATCH });
    expect((result as { message: string }).message).toContain('another shop');
    expect(run.ran).toEqual(['health']);

    const answer = await runScriptCall(
      run.scripts,
      {
        script: 'answerOffer',
        request: {} as never,
        expectedSeller: 'live-shop',
      },
      step,
    );
    expect(answer).toMatchObject({ type: 'refused', code: SELLER_MISMATCH });
    expect(run.ran).toEqual(['health', 'health']);
  });

  it('writes when the expected seller is signed in', async () => {
    const run = scripts('live-shop');
    expect(await runScriptCall(run.scripts, price('live-shop'), step)).toEqual({
      type: 'applied',
    });
    expect(run.ran).toEqual(['health', 'price']);
  });

  it("writes as before when Listora doesn't know the seller, or the page doesn't show one", async () => {
    const unknown = scripts('anyone');
    await runScriptCall(unknown.scripts, price(), step);
    expect(unknown.ran).toEqual(['price']);

    const unshown = scripts(null);
    await runScriptCall(unshown.scripts, price('live-shop'), step);
    expect(unshown.ran).toEqual(['health', 'price']);
  });

  it('reads a handle as the id Listora compares', () => {
    expect(sellerIdentity('  Live.Shop ')).toBe('live.shop');
    expect(sellerIdentity('')).toBeNull();
    expect(sellerIdentity('   ')).toBeNull();
    expect(sellerIdentity(null)).toBeNull();
    expect(sellerIdentity('x'.repeat(256))).toBeNull();
  });
});
