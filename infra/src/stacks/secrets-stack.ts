import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

import { APP_SECRETS, secretName } from '../config.ts';
import { ListoraStack, removalPolicyFor, type ListoraStackProps } from './common.ts';

/**
 * Keys and secrets. The KMS key wraps the data keys that encrypt marketplace OAuth tokens
 * (envelope encryption, `TOKEN_KMS_KEY_ID`); it rotates yearly and is never deleted by a stack
 * operation, because losing it makes every stored token unreadable. Application secrets are
 * created by name (`listora/<environment>/<name>`, see `APP_SECRETS`) with a placeholder value
 * that the operator replaces; the compute stack references them by that name.
 */
export class SecretsStack extends ListoraStack {
  readonly tokenKey: kms.Key;

  constructor(scope: Construct, id: string, props: ListoraStackProps) {
    super(scope, id, props);
    const { settings, target } = props;

    this.tokenKey = new kms.Key(this, 'TokenKey', {
      alias: `alias/listora-${target.environment}-tokens`,
      description: 'Listora envelope encryption for marketplace OAuth tokens',
      enableKeyRotation: true,
      pendingWindow: Duration.days(30),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    for (const secret of APP_SECRETS) {
      new secretsmanager.Secret(this, `Secret-${secret.name}`, {
        secretName: secretName(target.environment, secret.name),
        description: `${secret.description} Placeholder until set by hand.`,
        removalPolicy: removalPolicyFor(settings),
      });
    }
  }
}
