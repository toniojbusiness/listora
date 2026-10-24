import { describe, expect, it } from 'vitest';

import { ENVIRONMENT_NAMES, loadDeployTarget } from './config.ts';
import { offlineSynthEnvironment, PLACEHOLDER_CONTEXT } from './placeholders.ts';

/** What the deploy job exports to every step, including the offline synth. */
const DEPLOY_JOB_ENV = {
  PATH: '/usr/bin',
  AWS_PROFILE: 'deploy',
  AWS_REGION: 'us-west-2',
  CDK_DEFAULT_ACCOUNT: '444444444444',
  LISTORA_ENV: 'personal',
  LISTORA_AWS_ACCOUNT_ID: '444444444444',
  LISTORA_AWS_REGION: 'us-west-2',
  LISTORA_ALARM_EMAIL: 'ops@example.com',
  LISTORA_AVAILABILITY_ZONES: 'us-west-2a,us-west-2b',
};

describe('offlineSynthEnvironment', () => {
  it('hides AWS, CDK, and Listora deploy variables and keeps the rest', () => {
    expect(offlineSynthEnvironment(DEPLOY_JOB_ENV)).toEqual({
      PATH: '/usr/bin',
      AWS_CONFIG_FILE: '/dev/null',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      AWS_EC2_METADATA_DISABLED: 'true',
    });
  });

  it.each(ENVIRONMENT_NAMES)(
    'leaves only the placeholders to configure %s, whatever the deploy job exports',
    (environment) => {
      const context = PLACEHOLDER_CONTEXT[environment];
      const target = loadDeployTarget(
        (key) => context[key],
        offlineSynthEnvironment(DEPLOY_JOB_ENV),
      );
      expect(target).toMatchObject({
        environment,
        account: context['account'],
        region: context['region'],
        alarmEmail: undefined,
        availabilityZones: undefined,
      });
    },
  );
});
