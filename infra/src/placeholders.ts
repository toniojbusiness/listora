import { ENVIRONMENT_NAMES, type EnvironmentName } from './config.ts';

/**
 * Placeholder deploy settings for offline synthesis (tests and `npm run infra:synth`). The
 * accounts are not real and the domains are reserved example names; nothing here can deploy.
 * Personal has no domain, as it deploys until one is added (`PLACEHOLDER_SHAPES` adds one).
 */
export const PLACEHOLDER_CONTEXT: Readonly<Record<EnvironmentName, Record<string, string>>> = {
  staging: {
    env: 'staging',
    account: '111111111111',
    region: 'us-east-1',
    domain: 'staging.example.com',
    hostedZoneId: 'Z0000000000STAGING',
    imageTag: 'synth-check',
  },
  prod: {
    env: 'prod',
    account: '222222222222',
    region: 'us-east-1',
    domain: 'example.com',
    hostedZoneId: 'Z00000000000000PROD',
    imageTag: 'synth-check',
  },
  personal: {
    env: 'personal',
    account: '333333333333',
    region: 'us-east-1',
    imageTag: 'synth-check',
    ownerEmail: 'owner@example.com',
  },
};

/** One deployable shape: an environment's placeholders with `overrides` applied. */
export interface PlaceholderShape {
  /** Names the shape's snapshot directory and `cdk.out` subdirectory. */
  readonly name: string;
  readonly environment: EnvironmentName;
  readonly overrides: Readonly<Record<string, string>>;
}

/**
 * Every shape the tests, template snapshots, and `npm run infra:synth` cover: each
 * environment as placed above, plus personal once a domain is added.
 */
export const PLACEHOLDER_SHAPES: readonly PlaceholderShape[] = [
  ...ENVIRONMENT_NAMES.map((environment) => ({ name: environment, environment, overrides: {} })),
  {
    name: 'personal-domain',
    environment: 'personal',
    overrides: { domain: 'personal.example.com', hostedZoneId: 'Z000000000PERSONAL' },
  },
];

/**
 * The process environment for offline synthesis: the caller's, minus every AWS, CDK, and
 * Listora deploy variable, so only the placeholder context configures the app and no AWS
 * credentials or configuration reach the CDK CLI.
 */
export function offlineSynthEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(
        ([key]) =>
          !key.startsWith('AWS_') && !key.startsWith('CDK_') && !key.startsWith('LISTORA_'),
      ),
    ),
    AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_EC2_METADATA_DISABLED: 'true',
  };
}
