import type { EnvironmentName } from './config.ts';

/**
 * Placeholder deploy settings for offline synthesis (tests and `npm run infra:synth`). The
 * accounts are not real and the domains are reserved example names; nothing here can deploy.
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
    domain: 'personal.example.com',
    hostedZoneId: 'Z000000000PERSONAL',
    imageTag: 'synth-check',
  },
};

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
