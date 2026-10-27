/**
 * Bundles the Lambda handlers (`handler.ts`) and everything they import, the AWS SDK clients
 * included, into one ES module, `index.mjs`, in the directory named by the first argument.
 * Infra runs it while synthesizing (`infra/src/stacks/alerts.ts`), so the deployed code is
 * always this package's source, and the bundle never pins itself to the SDK version a Lambda
 * runtime happens to ship.
 *
 * Usage: node packages/alerts/src/bundle.ts <output directory>
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rolldown } from 'rolldown';

/** The bundle's file name; the functions' handlers are `index.alert` and `index.weeklySummary`. */
export const ALERTS_BUNDLE_FILE = 'index.mjs';

const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));
const ENTRY = fileURLToPath(new URL('./handler.ts', import.meta.url));

export async function buildAlertsBundle(): Promise<string> {
  const bundle = await rolldown({
    input: ENTRY,
    cwd: PACKAGE_DIR,
    platform: 'node',
    logLevel: 'silent',
  });
  try {
    const { output } = await bundle.generate({
      format: 'esm',
      minify: false,
      // The SDK loads its credential providers lazily; Lambda gets one file all the same.
      codeSplitting: false,
    });
    const [chunk, ...rest] = output;
    if (rest.length > 0) throw new Error('the alerts bundle must be one module');
    // Only Node's own modules may stay imports: Lambda has nothing else to resolve them from.
    const external = chunk.imports.filter((name) => !name.startsWith('node:'));
    if (external.length > 0) {
      throw new Error(`the alerts bundle left imports unbundled: ${external.join(', ')}`);
    }
    return chunk.code;
  } finally {
    await bundle.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputDir = process.argv[2];
  if (outputDir === undefined) throw new Error('usage: bundle.ts <output directory>');
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, ALERTS_BUNDLE_FILE), await buildAlertsBundle());
}
