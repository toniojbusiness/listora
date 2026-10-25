import { App, type Stack } from 'aws-cdk-lib';
import { readFileSync } from 'node:fs';

import { defineListora, type ListoraStacks } from './app.ts';
import { loadDeployTarget, type DeployTarget, type EnvironmentName } from './config.ts';
import { PLACEHOLDER_CONTEXT } from './placeholders.ts';

/** The committed `cdk.json`: its feature flags and defaults must apply in tests too. */
export const CDK_JSON = JSON.parse(
  readFileSync(new URL('../cdk.json', import.meta.url), 'utf8'),
) as { app: string; context: Record<string, unknown> };

/** Synthesizes one environment in memory, the way `cdk synth` does, with no environment. */
export function synthesize(
  environment: EnvironmentName,
  overrides: Record<string, unknown> = {},
): { app: App; stacks: ListoraStacks; target: DeployTarget } {
  const app = new App({
    context: { ...CDK_JSON.context, ...PLACEHOLDER_CONTEXT[environment], ...overrides },
  });
  const target = loadDeployTarget((key) => app.node.tryGetContext(key), {});
  return { app, stacks: defineListora(app, target), target };
}

/** The stacks of one environment, in definition order. */
export function stackList(stacks: ListoraStacks): Stack[] {
  return Object.values(stacks as unknown as Record<string, Stack | undefined>).filter(
    (stack): stack is Stack => stack !== undefined,
  );
}
