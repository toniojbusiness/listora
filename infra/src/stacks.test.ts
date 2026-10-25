import { readFileSync } from 'node:fs';

import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { CREDENTIAL_PURPOSES as VAULT_PURPOSES } from '@listora/connections';
import { MARKETPLACES } from '@listora/db';
import { METRIC_NAMESPACE, TRUST_METRICS } from '@listora/observability/catalog';

import { APP_SECRETS, ENVIRONMENT_SETTINGS, SERVICE_NAMES } from './config.ts';
import {
  containerEnvironment,
  containerSecretNames,
  MIGRATE_COMMAND,
  RUNNER_COMMAND,
  type ServiceResources,
} from './containers.ts';
import type { ListoraStacks } from './app.ts';
import {
  CREDENTIAL_PURPOSES,
  HTTP_API_THROTTLE,
  RUNNER_SERVICE_NAME,
} from './stacks/compute-stack.ts';
import { PLACEHOLDER_SHAPES } from './placeholders.ts';
import { MIGRATE_OUTPUTS, migrateTaskNames } from './stacks/migrate-stack.ts';
import { stackList, synthesize } from './test-support.ts';

type Resource = { Type: string; Properties?: Record<string, unknown> } & Record<string, unknown>;

/** Each environment, plus personal with a domain (it deploys without one until then). */
const synthesized = new Map(
  PLACEHOLDER_SHAPES.map((shape) => [shape.name, synthesize(shape.environment, shape.overrides)]),
);

function synthesizedShape(shape: string): ReturnType<typeof synthesize> {
  const result = synthesized.get(shape);
  if (result === undefined) throw new Error(`no placeholder shape ${shape}`);
  return result;
}

