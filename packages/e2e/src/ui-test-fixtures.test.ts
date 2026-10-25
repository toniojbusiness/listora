import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fakeFixtureSchema } from '@listora/ai';
import { ITEM_ANALYSIS_OUTPUT_NAME, itemAnalysisSchema } from '@listora/analysis';
import { describe, expect, it } from 'vitest';

/** The fake AI answers the iOS UI tests' stack serves (`make ios-test`). */
const UI_TEST_FIXTURES = fileURLToPath(
  new URL('../../../apps/ios/ListoraUITests/FakeAI/', import.meta.url),
);

describe("the iOS UI tests' fake AI fixtures", () => {
  it('are valid fixtures whose item analysis the analysis schema accepts', async () => {
    const files = (await readdir(UI_TEST_FIXTURES)).filter((file) => file.endsWith('.json'));
    expect(files).toContain('default.json');
    for (const file of files) {
      const fixture = fakeFixtureSchema.parse(
        JSON.parse(await readFile(join(UI_TEST_FIXTURES, file), 'utf8')),
      );
      const answer = fixture.outputs?.[ITEM_ANALYSIS_OUTPUT_NAME];
      const parsed = itemAnalysisSchema.safeParse(answer);
      expect(parsed.success, `${file}: ${parsed.error?.message ?? ''}`).toBe(true);
    }
  });
});
