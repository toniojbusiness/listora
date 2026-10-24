// `npm run infra:synth`: runs the real `cdk synth` CLI for every environment with placeholder
// settings, offline. AWS credentials and configuration are hidden from the CLI, so a stack
// that needs a context lookup (which would call AWS) fails here instead of at deploy time, and
// LISTORA_* deploy variables are hidden too, so only the placeholders configure each app.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ENVIRONMENT_NAMES } from './config.ts';
import { offlineSynthEnvironment, PLACEHOLDER_CONTEXT } from './placeholders.ts';

const infraDir = fileURLToPath(new URL('..', import.meta.url));

const env = offlineSynthEnvironment(process.env);

for (const environment of ENVIRONMENT_NAMES) {
  const context = Object.entries(PLACEHOLDER_CONTEXT[environment]).flatMap(([key, value]) => [
    '--context',
    `${key}=${value}`,
  ]);
  const result = spawnSync(
    'npx',
    [
      'cdk',
      'synth',
      '--quiet',
      '--no-notices',
      '--no-version-reporting',
      '--output',
      `cdk.out/${environment}`,
      ...context,
    ],
    { cwd: infraDir, env, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    process.stderr.write(`cdk synth failed for ${environment}\n`);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`cdk synth ok: ${environment}\n`);
}