function template(shape: string, stack: keyof ListoraStacks) {
  return Template.fromStack(synthesizedShape(shape).stacks[stack]);
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

/** Any resources, for the names of the variables a container gets. */
const ANY_RESOURCES: ServiceResources = {
  photoStorage: { bucket: '', region: '', publicBaseUrl: '' },
  runner: { cluster: '', service: '', region: '' },
  tokenKeyArn: '',
};

describe.each(PLACEHOLDER_SHAPES)('$name', ({ name: shape, environment, overrides }) => {
  const settings = ENVIRONMENT_SETTINGS[environment];
  const { stacks, target } = synthesizedShape(shape);
  const dns = target.dns;

  it('deploys every stack to the target account and region, protected with its data', () => {
    for (const stack of stackList(stacks)) {
      expect(stack.account).toBe(target.account);
      expect(stack.region).toBe(target.region);
      expect(stack.stackName).toMatch(new RegExp(`^listora-${environment}-[a-z-]+$`));
      expect(stack.terminationProtection).toBe(settings.protectData);
      expect(stack.tags.tagValues()).toEqual({ project: 'listora', environment });
    }
  });

  describe('network', () => {
    const t = template(shape, 'network');

    const egress = settings.network.taskEgress;

    it('spans two zones with public, app (NAT egress only), and isolated data subnets', () => {
      t.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: settings.network.cidr });
      const tiers = Object.keys(t.findResources('AWS::EC2::Subnet')).map((id) =>
        id.replace(/Subnet\d+Subnet[0-9A-F]+$/, ''),
      );
      expect(tiers.sort()).toEqual(
        (egress.via === 'nat'
          ? ['Vpcapp', 'Vpcapp', 'Vpcdata', 'Vpcdata', 'Vpcpublic', 'Vpcpublic']
          : ['Vpcdata', 'Vpcdata', 'Vpcpublic', 'Vpcpublic']
        ).sort(),
      );
      t.resourceCountIs('AWS::EC2::NatGateway', egress.via === 'nat' ? egress.natGateways : 0);
      t.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        VpcEndpointType: 'Gateway',
        ServiceName: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
      });
      t.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
      if (settings.network.rejectedFlowLogs) {
        t.hasResourceProperties('AWS::EC2::FlowLog', { TrafficType: 'REJECT' });
      } else {
        t.resourceCountIs('AWS::EC2::FlowLog', 0);
      }
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

    it('opens only a load balancer to the internet, and the database only to the tasks', () => {
      const groups = t.findResources('AWS::EC2::SecurityGroup');
      const groupId = (prefix: string) => {
        const id = Object.keys(groups).find((key) => key.startsWith(prefix));
        if (id === undefined) throw new Error(`no ${prefix} security group`);
        return id;
      };
      const [ingressGroup, api, worker, db] = [
        settings.ingress.via === 'load-balancer'
          ? 'LoadBalancerSecurityGroup'
          : 'VpcLinkSecurityGroup',
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
      // Tasks in public subnets have public addresses, but no group admits the internet.
      expect(open.map(({ id, rule }) => [id, rule['FromPort']])).toEqual(
        settings.ingress.via === 'load-balancer'
          ? [
              [ingressGroup, 443],
              [ingressGroup, 80],
            ]
          : [],
      );

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
      expect(
        into(api).map((rule) => [
          (rule['SourceSecurityGroupId'] as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0],
          rule['FromPort'],
        ]),
      ).toEqual([[ingressGroup, 3000]]);
      // The ingress group may connect only to the API tasks' port.
      const egressRules = resources(t, 'AWS::EC2::SecurityGroupEgress').map(
        (rule) => rule.Properties ?? {},
      );
      expect(
        egressRules.map((rule) => [
          (rule['GroupId'] as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0],
          (rule['DestinationSecurityGroupId'] as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0],
          rule['FromPort'],
        ]),
      ).toEqual([[ingressGroup, api, 3000]]);
    });
  });

  describe('data', () => {
    const t = template(shape, 'data');

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
    const t = template(shape, 'storage');

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
              // The browser runner's screenshots, which the worker deletes after 14 days.
              Match.objectLike({ Prefix: 'automation/', ExpirationInDays: 30 }),
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
    const t = template(shape, 'email');

    it('keeps raw sale email in a private bucket for 90 days', () => {
      t.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicPolicy: true }),
        LifecycleConfiguration: {
          Rules: [Match.objectLike({ ExpirationInDays: 90, Prefix: 'inbound/' })],
        },
      });
    });

    if (dns !== undefined) {
      it('receives in.<domain> mail into the bucket, scanned, over TLS', () => {
        t.hasResourceProperties('AWS::Route53::RecordSet', {
          Name: `in.${dns.domain}.`,
          Type: 'MX',
          ResourceRecords: [`10 inbound-smtp.${target.region}.amazonaws.com`],
        });
        t.hasResourceProperties('AWS::SES::ReceiptRuleSet', {
          RuleSetName: `listora-${environment}`,
        });
        t.hasResourceProperties('AWS::SES::ReceiptRule', {
          Rule: Match.objectLike({
            Enabled: true,
            Recipients: [`in.${dns.domain}`],
            ScanEnabled: true,
            TlsPolicy: 'Require',
            Actions: [{ S3Action: Match.objectLike({ ObjectKeyPrefix: 'inbound/' }) }],
          }),
        });
        t.hasResourceProperties('AWS::SES::EmailIdentity', { EmailIdentity: dns.domain });
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
    } else {
      it('receives no email without a domain: no SES identity, MX record, or receipt rule', () => {
        for (const type of [
          'AWS::SES::EmailIdentity',
          'AWS::SES::ReceiptRuleSet',
          'AWS::SES::ReceiptRule',
          'AWS::Route53::RecordSet',
        ]) {
          t.resourceCountIs(type, 0);
        }
        expect(JSON.stringify(t.toJSON())).not.toContain('ses.amazonaws.com');
        expect(Object.keys(t.findOutputs('*'))).not.toContain('InboundMailDomain');
      });
    }
  });

  describe('secrets', () => {
    const t = template(shape, 'secrets');

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
    it('keeps immutable, scanned images of the application and the browser runner', () => {
      for (const name of ['listora/app', 'listora/runner']) {
        template(shape, 'registry').hasResource('AWS::ECR::Repository', {
          DeletionPolicy: 'Retain',
          Properties: Match.objectLike({
            RepositoryName: name,
            ImageTagMutability: 'IMMUTABLE',
            ImageScanningConfiguration: { ScanOnPush: true },
          }),
        });
      }
    });
  });

  describe('compute', () => {
    const t = template(shape, 'compute');
    const taskDefinitions = resources(t, 'AWS::ECS::TaskDefinition');
    const layout = settings.services;
    /** Each ECS service of the layout, the containers its task runs, and its size. */
    const expectedServices =
      layout.layout === 'separate'
        ? [
            { name: 'api', containers: ['api'], size: layout.api },
            { name: 'worker', containers: ['worker'], size: layout.worker },
          ]
        : [{ name: 'app', containers: ['api', 'worker'], size: layout.app }];
    const containerDefinitions = (task: Resource) =>
      task.Properties?.['ContainerDefinitions'] as Record<string, unknown>[];
    const container = (name: string) => {
      const found = taskDefinitions
        .flatMap(containerDefinitions)
        .find((definition) => definition['Name'] === name);
      if (found === undefined) throw new Error(`no ${name} container`);
      return found;
    };

    const runnerService = () => {
      const found = resources(t, 'AWS::ECS::Service').find(
        (service) => service.Properties?.['ServiceName'] === RUNNER_SERVICE_NAME,
      );
      if (found === undefined) throw new Error('no runner service');
      return found;
    };
    const appServices = () =>
      resources(t, 'AWS::ECS::Service').filter(
        (service) => service.Properties?.['ServiceName'] !== RUNNER_SERVICE_NAME,
      );

    it('runs the api and worker containers as the services and task sizes of the layout', () => {
      expect(
        taskDefinitions.map((task) => [
          task.Properties?.['Family'],
          containerDefinitions(task).map((definition) => definition['Name']),
          task.Properties?.['Cpu'],
          task.Properties?.['Memory'],
        ]),
      ).toEqual([
        ...expectedServices.map(({ name, containers, size }) => [
          `listora-${environment}-${name}`,
          containers,
          String(size.cpu),
          String(size.memoryMiB),
        ]),
        [
          `listora-${environment}-runner`,
          ['runner'],
          String(settings.browserRunner.cpu),
          String(settings.browserRunner.memoryMiB),
        ],
      ]);
      expect(
        resources(t, 'AWS::ECS::Service').map((service) => service.Properties?.['ServiceName']),
      ).toEqual([...expectedServices.map(({ name }) => name), RUNNER_SERVICE_NAME]);
    });

    it('runs the browser runner on demand: no task while idle, never two at once', () => {
      const publicIp = settings.network.taskEgress.via === 'public-ip';
      expect(runnerService().Properties).toMatchObject({
        DesiredCount: 0,
        LaunchType: 'FARGATE',
        NetworkConfiguration: {
          AwsvpcConfiguration: { AssignPublicIp: publicIp ? 'ENABLED' : 'DISABLED' },
        },
        DeploymentConfiguration: {
          DeploymentCircuitBreaker: { Enable: true, Rollback: true },
          MinimumHealthyPercent: 0,
          MaximumPercent: 100,
        },
      });
      // Nothing scales it but the worker and the runner itself.
      expect(
        JSON.stringify(resources(t, 'AWS::ApplicationAutoScaling::ScalableTarget')),
      ).not.toContain('runnerservice');
      const runner = container('runner');
      expect(runner['Command']).toEqual(RUNNER_COMMAND);
      expect(runner['ReadonlyRootFilesystem']).toBe(true);
      expect(runner['MountPoints']).toEqual([
        { ContainerPath: '/tmp', ReadOnly: false, SourceVolume: 'tmp' },
      ]);
      // The runner image repository's, not the application's.
      expect(JSON.stringify(runner['Image'])).toMatch(/OutputFnGetAttRunner/);
      expect(JSON.stringify(runner['Image'])).not.toMatch(/OutputFnGetAttApp/);
      expect(JSON.stringify(runner['Image'])).toContain(`:${target.imageTag}"`);
      const env = Object.fromEntries(
        (runner['Environment'] as { Name: string; Value: unknown }[]).map((entry) => [
          entry.Name,
          entry.Value,
        ]),
      );
      expect(Object.keys(env)).toEqual(
        Object.keys(containerEnvironment('runner', 'postgres://', ANY_RESOURCES)),
      );
      expect(env).toMatchObject({
        BROWSER_RUNNER_LAUNCH: 'ecs',
        BROWSER_RUNNER_CLUSTER: `listora-${environment}`,
        BROWSER_RUNNER_SERVICE: RUNNER_SERVICE_NAME,
        STORAGE_DRIVER: 's3',
      });
      expect(JSON.stringify(env['TOKEN_KMS_KEY_ID'])).toContain('TokenKey');
      const secrets = runner['Secrets'] as { Name: string }[];
      expect(secrets.map((secret) => secret.Name)).toEqual(['PGPASSWORD']);
      t.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: `/listora/${environment}/runner`,
        RetentionInDays: settings.logRetention,
      });
    });

    it('runs api and worker from the deployed image tag, with a read-only root file system', () => {
      for (const [service, command] of [
        ['api', ['node', 'apps/api/src/main.ts']],
        ['worker', ['node', 'apps/worker/src/main.ts']],
      ] as const) {
        const definition = container(service);
        expect(definition['Command']).toEqual(command);
        expect(definition['ReadonlyRootFilesystem']).toBe(true);
        expect(definition['Essential']).toBe(true);
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
          Object.keys(containerEnvironment(service, 'postgres://', ANY_RESOURCES)),
        );
        // Nothing secret-looking travels as plain environment (a KMS key's id is not a secret).
        for (const { Name } of env) expect(Name).not.toMatch(/PASSWORD|SECRET|KEY(?!_ID$)/);
        expect(JSON.stringify(env.find((entry) => entry.Name === 'TOKEN_KMS_KEY_ID'))).toContain(
          'TokenKey',
        );
      }
    });

    it('gives api and worker the photo bucket and CDN and the Anthropic provider', () => {
      for (const service of SERVICE_NAMES) {
        const env = Object.fromEntries(
          (container(service)['Environment'] as { Name: string; Value: unknown }[]).map((entry) => [
            entry.Name,
            entry.Value,
          ]),
        );
        expect(env).toMatchObject({
          AI_PROVIDER: 'anthropic',
          STORAGE_DRIVER: 's3',
          STORAGE_S3_REGION: target.region,
        });
        expect(JSON.stringify(env['STORAGE_S3_BUCKET'])).toContain('RefPhotos');
        expect(JSON.stringify(env['STORAGE_PUBLIC_BASE_URL'])).toContain('https://');
        expect(JSON.stringify(env['STORAGE_PUBLIC_BASE_URL'])).toContain('PhotoCdn');
        expect(containerSecretNames(service)).toContain('ANTHROPIC_API_KEY');
      }
    });

    it('runs tasks where the task egress places them, with rollback on failed deploys', () => {
      const publicIp = settings.network.taskEgress.via === 'public-ip';
      for (const service of appServices()) {
        // Autoscaling owns the task count; a template count would reset it on every deploy.
        expect(service.Properties?.['DesiredCount']).toBeUndefined();
        expect(service.Properties).toMatchObject({
          LaunchType: 'FARGATE',
          NetworkConfiguration: {
            AwsvpcConfiguration: { AssignPublicIp: publicIp ? 'ENABLED' : 'DISABLED' },
          },
          DeploymentConfiguration: {
            DeploymentCircuitBreaker: { Enable: true, Rollback: true },
            MinimumHealthyPercent: 100,
            MaximumPercent: 200,
          },
        });
        const subnets = JSON.stringify(
          (service.Properties?.['NetworkConfiguration'] as Record<string, Record<string, unknown>>)[
            'AwsvpcConfiguration'
          ]?.['Subnets'],
        );
        expect(subnets).toContain(publicIp ? 'RefVpcpublicSubnet' : 'RefVpcappSubnet');
        expect(subnets).not.toContain(publicIp ? 'Vpcapp' : 'Vpcpublic');
      }
      for (const { name, size } of expectedServices) {
        t.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
          MinCapacity: size.minTasks,
          MaxCapacity: size.maxTasks,
          ResourceId: {
            'Fn::Join': [
              '',
              Match.arrayWith([
                { 'Fn::GetAtt': [Match.stringLikeRegexp(`^${name}service`), 'Name'] },
              ]),
            ],
          },
        });
      }
      // A scaling policy only where the range leaves room to scale.
      t.resourceCountIs(
        'AWS::ApplicationAutoScaling::ScalingPolicy',
        expectedServices.filter(({ size }) => size.maxTasks > size.minTasks).length,
      );
    });

    it('keeps service logs for the environment retention', () => {
      for (const service of ['api', 'worker', 'runner']) {
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
      // The purposes the token vault seals with (@listora/connections), copied in the stack.
      expect(CREDENTIAL_PURPOSES).toEqual(VAULT_PURPOSES);
      const tokens = { 'kms:EncryptionContext:purpose': CREDENTIAL_PURPOSES.tokens };
      const sessions = { 'kms:EncryptionContext:purpose': CREDENTIAL_PURPOSES.session };
      for (const { name, containers } of expectedServices) {
        const policy = policyOf(`${name}taskTaskRole`);
        expect(policy).toContain('Photos');
        // Raw sale email, and starting the browser runner, only for a task that runs the worker.
        expect(policy.includes('InboundMail')).toBe(containers.includes('worker'));
        if (containers.includes('worker')) expect(policy).toContain('/inbound/*');
        expect(policy.includes('ecs:UpdateService')).toBe(containers.includes('worker'));
        // Every task seals; only the worker opens marketplace tokens, and never a browser session
        // (only the runner opens those).
        expect(policy).toContain('"Action":"kms:GenerateDataKey"');
        if (containers.includes('worker')) {
          expect(policy).toContain(
            JSON.stringify({
              Action: 'kms:Decrypt',
              Condition: { StringEquals: tokens },
            }).slice(1, -1),
          );
        } else {
          expect(policy).not.toContain('kms:Decrypt');
        }
        expect(policy).not.toContain('kms:*');
        expect(policy).not.toContain('secretsmanager');
      }
      const runner = policyOf('runnertaskTaskRole');
      expect(runner).toContain(
        JSON.stringify({
          Action: ['kms:Decrypt', 'kms:GenerateDataKey'],
          Condition: { StringEquals: sessions },
        }).slice(1, -1),
      );
      expect(runner).toContain('/automation/*');
      expect(runner).toContain('"s3:PutObject"');
      expect(runner).not.toContain('s3:GetObject');
      expect(runner).not.toContain('s3:DeleteObject');
      expect(runner).not.toContain('InboundMail');
      expect(runner).toContain('ecs:UpdateService');

      for (const statement of statements(t)) {
        expect(asList(statement['Action'])).not.toContain('*');
        if (statement['Resource'] === '*') {
          // ECR login is the one action AWS defines without resource-level permissions.
          expect(statement['Action']).toBe('ecr:GetAuthorizationToken');
        }
      }
    });

    if (dns !== undefined) {
      it('serves the API at https://api.<domain> only, with a certificate validated in DNS', () => {
        t.hasResourceProperties('AWS::CertificateManager::Certificate', {
          DomainName: `api.${dns.domain}`,
          ValidationMethod: 'DNS',
        });
        t.hasResourceProperties('AWS::Route53::RecordSet', {
          Name: `api.${dns.domain}.`,
          Type: 'A',
        });
        // The iOS Prod configuration's API_BASE_URL is personal's ApiUrl (infra/README.md).
        t.hasOutput('ApiUrl', { Value: `https://api.${dns.domain}` });
      });
    } else {
      it('serves the API at its default execute-api URL, with no DNS resource', () => {
        t.resourceCountIs('AWS::CertificateManager::Certificate', 0);
        t.resourceCountIs('AWS::Route53::RecordSet', 0);
        t.resourceCountIs('AWS::ApiGatewayV2::DomainName', 0);
        t.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 0);
        t.hasResourceProperties('AWS::ApiGatewayV2::Api', { DisableExecuteApiEndpoint: false });
        // https://<api id>.execute-api.<region>.amazonaws.com, which AWS serves over TLS.
        const [httpApiId] = Object.keys(t.findResources('AWS::ApiGatewayV2::Api'));
        t.hasOutput('ApiUrl', { Value: { 'Fn::GetAtt': [httpApiId, 'ApiEndpoint'] } });
      });
    }

    if (settings.ingress.via === 'load-balancer') {
      it('serves the API through the load balancer over HTTPS only, checked on /health/live', () => {
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
        t.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
        // The load balancer checks the API, so the container defines no check of its own.
        expect(container('api')['HealthCheck']).toBeUndefined();
      });
    } else {
      const { disableDefaultEndpoint } = settings.ingress;
      it('serves the API through an HTTP API and a VPC link, with no other endpoint', () => {
        t.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
        t.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
        t.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'HTTP' });
        if (dns !== undefined) {
          // The execute-api URL stays on next to the custom domain unless disabled on its own.
          t.hasResourceProperties('AWS::ApiGatewayV2::Api', {
            DisableExecuteApiEndpoint: disableDefaultEndpoint,
          });
          t.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
            DomainName: `api.${dns.domain}`,
            DomainNameConfigurations: [
              Match.objectLike({ EndpointType: 'REGIONAL', SecurityPolicy: 'TLS_1_2' }),
            ],
          });
          t.hasResourceProperties('AWS::ApiGatewayV2::ApiMapping', { Stage: Match.anyValue() });
        }
        // Every path and method goes to the API tasks, through the VPC link.
        t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: '$default' });
        t.resourceCountIs('AWS::ApiGatewayV2::Route', 1);
        t.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
          IntegrationType: 'HTTP_PROXY',
          ConnectionType: 'VPC_LINK',
          IntegrationMethod: 'ANY',
          IntegrationUri: { 'Fn::GetAtt': [Match.stringLikeRegexp('CloudmapService'), 'Arn'] },
        });
        t.hasResourceProperties('AWS::ApiGatewayV2::VpcLink', {
          SecurityGroupIds: [
            {
              'Fn::GetStackOutput': Match.objectLike({
                OutputName: Match.stringLikeRegexp('VpcLinkSecurityGroup'),
              }),
            },
          ],
        });
        // The $default stage serves at the root (no stage prefix in paths), throttled.
        t.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
          StageName: '$default',
          AutoDeploy: true,
          DefaultRouteSettings: {
            ThrottlingRateLimit: HTTP_API_THROTTLE.rateLimit,
            ThrottlingBurstLimit: HTTP_API_THROTTLE.burstLimit,
          },
        });
      });

      it('registers the API container in Cloud Map and has ECS check its /health/live', () => {
        // SRV records carry the port; ECS keeps the registrations to healthy tasks.
        t.hasResourceProperties('AWS::ServiceDiscovery::Service', {
          Name: 'api',
          DnsConfig: Match.objectLike({ DnsRecords: [{ TTL: 10, Type: 'SRV' }] }),
          HealthCheckCustomConfig: { FailureThreshold: 1 },
        });
        t.hasResourceProperties('AWS::ECS::Service', {
          ServiceRegistries: [Match.objectLike({ ContainerName: 'api', ContainerPort: 3000 })],
        });
        const check = container('api')['HealthCheck'] as Record<string, unknown>;
        const command = check['Command'] as string[];
        expect(command.slice(0, 3)).toEqual(['CMD', 'node', '-e']);
        expect(command[3]).toContain("fetch('http://127.0.0.1:3000/health/live')");
        expect(check).toMatchObject({ Interval: 15, Timeout: 5, Retries: 3, StartPeriod: 30 });
        expect(container('worker')['HealthCheck']).toBeUndefined();
      });
    }
  });

  describe('migrate', () => {
    const t = template(shape, 'migrate');
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
      t.hasOutput(MIGRATE_OUTPUTS.subnetIds, Match.anyValue());
      t.hasOutput(MIGRATE_OUTPUTS.securityGroupId, Match.anyValue());
    });

    it('starts the migration task where the services run (task subnets, public IP or not)', () => {
      const publicIp = settings.network.taskEgress.via === 'public-ip';
      t.hasOutput(MIGRATE_OUTPUTS.assignPublicIp, { Value: publicIp ? 'ENABLED' : 'DISABLED' });
      const subnets = JSON.stringify(t.findOutputs(MIGRATE_OUTPUTS.subnetIds));
      expect(subnets).toContain(publicIp ? 'RefVpcpublicSubnet' : 'RefVpcappSubnet');
      expect(subnets).not.toContain(publicIp ? 'Vpcapp' : 'Vpcpublic');
    });

    it('runs the migrate CLI from the deployed image with the worker database access', () => {
      const container = definition();
      expect(container['Command']).toEqual(MIGRATE_COMMAND);
      expect(container['ReadonlyRootFilesystem']).toBe(true);
      expect(JSON.stringify(container['Image'])).toContain(`:${target.imageTag}"`);
      const env = container['Environment'] as { Name: string; Value: unknown }[];
      expect(env.map((entry) => entry.Name)).toEqual(
        Object.keys(containerEnvironment('migrate', 'postgres://')),
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
    const t = template(shape, 'observability');

    const alarmNamed = (name: string) => {
      const found = resources(t, 'AWS::CloudWatch::Alarm').find(
        (alarm) => alarm.Properties?.['AlarmName'] === `listora-${environment}-${name}`,
      );
      if (found === undefined) throw new Error(`no ${name} alarm`);
      return found.Properties ?? {};
    };
    const serviceNames = settings.services.layout === 'separate' ? ['api', 'worker'] : ['app'];

    it('defines the baseline and trust alarms, notifying the topic on alarm and recovery', () => {
      const alarms = resources(t, 'AWS::CloudWatch::Alarm');
      const names = alarms.map((alarm) => alarm.Properties?.['AlarmName']);
      const endpointAlarms =
        settings.ingress.via === 'load-balancer'
          ? ['api-5xx', 'load-balancer-5xx', 'api-unhealthy-tasks', 'api-latency-p95']
          : ['api-5xx', 'api-latency-p95'];
      expect(names).toEqual(
        [
          ...endpointAlarms,
          ...serviceNames.flatMap((name) => [
            `${name}-running-tasks`,
            `${name}-cpu`,
            `${name}-memory`,
          ]),
          'operation-unverified',
          'delist-failed',
          'ai-daily-cost',
          'connection-needs-relink',
          ...MARKETPLACES.map((marketplace) => `delist-latency-${marketplace}`),
          ...MARKETPLACES.map((marketplace) => `verified-success-${marketplace}`),
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

    if (environment === 'personal') {
      it('has the alarm count docs/features/costs.md prices', () => {
        // Ten beyond the always-free ten standard alarms, at $0.10 each a month.
        const count = resources(t, 'AWS::CloudWatch::Alarm').length;
        expect(count).toBe(20);
        const costs = readFileSync(
          new URL('../../docs/features/costs.md', import.meta.url),
          'utf8',
        );
        expect(costs).toContain(`| ${String(count)} standard alarms;`);
      });
    }

    if (settings.ingress.via === 'http-api') {
      it('alarms on server errors and latency (in milliseconds) of the HTTP API', () => {
        // One user sends few requests: any server error counts, in 2 of 3 periods.
        expect(alarmNamed('api-5xx')).toMatchObject({
          Namespace: 'AWS/ApiGateway',
          MetricName: '5xx',
          Statistic: 'Sum',
          Period: 300,
          Threshold: 1,
          ComparisonOperator: 'GreaterThanOrEqualToThreshold',
          EvaluationPeriods: 3,
          DatapointsToAlarm: 2,
        });
        expect(alarmNamed('api-latency-p95')).toMatchObject({
          Namespace: 'AWS/ApiGateway',
          MetricName: 'IntegrationLatency',
          ExtendedStatistic: 'p95',
          Threshold: 2000,
        });
      });
    }

    it('alarms when a service, the worker included, runs fewer tasks than it should', () => {
      for (const name of serviceNames) {
        const alarm = alarmNamed(`${name}-running-tasks`);
        expect(alarm).toMatchObject({
          EvaluationPeriods: 3,
          // No data is exactly the failure this alarm exists for.
          TreatMissingData: 'breaching',
        });
        if (settings.containerInsights) {
          expect(alarm).toMatchObject({
            Threshold: 1,
            ComparisonOperator: 'GreaterThanOrEqualToThreshold',
          });
          const queries = alarm['Metrics'] as Record<string, unknown>[];
          expect(queries.find((query) => query['Id'] === 'expr_1')).toMatchObject({
            Expression: 'desired - running',
            ReturnData: true,
          });
          for (const [id, metricName, stat] of [
            ['desired', 'DesiredTaskCount', 'Maximum'],
            ['running', 'RunningTaskCount', 'Minimum'],
          ] as const) {
            const query = queries.find((candidate) => candidate['Id'] === id);
            expect(query).toMatchObject({
              ReturnData: false,
              MetricStat: {
                Metric: { Namespace: 'ECS/ContainerInsights', MetricName: metricName },
                Period: 60,
                Stat: stat,
              },
            });
            const dimensions = JSON.stringify(query?.['MetricStat']);
            expect(dimensions).toContain('"Name":"ClusterName"');
            expect(dimensions).toContain('"Name":"ServiceName"');
            expect(dimensions).toContain(`PublishOutputFnGetAtt${name}service`);
          }
        } else {
          const size =
            settings.services.layout === 'separate'
              ? settings.services[name === 'api' ? 'api' : 'worker']
              : settings.services.app;
          // ECS reports a service's CPU every minute from each running task.
          expect(alarm).toMatchObject({
            Namespace: 'AWS/ECS',
            MetricName: 'CPUUtilization',
            Statistic: 'SampleCount',
            Period: 60,
            Threshold: size.minTasks,
            ComparisonOperator: 'LessThanThreshold',
          });
          expect(JSON.stringify(alarm['Dimensions'])).toContain(
            `PublishOutputFnGetAtt${name}service`,
          );
        }
      }
    });

    it('alarms on the trust metrics the worker publishes, with dimensions it publishes', () => {
      const expected = {
        'operation-unverified': ['OldestUnverifiedOperationAge', 'Maximum', 1800],
        'delist-failed': ['DelistFailed', 'Sum', 1],
        'ai-daily-cost': ['AiDailyCostUsd', 'Maximum', settings.aiDailyCostAlarmUsd],
        'connection-needs-relink': ['ConnectionsNeedingRelink', 'Maximum', 1],
      } as const;
      for (const [name, [metricName, statistic, threshold]] of Object.entries(expected)) {
        const alarm = alarmNamed(name);
        expect(alarm).toMatchObject({
          Namespace: METRIC_NAMESPACE,
          MetricName: metricName,
          Statistic: statistic,
          Period: 300,
          Threshold: threshold,
          ComparisonOperator: 'GreaterThanOrEqualToThreshold',
          EvaluationPeriods: 1,
          // The worker publishes nothing while it is down; running-tasks covers that.
          TreatMissingData: 'notBreaching',
        });
        // The alarm reads the metric without dimensions, so the worker must publish that set.
        expect(alarm['Dimensions']).toBeUndefined();
        expect(TRUST_METRICS[metricName].dimensionSets).toContainEqual([]);
      }
      expect(String(alarmNamed('ai-daily-cost')['AlarmDescription'])).toContain('$0.80');
    });

    it('alarms per marketplace on p95 delist latency and the verified-success rate', () => {
      expect(Object.keys(settings.delistLatencyAlarmMinutes)).toEqual([...MARKETPLACES]);
      expect(settings.delistLatencyAlarmMinutes).toEqual({
        ebay: 10,
        depop: 13 * 60,
        poshmark: 13 * 60,
        mercari: 13 * 60,
      });
      for (const marketplace of MARKETPLACES) {
        const dimensions = [{ Name: 'Marketplace', Value: marketplace }];
        expect(alarmNamed(`delist-latency-${marketplace}`)).toEqual(
          expect.objectContaining({
            Namespace: METRIC_NAMESPACE,
            MetricName: 'DelistLatency',
            ExtendedStatistic: 'p95',
            Dimensions: dimensions,
            Period: 3600,
            // DelistLatency is in milliseconds.
            Threshold: settings.delistLatencyAlarmMinutes[marketplace] * 60_000,
            ComparisonOperator: 'GreaterThanThreshold',
            EvaluationPeriods: 1,
            TreatMissingData: 'notBreaching',
          }),
        );
        expect(alarmNamed(`verified-success-${marketplace}`)).toEqual(
          expect.objectContaining({
            Namespace: METRIC_NAMESPACE,
            MetricName: 'VerifiedSuccess',
            Statistic: 'Average',
            Dimensions: dimensions,
            Period: 86_400,
            Threshold: 0.9,
            ComparisonOperator: 'LessThanThreshold',
            EvaluationPeriods: 1,
            TreatMissingData: 'notBreaching',
          }),
        );
      }
      // The alarms read each metric per marketplace alone, so the worker must publish that set.
      expect(TRUST_METRICS.DelistLatency.dimensionSets).toContainEqual(['Marketplace']);
      expect(TRUST_METRICS.VerifiedSuccess.dimensionSets).toContainEqual(['Marketplace']);
      expect(String(alarmNamed('delist-latency-ebay')['AlarmDescription'])).toContain('10 minutes');
      expect(String(alarmNamed('delist-latency-mercari')['AlarmDescription'])).toContain(
        '13 hours',
      );
    });

    it('sends unplanned task stops (crash loops) to the alarm topic, not deploy stops', () => {
      const topic = { Ref: Match.stringLikeRegexp('^Alarms') };
      t.resourceCountIs('AWS::Events::Rule', 1);
      const [rule] = resources(t, 'AWS::Events::Rule');
      expect(rule?.Properties).toMatchObject({
        Name: `listora-${environment}-task-stopped`,
        State: 'ENABLED',
        EventPattern: {
          source: ['aws.ecs'],
          'detail-type': ['ECS Task State Change'],
          detail: {
            clusterArn: [
              {
                'Fn::GetStackOutput': expect.objectContaining({
                  StackName: `listora-${environment}-compute`,
                  OutputName: expect.stringMatching(/^PublishOutputFnGetAttCluster/) as unknown,
                }) as unknown,
              },
            ],
            group: serviceNames.map((name) => `service:${name}`),
            lastStatus: ['STOPPED'],
            stoppedReason: [{ 'anything-but': { prefix: 'Scaling activity initiated by' } }],
          },
        },
      });
      const targets = rule?.Properties?.['Targets'] as Record<string, unknown>[];
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        Arn: { Ref: expect.stringMatching(/^Alarms/) as unknown },
      });
      expect(JSON.stringify(targets[0]?.['InputTransformer'])).toContain('$.detail.stoppedReason');
      t.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'TaskStoppedEvents',
              Effect: 'Allow',
              Action: 'sns:Publish',
              Principal: { Service: 'events.amazonaws.com' },
              Resource: topic,
              Condition: {
                ArnEquals: {
                  'aws:SourceArn': {
                    'Fn::GetAtt': [Match.stringLikeRegexp('^TaskStopped'), 'Arn'],
                  },
                },
              },
            }),
          ]),
        },
      });
    });

    it('forwards the database low-storage events, including the autoscaling ceiling', () => {
      const topic = { Ref: Match.stringLikeRegexp('^Alarms') };
      t.hasResourceProperties('AWS::RDS::EventSubscription', {
        SubscriptionName: `listora-${environment}-database-storage`,
        SnsTopicArn: topic,
        SourceType: 'db-instance',
        SourceIds: [
          {
            'Fn::GetStackOutput': Match.objectLike({
              StackName: `listora-${environment}-data`,
              OutputName: Match.stringLikeRegexp('^PublishOutputRefPostgres'),
            }),
          },
        ],
        EventCategories: ['low storage'],
        Enabled: true,
      });
      t.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'RdsStorageEvents',
              Effect: 'Allow',
              Action: 'sns:Publish',
              Principal: { Service: 'events.rds.amazonaws.com' },
              Resource: topic,
              Condition: {
                ArnEquals: {
                  'aws:SourceArn': `arn:aws:rds:${target.region}:${target.account}:es:listora-${environment}-database-storage`,
                },
              },
            }),
          ]),
        },
      });
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
      const { stacks: withEmail } = synthesize(environment, {
        ...overrides,
        alarmEmail: 'ops@example.com',
      });
      Template.fromStack(withEmail.observability).hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        Endpoint: 'ops@example.com',
      });
    });
  });

  describe('deploy access', () => {
    const t = template(shape, 'deployAccess');

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
