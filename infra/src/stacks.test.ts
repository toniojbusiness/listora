import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { APP_SECRETS, ENVIRONMENT_NAMES, ENVIRONMENT_SETTINGS, SERVICE_NAMES } from './config.ts';
import { containerEnvironment, containerSecretNames, MIGRATE_COMMAND } from './containers.ts';
import type { ListoraStacks } from './app.ts';
import { migrateTaskNames } from './stacks/migrate-stack.ts';
import { stackList, synthesize } from './test-support.ts';

type Resource = { Type: string; Properties?: Record<string, unknown> } & Record<string, unknown>;

const synthesized = Object.fromEntries(
  ENVIRONMENT_NAMES.map((environment) => [environment, synthesize(environment)]),
) as Record<(typeof ENVIRONMENT_NAMES)[number], ReturnType<typeof synthesize>>;

function template(environment: (typeof ENVIRONMENT_NAMES)[number], stack: keyof ListoraStacks) {
  return Template.fromStack(synthesized[environment].stacks[stack]);
}

function resources(t: Template, type: string): Resource[] {
  return Object.values(t.findResources(type)) as Resource[];
}

/** Every IAM statement in a template, from inline policies and managed policies alike. */
function statements(t: Template): Record<string, unknown>[] {
  return [...resources(t, 'AWS::IAM::Policy'), ...resources(t, 'AWS::IAM::ManagedPolicy')].flatMap(
    (policy) =>
      (policy.Properties?.['PolicyDocument'] as { Statement: Record<string, unknown>[] }).Statement,
  );
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

describe.each(ENVIRONMENT_NAMES)('%s', (environment) => {
  const settings = ENVIRONMENT_SETTINGS[environment];
  const { stacks, target } = synthesized[environment];

  it('deploys every stack to the target account and region, protected in prod', () => {
    for (const stack of stackList(stacks)) {
      expect(stack.account).toBe(target.account);
      expect(stack.region).toBe(target.region);
      expect(stack.stackName).toMatch(new RegExp(`^listora-${environment}-[a-z-]+$`));
      expect(stack.terminationProtection).toBe(environment === 'prod');
      expect(stack.tags.tagValues()).toEqual({ project: 'listora', environment });
    }
  });

  describe('network', () => {
    const t = template(environment, 'network');

    it('spans two zones with public, app (NAT egress), and isolated data subnets', () => {
      t.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: settings.network.cidr });
      t.resourceCountIs('AWS::EC2::Subnet', 6);
      t.resourceCountIs('AWS::EC2::NatGateway', settings.network.natGateways);
      t.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        VpcEndpointType: 'Gateway',
        ServiceName: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
      });
      t.hasResourceProperties('AWS::EC2::FlowLog', { TrafficType: 'REJECT' });
    });

    it('gives the isolated data subnets no route out of the VPC', () => {
      const routes = resources(t, 'AWS::EC2::Route');
      const dataTables = Object.entries(t.findResources('AWS::EC2::RouteTable'))
        .filter(([id]) => id.startsWith('Vpcdata'))
        .map(([id]) => id);
      expect(dataTables).toHaveLength(2);
      for (const route of routes) {
        const table = (route.Properties?.['RouteTableId'] as { Ref: string }).Ref;
        expect(dataTables).not.toContain(table);
      }
    });

    it('opens only the load balancer to the internet, and the database only to the tasks', () => {
      const groups = t.findResources('AWS::EC2::SecurityGroup');
      const groupId = (prefix: string) => {
        const id = Object.keys(groups).find((key) => key.startsWith(prefix));
        if (id === undefined) throw new Error(`no ${prefix} security group`);
        return id;
      };
      const [lb, api, worker, db] = [
        'LoadBalancerSecurityGroup',
        'ApiSecurityGroup',
        'WorkerSecurityGroup',
        'DatabaseSecurityGroup',
      ].map(groupId);

      const inline = Object.entries(groups).flatMap(([id, group]) =>
        asList((group as Resource).Properties?.['SecurityGroupIngress'] ?? []).map((rule) => ({
          id,
          rule: rule as Record<string, unknown>,
        })),
      );
      const open = inline.filter(({ rule }) => rule['CidrIp'] === '0.0.0.0/0');
      expect(open.map(({ id, rule }) => [id, rule['FromPort']])).toEqual([
        [lb, 443],
        [lb, 80],
      ]);

      const ingress = resources(t, 'AWS::EC2::SecurityGroupIngress').map(
        (rule) => rule.Properties ?? {},
      );
      const into = (group: string | undefined) =>
        ingress.filter(
          (rule) => (rule['GroupId'] as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0] === group,
        );
      expect(
        into(db).map((rule) => [
          (rule['SourceSecurityGroupId'] as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0],
          rule['FromPort'],
          rule['ToPort'],
        ]),
      ).toEqual([
        [api, 5432, 5432],
        [worker, 5432, 5432],
      ]);
      expect(into(worker)).toEqual([]);
      expect(into(api).map((rule) => rule['FromPort'])).toEqual([3000]);
    });
  });

  describe('data', () => {
    const t = template(environment, 'data');

    it('runs encrypted, private PostgreSQL 18 with backups and per-environment redundancy', () => {
      t.hasResource('AWS::RDS::DBInstance', {
        DeletionPolicy: 'Snapshot',
        UpdateReplacePolicy: 'Snapshot',
        Properties: Match.objectLike({
          Engine: 'postgres',
          EngineVersion: '18',
          DBInstanceClass: `db.${settings.database.instanceType}`,
          StorageEncrypted: true,
          PubliclyAccessible: false,
          MultiAZ: settings.database.multiAz,
          DeletionProtection: settings.protectData,
          BackupRetentionPeriod: settings.database.backupRetentionDays,
          EnableCloudwatchLogsExports: ['postgresql'],
          AllowMajorVersionUpgrade: false,
        }),
      });
      t.hasResourceProperties('AWS::RDS::DBParameterGroup', {
        Parameters: Match.objectLike({ 'rds.force_ssl': '1' }),
      });
      t.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: `listora/${environment}/database`,
      });
      t.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: `/aws/rds/instance/listora-${environment}/postgresql`,
        RetentionInDays: settings.logRetention,
      });
    });
  });

  describe('storage', () => {
    const t = template(environment, 'storage');

    it('keeps the photo bucket private, encrypted, versioned, TLS-only, and retained', () => {
      t.hasResource('AWS::S3::Bucket', {
        DeletionPolicy: 'Retain',
        Properties: Match.objectLike({
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
          BucketEncryption: Match.objectLike({}),
          VersioningConfiguration: { Status: 'Enabled' },
          LifecycleConfiguration: {
            Rules: [
              Match.objectLike({ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }),
              Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 30 } }),
            ],
          },
        }),
      });
      t.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
          ]),
        },
      });
    });

    it('serves only public/ objects, over HTTPS, read-only, through origin access control', () => {
      t.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          Origins: [
            Match.objectLike({
              OriginPath: '/public',
              OriginAccessControlId: Match.anyValue(),
              S3OriginConfig: { OriginAccessIdentity: '' },
            }),
          ],
          DefaultCacheBehavior: Match.objectLike({
            ViewerProtocolPolicy: 'https-only',
            AllowedMethods: ['GET', 'HEAD'],
          }),
        }),
      });
      t.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: 's3:GetObject',
              Principal: { Service: 'cloudfront.amazonaws.com' },
              Condition: { StringEquals: { 'AWS:SourceArn': Match.anyValue() } },
            }),
          ]),
        },
      });
      // No list permission: a missing key answers 403 exactly like a forbidden one.
      const allowed = resources(t, 'AWS::S3::BucketPolicy').flatMap((policy) =>
        (
          policy.Properties?.['PolicyDocument'] as { Statement: Record<string, unknown>[] }
        ).Statement.filter((statement) => statement['Effect'] === 'Allow'),
      );
      expect(allowed.flatMap((statement) => asList(statement['Action']))).toEqual(['s3:GetObject']);
    });
  });

  describe('email', () => {
    const t = template(environment, 'email');

    it('receives in.<domain> mail into a private bucket, scanned, over TLS', () => {
      t.hasResourceProperties('AWS::Route53::RecordSet', {
        Name: `in.${target.domain}.`,
        Type: 'MX',
        ResourceRecords: [`10 inbound-smtp.${target.region}.amazonaws.com`],
      });
      t.hasResourceProperties('AWS::SES::ReceiptRuleSet', {
        RuleSetName: `listora-${environment}`,
      });
      t.hasResourceProperties('AWS::SES::ReceiptRule', {
        Rule: Match.objectLike({
          Enabled: true,
          Recipients: [`in.${target.domain}`],
          ScanEnabled: true,
          TlsPolicy: 'Require',
          Actions: [{ S3Action: Match.objectLike({ ObjectKeyPrefix: 'inbound/' }) }],
        }),
      });
      t.hasResourceProperties('AWS::SES::EmailIdentity', {
        EmailIdentity: target.domain,
      });
      t.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicPolicy: true }),
        LifecycleConfiguration: {
          Rules: [Match.objectLike({ ExpirationInDays: 90, Prefix: 'inbound/' })],
        },
      });
      // Only SES, for this account, may write raw messages.
      t.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 's3:PutObject',
              Principal: { Service: 'ses.amazonaws.com' },
              Condition: { StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } },
            }),
          ]),
        },
      });
    });
  });

  describe('secrets', () => {
    const t = template(environment, 'secrets');

    it('creates a rotating, retained KMS key for token envelope encryption', () => {
      t.hasResource('AWS::KMS::Key', {
        DeletionPolicy: 'Retain',
        Properties: Match.objectLike({ EnableKeyRotation: true, PendingWindowInDays: 30 }),
      });
      t.hasResourceProperties('AWS::KMS::Alias', {
        AliasName: `alias/listora-${environment}-tokens`,
      });
    });

    it('creates every app secret by name, retained in prod', () => {
      for (const secret of APP_SECRETS) {
        t.hasResource('AWS::SecretsManager::Secret', {
          DeletionPolicy: settings.protectData ? 'Retain' : 'Delete',
          Properties: Match.objectLike({ Name: `listora/${environment}/${secret.name}` }),
        });
      }
    });
  });

  describe('registry', () => {
    it('keeps immutable, scanned images', () => {
      template(environment, 'registry').hasResource('AWS::ECR::Repository', {
        DeletionPolicy: 'Retain',
        Properties: Match.objectLike({
          RepositoryName: 'listora/app',
          ImageTagMutability: 'IMMUTABLE',
          ImageScanningConfiguration: { ScanOnPush: true },
        }),
      });
    });
  });

  describe('compute', () => {
    const t = template(environment, 'compute');
    const taskDefinitions = resources(t, 'AWS::ECS::TaskDefinition');
    const container = (service: string) => {
      const found = taskDefinitions.find(
        (task) => task.Properties?.['Family'] === `listora-${environment}-${service}`,
      );
      if (found === undefined) throw new Error(`no ${service} task definition`);
      return (found.Properties?.['ContainerDefinitions'] as Record<string, unknown>[])[0] ?? {};
    };

    it('runs api and worker from the deployed image tag, with a read-only root file system', () => {
      for (const [service, command] of [
        ['api', ['node', 'apps/api/src/main.ts']],
        ['worker', ['node', 'apps/worker/src/main.ts']],
      ] as const) {
        const definition = container(service);
        expect(definition['Command']).toEqual(command);
        expect(definition['ReadonlyRootFilesystem']).toBe(true);
        expect(JSON.stringify(definition['Image'])).toContain(`:${target.imageTag}"`);
      }
    });

    it('gives the database URL no password; PGPASSWORD comes from the RDS secret', () => {
      for (const service of SERVICE_NAMES) {
        const definition = container(service);
        const env = definition['Environment'] as { Name: string; Value: unknown }[];
        const url = JSON.stringify(env.find((entry) => entry.Name === 'DATABASE_URL')?.Value);
        expect(url).toContain('postgres://listora@');
        expect(url).toContain('/listora?sslmode=verify-full');
        const secrets = definition['Secrets'] as { Name: string; ValueFrom: unknown }[];
        expect(JSON.stringify(secrets.find((s) => s.Name === 'PGPASSWORD')?.ValueFrom)).toContain(
          ':password::',
        );
        expect(secrets.map((secret) => secret.Name)).toEqual(containerSecretNames(service));
        expect(env.map((entry) => entry.Name)).toEqual(
          Object.keys(containerEnvironment(service, 'postgres://')),
        );
        // Nothing secret-looking travels as plain environment.
        for (const { Name } of env) expect(Name).not.toMatch(/PASSWORD|SECRET|KEY/);
      }
    });

    it('runs tasks in private subnets with rollback on failed deploys', () => {
      for (const service of resources(t, 'AWS::ECS::Service')) {
        // Autoscaling owns the task count; a template count would reset it on every deploy.
        expect(service.Properties?.['DesiredCount']).toBeUndefined();
        expect(service.Properties).toMatchObject({
          LaunchType: 'FARGATE',
          NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: 'DISABLED' } },
          DeploymentConfiguration: {
            DeploymentCircuitBreaker: { Enable: true, Rollback: true },
            MinimumHealthyPercent: 100,
            MaximumPercent: 200,
          },
        });
      }
      for (const [service, size] of [
        ['api', settings.api],
        ['worker', settings.worker],
      ] as const) {
        t.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
          MinCapacity: size.minTasks,
          MaxCapacity: size.maxTasks,
          ResourceId: {
            'Fn::Join': [
              '',
              Match.arrayWith([
                { 'Fn::GetAtt': [Match.stringLikeRegexp(`^${service}service`), 'Name'] },
              ]),
            ],
          },
        });
      }
    });

    it('serves the API over HTTPS only, health-checked on /health/live', () => {
      t.hasResourceProperties('AWS::CertificateManager::Certificate', {
        DomainName: `api.${target.domain}`,
        ValidationMethod: 'DNS',
      });
      t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 443,
        Protocol: 'HTTPS',
        SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
      });
      t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 80,
        DefaultActions: [
          Match.objectLike({
            Type: 'redirect',
            RedirectConfig: Match.objectLike({ Port: '443', Protocol: 'HTTPS' }),
          }),
        ],
      });
      t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Port: 3000,
        HealthCheckPath: '/health/live',
        Matcher: { HttpCode: '200' },
      });
      t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Scheme: 'internet-facing',
        LoadBalancerAttributes: Match.arrayWith([
          { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
        ]),
      });
      const attributes = JSON.stringify(
        resources(t, 'AWS::ElasticLoadBalancingV2::LoadBalancer')[0]?.Properties,
      );
      expect(attributes.includes('{"Key":"deletion_protection.enabled","Value":"true"}')).toBe(
        settings.protectData,
      );
      t.hasResourceProperties('AWS::Route53::RecordSet', {
        Name: `api.${target.domain}.`,
        Type: 'A',
      });
    });

    it('keeps service logs for the environment retention', () => {
      for (const service of ['api', 'worker']) {
        t.hasResourceProperties('AWS::Logs::LogGroup', {
          LogGroupName: `/listora/${environment}/${service}`,
          RetentionInDays: settings.logRetention,
        });
      }
    });

    it('grants each task role only its designed resources (least privilege)', () => {
      const policies = t.findResources('AWS::IAM::Policy');
      const policyOf = (prefix: string) => {
        const found = Object.entries(policies).find(([id]) => id.startsWith(prefix));
        if (found === undefined) throw new Error(`no policy ${prefix}`);
        return JSON.stringify(found[1]);
      };
      const apiTask = policyOf('apitaskTaskRole');
      const workerTask = policyOf('workertaskTaskRole');
      expect(apiTask).toContain('Photos');
      expect(apiTask).not.toContain('InboundMail');
      expect(workerTask).toContain('Photos');
      expect(workerTask).toContain('/inbound/*');
      for (const policy of [apiTask, workerTask]) {
        expect(policy).toContain('"kms:Decrypt","kms:GenerateDataKey"');
        expect(policy).not.toContain('kms:*');
        expect(policy).not.toContain('secretsmanager');
      }

      for (const statement of statements(t)) {
        expect(asList(statement['Action'])).not.toContain('*');
        if (statement['Resource'] === '*') {
          // ECR login is the one action AWS defines without resource-level permissions.
          expect(statement['Action']).toBe('ecr:GetAuthorizationToken');
        }
      }
    });
  });

  describe('migrate', () => {
    const t = template(environment, 'migrate');
    const names = migrateTaskNames(environment);
    const definition = () => {
      const [task] = resources(t, 'AWS::ECS::TaskDefinition');
      expect(task?.Properties?.['Family']).toBe(names.family);
      return (task?.Properties?.['ContainerDefinitions'] as Record<string, unknown>[])[0] ?? {};
    };

    it('defines the migration task under fixed names, with its own cluster and log group', () => {
      t.resourceCountIs('AWS::ECS::TaskDefinition', 1);
      t.hasResourceProperties('AWS::ECS::Cluster', { ClusterName: names.cluster });
      t.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: names.logGroup,
        RetentionInDays: settings.logRetention,
      });
      for (const roleName of [names.taskRole, names.executionRole]) {
        t.hasResourceProperties('AWS::IAM::Role', {
          RoleName: roleName,
          AssumeRolePolicyDocument: {
            Statement: [Match.objectLike({ Principal: { Service: 'ecs-tasks.amazonaws.com' } })],
          },
        });
      }
      t.hasOutput('SubnetIds', Match.anyValue());
      t.hasOutput('SecurityGroupId', Match.anyValue());
    });

    it('runs the migrate CLI from the deployed image with the worker database access', () => {
      const container = definition();
      expect(container['Command']).toEqual(MIGRATE_COMMAND);
      expect(container['ReadonlyRootFilesystem']).toBe(true);
      expect(JSON.stringify(container['Image'])).toContain(`:${target.imageTag}"`);
      const env = container['Environment'] as { Name: string; Value: unknown }[];
      expect(env.map((entry) => entry.Name)).toEqual(
        Object.keys(containerEnvironment('worker', 'postgres://')),
      );
      expect(JSON.stringify(env.find((entry) => entry.Name === 'DATABASE_URL')?.Value)).toContain(
        'postgres://listora@',
      );
      const secrets = container['Secrets'] as { Name: string; ValueFrom: unknown }[];
      expect(secrets.map((secret) => secret.Name)).toEqual(['PGPASSWORD']);
      expect(JSON.stringify(secrets[0]?.ValueFrom)).toContain(':password::');
    });

    it('gives the task role no permissions and the execution role only what starts the task', () => {
      const policies = Object.entries(t.findResources('AWS::IAM::Policy'));
      expect(policies.map(([id]) => id)).toEqual([
        expect.stringMatching(/^ExecutionRoleDefaultPolicy/) as unknown,
      ]);
      const actions = statements(t).flatMap((statement) => asList(statement['Action']));
      expect([...new Set(actions)].sort()).toEqual(
        [
          'ecr:BatchCheckLayerAvailability',
          'ecr:BatchGetImage',
          'ecr:GetAuthorizationToken',
          'ecr:GetDownloadUrlForLayer',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'secretsmanager:DescribeSecret',
          'secretsmanager:GetSecretValue',
        ].sort(),
      );
      for (const statement of statements(t)) {
        if (statement['Resource'] === '*') {
          expect(statement['Action']).toBe('ecr:GetAuthorizationToken');
        }
      }
    });
  });

  describe('observability', () => {
    const t = template(environment, 'observability');

    it('defines baseline alarms that notify the alarm topic on alarm and recovery', () => {
      const alarms = resources(t, 'AWS::CloudWatch::Alarm');
      const names = alarms.map((alarm) => alarm.Properties?.['AlarmName']);
      expect(names).toEqual(
        [
          'api-5xx',
          'load-balancer-5xx',
          'api-unhealthy-tasks',
          'api-latency-p95',
          'api-cpu',
          'api-memory',
          'worker-cpu',
          'worker-memory',
          'database-cpu',
          'database-free-storage',
          'database-free-memory',
        ].map((name) => `listora-${environment}-${name}`),
      );
      for (const alarm of alarms) {
        expect(alarm.Properties?.['AlarmActions']).toEqual([
          { Ref: expect.stringMatching(/^Alarms/) as unknown },
        ]);
        expect(alarm.Properties?.['OKActions']).toEqual(alarm.Properties?.['AlarmActions']);
      }
      t.resourceCountIs('AWS::SNS::Subscription', 0);
    });

    it('alarms on free storage only once autoscaling stops keeping up', () => {
      const threshold = resources(t, 'AWS::CloudWatch::Alarm').find(
        (alarm) =>
          alarm.Properties?.['AlarmName'] === `listora-${environment}-database-free-storage`,
      )?.Properties?.['Threshold'] as number;
      // Autoscaling grows the volume below 10% free, so normal operation never gets this low.
      expect(threshold).toBeLessThan(settings.database.allocatedStorageGiB * 0.1 * 1024 ** 3);
      expect(threshold).toBeGreaterThan(0);
    });

    it('subscribes the alarm email when one is configured', () => {
      const { stacks: withEmail } = synthesize(environment, { alarmEmail: 'ops@example.com' });
      Template.fromStack(withEmail.observability).hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        Endpoint: 'ops@example.com',
      });
    });
  });

  describe('deploy access', () => {
    const t = template(environment, 'deployAccess');

    it('trusts only GitHub OIDC tokens for this repository and GitHub environment', () => {
      t.hasResourceProperties('AWS::IAM::OIDCProvider', {
        Url: 'https://token.actions.githubusercontent.com',
        ClientIdList: ['sts.amazonaws.com'],
      });
      t.hasResourceProperties('AWS::IAM::Role', {
        RoleName: `listora-${environment}-github-deploy`,
        MaxSessionDuration: 3600,
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                  'token.actions.githubusercontent.com:sub': `repo:${target.githubRepository}:environment:${environment}`,
                },
              },
            }),
          ],
        },
      });
    });

    it('can only use the CDK bootstrap roles, push the image, and run the migration task', () => {
      const actions = statements(t).flatMap((statement) => asList(statement['Action']));
      expect(actions.sort()).toEqual(
        [
          'cloudformation:DescribeStacks',
          'ecr:BatchCheckLayerAvailability',
          'ecr:BatchGetImage',
          'ecr:CompleteLayerUpload',
          'ecr:DescribeImages',
          'ecr:GetAuthorizationToken',
          'ecr:InitiateLayerUpload',
          'ecr:PutImage',
          'ecr:UploadLayerPart',
          'ecs:DescribeTasks',
          'ecs:RunTask',
          'iam:PassRole',
          'sts:AssumeRole',
        ].sort(),
      );
      t.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
      const role = resources(t, 'AWS::IAM::Role')[0];
      expect(role?.Properties?.['ManagedPolicyArns']).toBeUndefined();
      expect(JSON.stringify(statements(t))).toContain(
        `role/cdk-hnb659fds-*-${target.account}-${target.region}`,
      );
    });

    it('scopes the migration grants to the migration task, its cluster, and its roles', () => {
      const names = migrateTaskNames(environment);
      const bySid = (sid: string) => {
        const found = statements(t).find((statement) => statement['Sid'] === sid);
        if (found === undefined) throw new Error(`no statement ${sid}`);
        return JSON.stringify(found);
      };
      const ecs = `:ecs:${target.region}:${target.account}:`;
      expect(bySid('RunSchemaMigrations')).toContain(`${ecs}task-definition/${names.family}:*`);
      expect(bySid('RunSchemaMigrations')).toMatch(
        new RegExp(`"ArnEquals":\\{"ecs:cluster":.*${ecs}cluster/${names.cluster}"`),
      );
      expect(bySid('WatchSchemaMigrations')).toContain(`${ecs}task/${names.cluster}/*`);
      const passRole = bySid('PassSchemaMigrationRoles');
      for (const role of [names.taskRole, names.executionRole]) {
        expect(passRole).toContain(`:iam::${target.account}:role/${role}"`);
      }
      expect(passRole).toContain('"iam:PassedToService":"ecs-tasks.amazonaws.com"');
      expect(bySid('ReadStackOutputs')).toContain(`:stack/listora-${environment}-*/*`);
    });
  });
});
