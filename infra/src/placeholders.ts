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
};
