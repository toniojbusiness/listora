// `npm run infra:synth`: runs the real `cdk synth` CLI for every environment with placeholder
// settings, offline. AWS credentials and configuration are hidden from the CLI, so a stack
// that needs a context lookup (which would call AWS) fails here instead of at deploy time.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ENVIRONMENT_NAMES } from './config.ts';
import { PLACEHOLDER_CONTEXT } from './placeholders.ts';

const infraDir = fileURLToPath(new URL('..', import.meta.url));

const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('AWS_') && !key.startsWith('CDK_')),
);
Object.assign(env, {
  AWS_CONFIG_FILE: '/dev/null',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  AWS_EC2_METADATA_DISABLED: 'true',
});

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
