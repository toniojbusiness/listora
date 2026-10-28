import { defineConfig } from 'vitest/config';

// Two projects so `npm run check` can report unit and integration results separately.
// Unit tests (`*.test.ts`) need no external services. Integration tests (`*.int.test.ts`)
// run against the real Postgres from `scripts/dev-db.sh` (or TEST_DATABASE_URL when set).
const sources = ['apps/*/src/**', 'packages/*/src/**', 'packages/*/tools/**', 'infra/src/**'];
// Tests run every marketplace feature built, on the fakes; the gate's own tests switch to the
// verified ones (docs/features/verified-features.md).
const setupFiles = ['packages/marketplaces/src/vitest-setup.ts'];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: sources.map((dir) => `${dir}/*.test.ts`),
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
          setupFiles,
        },
      },
      {
        test: {
          name: 'integration',
          include: sources.map((dir) => `${dir}/*.int.test.ts`),
          exclude: ['**/node_modules/**'],
          globalSetup: ['packages/testing/src/integration-setup.ts'],
          setupFiles,
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
    ],
  },
});
