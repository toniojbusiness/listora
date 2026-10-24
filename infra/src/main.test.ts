import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const main = fileURLToPath(new URL('main.ts', import.meta.url));

describe('CDK app entry point', () => {
  it('exits 1 and names each missing setting, without a stack trace', () => {
    const result = spawnSync(process.execPath, [main], {
      env: { PATH: process.env['PATH'], LISTORA_AWS_ACCOUNT_ID: 'not-an-account' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid deploy configuration');
    expect(result.stderr).toContain('env (context) or LISTORA_ENV (environment) is required');
    expect(result.stderr).toContain('LISTORA_AWS_ACCOUNT_ID (environment) must be a 12-digit');
    expect(result.stderr).not.toContain('not-an-account');
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });
});
