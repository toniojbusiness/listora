import { describe, expect, it } from 'vitest';

import { buildAlertsBundle } from './bundle.ts';

// Bundling the AWS SDK takes a few seconds, more on a busy machine.
const BUNDLE_TIMEOUT_MS = 60_000;

describe('the alerts bundle', () => {
  it(
    'is one self-contained module exporting both handlers, the same on every build',
    async () => {
      const first = await buildAlertsBundle();
      expect(first).toMatch(/export \{[^}]*\balert\b[^}]*\}/);
      expect(first).toMatch(/export \{[^}]*\bweeklySummary\b[^}]*\}/);
      // Infra's asset hash is the bundle's content, so it must not depend on the machine.
      expect(first).not.toContain(process.cwd());
      expect(await buildAlertsBundle()).toBe(first);
    },
    BUNDLE_TIMEOUT_MS,
  );
});
