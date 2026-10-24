import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The iOS TestFlight workflow and scripts/ios-release.sh, which it and `make ios-archive` /
// `make ios-testflight` run. These tests never reach Apple: a stand-in xcodebuild records its
// arguments and fails, so they run on Linux too.

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  if?: string;
  'runs-on'?: string;
  environment?: string;
  permissions?: Record<string, string>;
  env: Record<string, string>;
  steps: Step[];
}

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('.github/workflows/testflight.yml', root), 'utf8');
const workflow = parse(source) as {
  on: Record<string, { inputs: Record<string, { options: string[] }> }>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const job = workflow.jobs['testflight'];
if (job === undefined) throw new Error('testflight.yml has no testflight job');

const CREDENTIALS = [
  'APP_STORE_CONNECT_KEY_ID',
  'APP_STORE_CONNECT_ISSUER_ID',
  'APP_STORE_CONNECT_PRIVATE_KEY',
  'APPLE_TEAM_ID',
] as const;

const stepIndex = (predicate: (step: Step) => boolean, what: string): number => {
  const index = job.steps.findIndex(predicate);
  if (index < 0) throw new Error(`no step ${what}`);
  return index;
};

describe('TestFlight workflow', () => {
  it('runs only when dispatched by hand, never on pushes or pull requests', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on['workflow_dispatch']?.inputs['environment']?.options).toEqual([
      'staging',
      'prod',
    ]);
    const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
    expect(ci).not.toMatch(/testflight|ios-release/);
  });

  it('releases only main, from its own GitHub environment, with read-only repository access', () => {
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job['runs-on']).toMatch(/^macos-/);
    expect(job.environment).toBe('ios-${{ inputs.environment }}');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toBeUndefined();
    expect(source).not.toContain('id-token');
  });

  it('builds the release configuration of the chosen app with the run number as build number', () => {
    expect(job.env['IOS_RELEASE_CONFIGURATION']).toBe(
      "${{ inputs.environment == 'prod' && 'Prod-Release' || 'Staging-Release' }}",
    );
    expect(job.env['IOS_BUILD_NUMBER']).toBe('${{ github.run_number }}');
    const upload = job.steps.find((step) => step.run?.startsWith('make ios-testflight ') === true);
    expect(upload?.run).toBe(
      'make ios-testflight IOS_RELEASE_CONFIGURATION="$IOS_RELEASE_CONFIGURATION" IOS_BUILD_NUMBER="$IOS_BUILD_NUMBER"',
    );
  });

  it('checks the credentials right after checkout, before installing or building anything', () => {
    const check = stepIndex(
      (step) => step.run === 'scripts/ios-release.sh check-credentials',
      'checks the credentials',
    );
    expect(check).toBe(1);
    expect(job.steps[0]?.uses).toMatch(/^actions\/checkout@/);
    expect(check).toBeLessThan(stepIndex((step) => step.run?.includes('brew') === true, 'brew'));
  });

  it('gives the secrets only to the steps that read them', () => {
    expect(JSON.stringify(job.env)).not.toContain('secrets.');
    const withSecrets = job.steps.filter((step) =>
      JSON.stringify(step.env ?? {}).includes('secrets.'),
    );
    expect(withSecrets.map((step) => step.run)).toEqual([
      'scripts/ios-release.sh check-credentials',
      expect.stringMatching(/^make ios-testflight /),
    ]);
    for (const step of withSecrets) {
      expect(step.env).toEqual(
        Object.fromEntries(CREDENTIALS.map((name) => [name, `\${{ secrets.${name} }}`])),
      );
    }
    for (const step of job.steps)
      expect(step.uses === undefined || step.env === undefined).toBe(true);
  });

  it('pins every action to a commit', () => {
    for (const step of job.steps) {
      if (step.uses !== undefined) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});

describe('scripts/ios-release.sh', () => {
  const script = new URL('scripts/ios-release.sh', root).pathname;
  const VALID = {
    APP_STORE_CONNECT_KEY_ID: 'ABC123DEFG',
    APP_STORE_CONNECT_ISSUER_ID: '00000000-1111-2222-3333-444444444444',
    APP_STORE_CONNECT_PRIVATE_KEY:
      // A .p8 file's shape around a body that is not a key (labels split so scanners see no key).
      ['BEGIN', 'END']
        .map((edge) => `-----${edge} ${['PRIVATE', 'KEY'].join(' ')}-----`)
        .join('\nnot-a-real-key\n'),
    APPLE_TEAM_ID: 'ABCDE12345',
  };
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Runs the script with only the given variables plus a stand-in xcodebuild that records its
   * arguments (one per line, calls separated by "--") and a copy of the API key file, then fails.
   */
  const run = (args: string[], env: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'ios-release-test-'));
    dirs.push(dir);
    const record = join(dir, 'xcodebuild-calls');
    writeFileSync(
      join(dir, 'xcodebuild'),
      [
        '#!/usr/bin/env bash',
        `printf '%s\\n' "$@" -- >>'${record}'`,
        'for ((i = 1; i < $#; i++)); do',
        '  if [[ ${!i} == -authenticationKeyPath ]]; then',
        '    next=$((i + 1)); key=${!next}',
        `    printf '%s\\n' "$key" >'${dir}/key-path'`,
        `    ls -l "$key" | cut -c1-10 >'${dir}/key-mode'`,
        `    cp "$key" '${dir}/key-copy'`,
        '  fi',
        'done',
        'echo "xcodebuild stand-in: failing on purpose" >&2',
        'exit 65',
        '',
      ].join('\n'),
    );
    chmodSync(join(dir, 'xcodebuild'), 0o755);
    const result = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env['PATH'] ?? ''}`,
        IOS_BUILD_DIR: join(dir, 'build'),
        ...env,
      },
    });
    const calls = existsSync(record)
      ? readFileSync(record, 'utf8')
          .split('--\n')
          .filter(Boolean)
          .map((call) => call.trimEnd().split('\n'))
      : [];
    const read = (name: string) =>
      existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : undefined;
    return { status: result.status, stderr: result.stderr, stdout: result.stdout, calls, read };
  };

  it('names every missing credential and points to the release guide', () => {
    const result = run(['check-credentials']);
    expect(result.status).toBe(1);
    for (const name of CREDENTIALS) expect(result.stderr).toContain(name);
    expect(result.stderr).toContain('apps/ios/README.md');
  });

  it('names only the missing credentials, as a GitHub error annotation in Actions', () => {
    const partial: Record<string, string> = { ...VALID };
    delete partial['APPLE_TEAM_ID'];
    const result = run(['check-credentials'], { ...partial, GITHUB_ACTIONS: 'true' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /^::error::Missing App Store Connect credentials: APPLE_TEAM_ID\./,
    );
    expect(result.stderr).not.toContain('APP_STORE_CONNECT_KEY_ID');
    expect(result.stderr).not.toContain(VALID.APP_STORE_CONNECT_ISSUER_ID);
  });

  it('accepts complete credentials', () => {
    const result = run(['check-credentials'], VALID);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('credentials are present');
  });

  it('rejects a malformed team id or key without printing the key', () => {
    const team = run(['check-credentials'], { ...VALID, APPLE_TEAM_ID: 'team' });
    expect(team.status).toBe(1);
    expect(team.stderr).toContain('APPLE_TEAM_ID must be the 10-character team id');

    const key = run(['check-credentials'], {
      ...VALID,
      APP_STORE_CONNECT_PRIVATE_KEY: 'secret-value',
    });
    expect(key.status).toBe(1);
    expect(key.stderr).toContain('APP_STORE_CONNECT_PRIVATE_KEY must be the whole contents');
    expect(key.stderr).not.toContain('secret-value');
  });

  it('archives only release configurations with a whole-number build number', () => {
    for (const args of [
      ['archive', 'Dev-Debug'],
      ['archive', 'Release'],
      ['archive', 'Prod-Release', '0'],
      ['archive', 'Prod-Release', '01'],
      ['archive', 'Prod-Release', '1.2'],
      ['archive', 'Prod-Release', 'abc'],
      ['archive'],
    ]) {
      const result = run(args);
      expect(result.status, args.join(' ')).toBe(1);
      expect(result.calls, args.join(' ')).toEqual([]);
    }
  });

  it('archives without signing and fails when xcodebuild fails', () => {
    const result = run(['archive', 'Staging-Release', '7'], VALID);
    expect(result.status).toBe(65);
    expect(result.calls).toHaveLength(1);
    const call = result.calls[0] ?? [];
    expect(call.slice(0, 1)).toEqual(['archive']);
    expect(call).toEqual(expect.arrayContaining(['Staging-Release', 'generic/platform=iOS']));
    expect(call).toContain('CODE_SIGNING_ALLOWED=NO');
    expect(call).toContain('CURRENT_PROJECT_VERSION=7');
    expect(call.join(' ')).not.toMatch(
      /authenticationKey|allowProvisioningUpdates|DEVELOPMENT_TEAM/,
    );
  });

  it('keeps the build number from Base.xcconfig when none is given', () => {
    const result = run(['archive', 'Prod-Release', '']);
    expect(result.calls[0]?.join(' ')).not.toContain('CURRENT_PROJECT_VERSION');
  });

  it('refuses a TestFlight upload without a build number or credentials, before building', () => {
    const noNumber = run(['testflight', 'Prod-Release', ''], VALID);
    expect(noNumber.status).toBe(1);
    expect(noNumber.stderr).toContain('IOS_BUILD_NUMBER=<n>');

    const noCredentials = run(['testflight', 'Prod-Release', '42']);
    expect(noCredentials.status).toBe(1);
    expect(noCredentials.stderr).toContain('Missing App Store Connect credentials');
    for (const result of [noNumber, noCredentials]) expect(result.calls).toEqual([]);
  });

  it('signs with the API key from a private file that is deleted when the run ends, even on failure', () => {
    const result = run(['testflight', 'Prod-Release', '42'], VALID);
    expect(result.status).toBe(65);
    // The archive failed, so nothing was exported or uploaded.
    expect(result.calls).toHaveLength(1);
    const call = result.calls[0] ?? [];
    expect(call).toEqual(
      expect.arrayContaining([
        'archive',
        'Prod-Release',
        '-allowProvisioningUpdates',
        '-authenticationKeyID',
        VALID.APP_STORE_CONNECT_KEY_ID,
        '-authenticationKeyIssuerID',
        VALID.APP_STORE_CONNECT_ISSUER_ID,
        `DEVELOPMENT_TEAM=${VALID.APPLE_TEAM_ID}`,
        'CURRENT_PROJECT_VERSION=42',
      ]),
    );
    expect(call).not.toContain('CODE_SIGNING_ALLOWED=NO');
    expect(result.read('key-copy')).toBe(`${VALID.APP_STORE_CONNECT_PRIVATE_KEY}\n`);
    expect(result.read('key-mode')).toBe('-rw-------\n');
    const keyPath = result.read('key-path')?.trim() ?? '';
    expect(keyPath).toMatch(/AuthKey_ABC123DEFG\.p8$/);
    expect(existsSync(keyPath)).toBe(false);
    expect(result.stdout + result.stderr).not.toContain('not-a-real-key');
  });
});
