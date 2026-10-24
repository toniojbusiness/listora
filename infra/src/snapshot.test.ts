import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { ENVIRONMENT_NAMES } from './config.ts';
import { stackList, synthesize } from './test-support.ts';

// One CloudFormation template per stack and environment, committed under __snapshots__/ so
// every infrastructure change shows up in review as a template diff. After an intended
// change, refresh them with `npx vitest run --project unit infra -u` and review the diff.
describe.each(ENVIRONMENT_NAMES)('%s templates', (environment) => {
  const { stacks } = synthesize(environment);

  it.each(
    stackList(stacks).map(
      (stack) => [stack.stackName.replace(`listora-${environment}-`, ''), stack] as const,
    ),
  )('%s matches its snapshot', async (name, stack) => {
    const json = `${JSON.stringify(Template.fromStack(stack).toJSON(), null, 2)}\n`;
    await expect(json).toMatchFileSnapshot(`__snapshots__/${environment}/${name}.template.json`);
  });
});
