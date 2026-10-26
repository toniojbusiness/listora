import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { buildPhoneBundle, PHONE_BUNDLE_PATH } from './bundle.ts';
import { PHONE_RUNTIME_VERSION } from './runtime.ts';

describe("the iPhone app's phone runtime bundle", () => {
  it('is built from this package, so the phone runs the same scripts as the runner', async () => {
    const built = await buildPhoneBundle();
    expect(
      await readFile(PHONE_BUNDLE_PATH, 'utf8'),
      'the bundle is stale: run `npm run phone:bundle`',
    ).toBe(built);
  });

  it('runs in a bare JavaScript context and defines only the runtime', async () => {
    const context: Record<string, unknown> = {};
    runInNewContext(await buildPhoneBundle(), context);
    expect(context['listoraPhone']).toMatchObject({
      runtimeVersion: PHONE_RUNTIME_VERSION,
      run: expect.any(Function) as unknown,
    });
  });
});
