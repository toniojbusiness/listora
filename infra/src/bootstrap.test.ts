import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CDK_BOOTSTRAP_QUALIFIER, CDK_TOOLKIT_STACK_NAME } from './bootstrap.ts';
import { CDK_JSON } from './test-support.ts';

const cdkJson = CDK_JSON as typeof CDK_JSON & { toolkitStackName?: string };
const script = readFileSync(new URL('../../scripts/deploy-personal.sh', import.meta.url), 'utf8');

describe("Listora's own CDK bootstrap", () => {
  it('is what every cdk command uses (cdk.json), never the default CDKToolkit', () => {
    expect(cdkJson.context['@aws-cdk/core:bootstrapQualifier']).toBe(CDK_BOOTSTRAP_QUALIFIER);
    expect(cdkJson.toolkitStackName).toBe(CDK_TOOLKIT_STACK_NAME);
    expect(CDK_BOOTSTRAP_QUALIFIER).not.toBe('hnb659fds');
    expect(CDK_TOOLKIT_STACK_NAME).not.toBe('CDKToolkit');
    // cdk bootstrap allows lowercase letters and digits, at most 10.
    expect(CDK_BOOTSTRAP_QUALIFIER).toMatch(/^[a-z0-9]{1,10}$/);
  });

  it('is what scripts/deploy-personal.sh checks and bootstraps', () => {
    expect(script).toContain(`readonly qualifier=${CDK_BOOTSTRAP_QUALIFIER}\n`);
    expect(script).toContain(`readonly toolkit=${CDK_TOOLKIT_STACK_NAME}\n`);
    expect(script).toContain('--qualifier $qualifier --toolkit-stack-name $toolkit');
    expect(script).not.toMatch(/--stack-name CDKToolkit\b/);
  });
});
