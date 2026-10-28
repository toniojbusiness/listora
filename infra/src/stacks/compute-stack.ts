import { assertNever } from '@listora/shared';
import { CfnOutput, Duration } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

import type { DnsTarget, ServiceName, ServiceSize, SignIn } from '../config.ts';
import {
  API_PORT,
  containerEnvironment,
  RUNNER_COMMAND,
  SERVICE_COMMANDS,
  signInResources,
  type ServiceResources,
} from '../containers.ts';
import { alertSendStatement, alertSender } from './alerts.ts';
import { ListoraStack, removalPolicyFor, taskPlacement, type ListoraStackProps } from './common.ts';
import { INBOUND_MAIL_PREFIX } from './email-stack.ts';
import { AUTOMATION_SCREENSHOT_PREFIX } from './storage-stack.ts';
import { containerSecrets, databaseUrl } from './task-config.ts';

export interface ComputeStackProps extends ListoraStackProps {
  readonly vpc: ec2.IVpc;
  readonly ingressSecurityGroup: ec2.ISecurityGroup;
  readonly apiSecurityGroup: ec2.ISecurityGroup;
  readonly workerSecurityGroup: ec2.ISecurityGroup;
  readonly database: rds.DatabaseInstance;
  readonly repository: ecr.IRepository;
  /** The browser runner's image (the Dockerfile's `runner` stage). */
  readonly runnerRepository: ecr.IRepository;
  readonly photoBucket: s3.IBucket;
  /** The photo CloudFront distribution's domain name; it serves the bucket's `public/` keys. */
  readonly photoCdnDomain: string;
  /** That distribution's id: the worker invalidates the public package photos it moves. */
  readonly photoCdnDistributionId: string;
  readonly inboundMailBucket: s3.IBucket;
  /** The queue of received sale emails and their domain; absent without a domain. */
  readonly saleEmail?: { readonly inboundDomain: string; readonly queue: sqs.IQueue };
  readonly tokenKey: kms.IKey;
  /** The auth stack's user pool and the iPhone app's client, where the environment has one. */
  readonly userPool?: {
    readonly pool: cognito.IUserPool;
    readonly appClient: cognito.IUserPoolClient;
  };
}

function sesVerifiesInvitees(signIn: SignIn): boolean {
  return signIn.via === 'owner-pool' && signIn.inviteEmailVerification === 'ses';
}

/** A user pool's owner, whom the deploy config always names (the auth stack needs it too). */
function requiredOwnerEmail(ownerEmail: string | undefined): string {
  if (ownerEmail === undefined) throw new Error('an environment with a user pool needs its owner');
  return ownerEmail;
}

/** Label under the environment's domain that serves the API. */
export const API_SUBDOMAIN = 'api';

/** The environment's ECS cluster, which runs every service. */
export function clusterName(environment: string): string {
  return `listora-${environment}`;
}

/** The browser runner's ECS service, in the environment's cluster. */
export const RUNNER_SERVICE_NAME = 'runner';

/**
 * The KMS encryption context `purpose` of each kind of marketplace credential
 * (`CREDENTIAL_PURPOSES` in @listora/connections; a test keeps the two equal): the worker may
 * decrypt only OAuth tokens, the browser runner only browser sessions.
 */
export const CREDENTIAL_PURPOSES = {
  tokens: 'listora-marketplace-tokens',
  session: 'listora-marketplace-session',
} as const;

/** Target CPU utilization for service autoscaling. */
const TARGET_CPU_PERCENT = 60;

/**
 * Steady and burst request rates the HTTP API admits for the whole environment; beyond them
 * it answers 429. Far above what one reseller's app sends, far below a bill-raising flood.
 */
export const HTTP_API_THROTTLE = { rateLimit: 50, burstLimit: 100 } as const;

/** What serves the API (`ingress`), for the alarms. */
export type ApiEndpoint =
  | {
      readonly kind: 'load-balancer';
      readonly loadBalancer: elbv2.ApplicationLoadBalancer;
      readonly targetGroup: elbv2.ApplicationTargetGroup;
    }
  | { readonly kind: 'http-api'; readonly httpApi: apigwv2.HttpApi };

/** One ECS service: `api` and `worker`, or `app`, which runs both containers. */
export interface ListoraService {
  readonly name: string;
  readonly service: ecs.FargateService;
}

/**
 * Fargate services for the API and the worker on one ECS cluster, plus the public HTTPS
 * endpoint of the API: an Application Load Balancer, or an API Gateway HTTP API reaching the
 * tasks through a VPC link and Cloud Map (`ingress`). The two processes run as two services,
 * or as two containers of one service (`services.layout`).
 *
 * With a domain, the API is served at `https://api.<domain>`, with an ACM certificate and an
 * alias record in the domain's zone, and that is the `ApiUrl` output. Without one (HTTP API
 * only), it answers at its default `execute-api` URL, which AWS serves over TLS, no DNS
 * resource is created, and `ApiUrl` is that URL. The HTTP API keeps the `execute-api` URL
 * alongside a domain unless `disableDefaultEndpoint` is set.
 *
 * Container configuration comes from `containerEnvironment` (src/containers.ts). The database
 * password reaches the processes only as `PGPASSWORD`, injected by ECS from the RDS-generated
 * secret, so no secret appears in a task definition. Each task role is granted only the
 * resources its containers are designed to use.
 *
 * The services set no desired count: CloudFormation would reset the running count to it on
 * every deploy. Autoscaling owns the count, between `minTasks` and `maxTasks`.
 *
 * The browser runner (decision D1) is a third service, from its own image, with no task while
 * idle: its desired count is 0, the worker sets it to 1 when automated work waits, and the
 * runner sets it back to 0 as it exits (packages/automation/src/launcher.ts). A deploy resets
 * it to 0; work still waiting then starts a runner of the new release within a minute. At
 * most one runner task ever runs: a replacement starts only after the old one stopped.
 */
export class ComputeStack extends ListoraStack {
  readonly cluster: ecs.Cluster;
  readonly services: readonly ListoraService[];
  readonly endpoint: ApiEndpoint;

  private readonly containerOptions: (service: ServiceName) => ecs.ContainerDefinitionOptions;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    const { settings, target } = props;
    const environment = target.environment;

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: clusterName(environment),
      vpc: props.vpc,
      containerInsightsV2: settings.containerInsights
        ? ecs.ContainerInsights.ENABLED
        : ecs.ContainerInsights.DISABLED,
    });

    const image = ecs.ContainerImage.fromEcrRepository(props.repository, target.imageTag);
    const url = databaseUrl(props.database);
    const resources: ServiceResources = {
      photoStorage: {
        bucket: props.photoBucket.bucketName,
        region: target.region,
        publicBaseUrl: `https://${props.photoCdnDomain}`,
        cdnDistributionId: props.photoCdnDistributionId,
      },
      signIn: signInResources(
        settings.signIn,
        props.userPool && {
          userPoolId: props.userPool.pool.userPoolId,
          clientIds: [props.userPool.appClient.userPoolClientId],
          ownerEmail: requiredOwnerEmail(target.ownerEmail),
        },
      ),
      runner: {
        cluster: `listora-${environment}`,
        service: RUNNER_SERVICE_NAME,
        region: target.region,
      },
      tokenKeyArn: props.tokenKey.keyArn,
      ...(props.saleEmail === undefined
        ? {}
        : {
            saleEmail: {
              inboundDomain: props.saleEmail.inboundDomain,
              queueUrl: props.saleEmail.queue.queueUrl,
              bucket: props.inboundMailBucket.bucketName,
              region: target.region,
            },
          }),
      ownerAlerts: {
        environment,
        ...(target.alarmEmail === undefined
          ? {}
          : { email: { from: alertSender(target).address, to: target.alarmEmail } }),
      },
    };
    this.containerOptions = (service) => ({
      image,
      command: [...SERVICE_COMMANDS[service]],
      environment: containerEnvironment(service, url, resources),
      secrets: containerSecrets(this, environment, service, props.database),
      portMappings: service === 'api' ? [{ containerPort: API_PORT }] : [],
      // Without a load balancer, ECS itself checks the API (the same liveness path) and
      // replaces a task that fails.
      ...(service === 'api' && settings.ingress.via === 'http-api'
        ? { healthCheck: apiHealthCheck() }
        : {}),
      readonlyRootFilesystem: true,
      // Both processes drain on SIGTERM (handleShutdownSignals in @listora/shared).
      stopTimeout: Duration.seconds(30),
    });

    // Designed access, least privilege: photos for both (uploads, derivatives), raw sale
    // emails and their queue for the worker only, and envelope encryption of marketplace credentials: the API
    // only seals (GenerateDataKey), the worker opens OAuth tokens and only those, and the
    // browser runner opens sellers' browser sessions and only those (the KMS encryption
    // context's `purpose` tells them apart). The worker also starts the browser runner, and
    // deletes the Cognito users of deleted accounts. A combined task's role holds the union,
    // since its two containers share it.
    const grant = (role: iam.IRole, containers: readonly ServiceName[]): void => {
      props.photoBucket.grantReadWrite(role);
      if (containers.includes('api')) {
        // Invites (docs/features/invites.md): the API creates the users of people who redeem
        // an invite, removes one whose email they corrected, and signs out and disables (or
        // enables again) one whose invite is revoked (or restored).
        props.userPool?.pool.grant(
          role,
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminUserGlobalSignOut',
        );
        // In SES's sandbox, each invitee's address becomes a verified email identity, so the
        // pool's codes reach it: email addresses only (`*@*`), never a domain.
        if (props.userPool && sesVerifiesInvitees(settings.signIn)) {
          role.addToPrincipalPolicy(
            new iam.PolicyStatement({
              sid: 'VerifyInviteeAddresses',
              actions: [
                'ses:CreateEmailIdentity',
                'ses:GetEmailIdentity',
                'ses:DeleteEmailIdentity',
              ],
              resources: [
                this.formatArn({ service: 'ses', resource: 'identity', resourceName: '*@*' }),
              ],
            }),
          );
        }
      }
      if (containers.includes('worker')) {
        props.userPool?.pool.grant(role, 'cognito-idp:AdminGetUser', 'cognito-idp:AdminDeleteUser');
        // Raw sale emails: read each one, and delete it once processed.
        props.inboundMailBucket.grantRead(role, `${INBOUND_MAIL_PREFIX}*`);
        props.inboundMailBucket.grantDelete(role, `${INBOUND_MAIL_PREFIX}*`);
        props.saleEmail?.queue.grantConsumeMessages(role);
        role.addToPrincipalPolicy(startRunner(this.runnerServiceArn(environment)));
        // Package photos (docs/features/pack-check.md): the CDN drops its copies of the public
        // ones the worker moved to private keys.
        role.addToPrincipalPolicy(
          new iam.PolicyStatement({
            sid: 'InvalidatePhotoCdn',
            actions: ['cloudfront:CreateInvalidation'],
            resources: [
              this.formatArn({
                service: 'cloudfront',
                region: '',
                resource: 'distribution',
                resourceName: props.photoCdnDistributionId,
              }),
            ],
          }),
        );
        // Owner alerts about failing background reads, from the alert sender to the alarm email.
        if (target.alarmEmail !== undefined) {
          role.addToPrincipalPolicy(alertSendStatement(this, target, target.alarmEmail));
        }
        role.addToPrincipalPolicy(
          new iam.PolicyStatement({
            sid: 'OpenTokens',
            actions: ['kms:Decrypt'],
            resources: [props.tokenKey.keyArn],
            conditions: {
              StringEquals: { 'kms:EncryptionContext:purpose': CREDENTIAL_PURPOSES.tokens },
            },
          }),
        );
      }
      props.tokenKey.grant(role, 'kms:GenerateDataKey');
    };

    const layout = settings.services;
    let apiService: ecs.FargateService;
    switch (layout.layout) {
      case 'separate': {
        const api = this.taskDefinition(props, 'api', layout.api, ['api']);
        const worker = this.taskDefinition(props, 'worker', layout.worker, ['worker']);
        grant(api.taskRole, ['api']);
        grant(worker.taskRole, ['worker']);
        apiService = this.service(props, 'api', api, layout.api, [props.apiSecurityGroup]);
        const workerService = this.service(props, 'worker', worker, layout.worker, [
          props.workerSecurityGroup,
        ]);
        this.services = [
          { name: 'api', service: apiService },
          { name: 'worker', service: workerService },
        ];
        break;
      }
      case 'combined': {
        const app = this.taskDefinition(props, 'app', layout.app, ['api', 'worker']);
        grant(app.taskRole, ['api', 'worker']);
        // Both groups: the API's admits the ingress, and the database admits each of them.
        apiService = this.service(props, 'app', app, layout.app, [
          props.apiSecurityGroup,
          props.workerSecurityGroup,
        ]);
        this.services = [{ name: 'app', service: apiService }];
        break;
      }
      default:
        assertNever(layout);
    }

    const runner = this.runner(props, resources, url);

    const apiDomain = target.dns === undefined ? undefined : this.apiDomain(target.dns);
    let apiUrl: string;
    switch (settings.ingress.via) {
      case 'load-balancer': {
        // loadDeployTarget requires a domain for this ingress.
        if (apiDomain === undefined) throw new Error('a load balancer needs the API domain');
        const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
          loadBalancerName: `listora-${environment}-api`,
          vpc: props.vpc,
          vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
          internetFacing: true,
          securityGroup: props.ingressSecurityGroup,
          dropInvalidHeaderFields: true,
          deletionProtection: settings.protectData,
        });
        loadBalancer.addRedirect({ sourcePort: 80, targetPort: 443, open: false });
        const https = loadBalancer.addListener('Https', {
          port: 443,
          certificates: [apiDomain.certificate],
          sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
          open: false,
        });
        const targetGroup = https.addTargets('Api', {
          port: API_PORT,
          protocol: elbv2.ApplicationProtocol.HTTP,
          targets: [
            apiService.loadBalancerTarget({ containerName: 'api', containerPort: API_PORT }),
          ],
          deregistrationDelay: Duration.seconds(30),
          healthCheck: {
            // Liveness, not readiness (apps/api/src/health.ts): ECS replaces tasks that fail
            // this check, and a database failover must not restart every API task at once.
            path: '/health/live',
            healthyHttpCodes: '200',
            interval: Duration.seconds(15),
            timeout: Duration.seconds(5),
            healthyThresholdCount: 2,
            unhealthyThresholdCount: 3,
          },
        });
        this.endpoint = { kind: 'load-balancer', loadBalancer, targetGroup };
        apiUrl = apiDomain.alias(new route53Targets.LoadBalancerTarget(loadBalancer));
        break;
      }
      case 'http-api': {
        // ECS registers each running API container (address and port, an SRV record) in Cloud
        // Map; the VPC link sends each request to a healthy one.
        const namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
          name: `${environment}.listora.internal`,
          vpc: props.vpc,
          description: `Listora ${environment} service discovery`,
        });
        const apiContainer = apiService.taskDefinition.findContainer('api');
        if (apiContainer === undefined) throw new Error('the API service has no api container');
        const discovery = apiService.enableCloudMap({
          name: 'api',
          cloudMapNamespace: namespace,
          dnsRecordType: servicediscovery.DnsRecordType.SRV,
          dnsTtl: Duration.seconds(10),
          container: apiContainer,
          containerPort: API_PORT,
        });
        const vpcLink = new apigwv2.VpcLink(this, 'VpcLink', {
          vpcLinkName: `listora-${environment}-api`,
          vpc: props.vpc,
          subnets: taskPlacement(settings).subnets,
          securityGroups: [props.ingressSecurityGroup],
        });
        const { disableDefaultEndpoint } = settings.ingress;
        // loadDeployTarget requires a domain when the execute-api URL is off.
        if (disableDefaultEndpoint && apiDomain === undefined) {
          throw new Error('an HTTP API without its default endpoint needs the API domain');
        }
        const custom =
          apiDomain === undefined
            ? undefined
            : {
                ...apiDomain,
                domainName: new apigwv2.DomainName(this, 'ApiDomain', {
                  domainName: apiDomain.name,
                  certificate: apiDomain.certificate,
                  securityPolicy: apigwv2.SecurityPolicy.TLS_1_2,
                }),
              };
        const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
          apiName: `listora-${environment}-api`,
          description: `Listora ${environment} API`,
          // Kept on after a domain is added, until every URL registered with a third party
          // has moved to https://api.<domain>.
          disableExecuteApiEndpoint: disableDefaultEndpoint,
          createDefaultStage: false,
          defaultIntegration: new integrations.HttpServiceDiscoveryIntegration('Api', discovery, {
            vpcLink,
          }),
        });
        new apigwv2.HttpStage(this, 'DefaultStage', {
          httpApi,
          stageName: '$default',
          autoDeploy: true,
          throttle: HTTP_API_THROTTLE,
          ...(custom === undefined ? {} : { domainMapping: { domainName: custom.domainName } }),
        });
        this.endpoint = { kind: 'http-api', httpApi };
        apiUrl =
          custom === undefined
            ? httpApi.apiEndpoint
            : custom.alias(
                new route53Targets.ApiGatewayv2DomainProperties(
                  custom.domainName.regionalDomainName,
                  custom.domainName.regionalHostedZoneId,
                ),
              );
        break;
      }
      default:
        assertNever(settings.ingress);
    }

    new CfnOutput(this, 'ApiUrl', { value: apiUrl });
    new CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    new CfnOutput(this, 'RunnerServiceName', { value: runner.serviceName });
  }

  /**
   * The browser runner: a task of the configured size (`browserRunner`) from the runner image,
   * with a writable `/tmp` for Chromium on an otherwise read-only file system (the image
   * declares it a volume its unprivileged user owns, or Fargate would create it root-owned and
   * read-only for that user; the Dockerfile's runner stage), in the worker's network place and
   * security group (database access, internet egress, no ingress), and a role that may decrypt
   * sellers' sessions (and only those), store the screenshots of failed runs, and scale its own
   * service to zero.
   */
  private runner(
    {
      settings,
      target,
      runnerRepository,
      database,
      tokenKey,
      photoBucket,
      workerSecurityGroup,
    }: ComputeStackProps,
    resources: ServiceResources,
    url: string,
  ): ecs.FargateService {
    const environment = target.environment;
    const size = settings.browserRunner;
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'runner-task', {
      family: `listora-${environment}-runner`,
      cpu: size.cpu,
      memoryLimitMiB: size.memoryMiB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      volumes: [{ name: 'tmp' }],
    });
    const logGroup = new logs.LogGroup(this, 'runner-logs', {
      logGroupName: `/listora/${environment}/runner`,
      retention: settings.logRetention,
      removalPolicy: removalPolicyFor(settings),
    });
    const container = taskDefinition.addContainer('runner', {
      image: ecs.ContainerImage.fromEcrRepository(runnerRepository, target.imageTag),
      command: [...RUNNER_COMMAND],
      environment: containerEnvironment('runner', url, resources),
      secrets: containerSecrets(this, environment, 'runner', database),
      readonlyRootFilesystem: true,
      // A step cut short by the stop is read back by the engine, never trusted.
      stopTimeout: Duration.seconds(30),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'runner' }),
    });
    container.addMountPoints({ containerPath: '/tmp', sourceVolume: 'tmp', readOnly: false });

    const placement = taskPlacement(settings);
    const service = new ecs.FargateService(this, 'runner-service', {
      serviceName: RUNNER_SERVICE_NAME,
      cluster: this.cluster,
      taskDefinition,
      vpcSubnets: placement.subnets,
      securityGroups: [workerSecurityGroup],
      assignPublicIp: placement.assignPublicIp,
      desiredCount: 0,
      // Never two runners at once: the old task stops before a new one starts.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: true },
      propagateTags: ecs.PropagatedTagSource.SERVICE,
    });

    const role = taskDefinition.taskRole;
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'SealAndOpenSessions',
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: [tokenKey.keyArn],
        conditions: {
          StringEquals: { 'kms:EncryptionContext:purpose': CREDENTIAL_PURPOSES.session },
        },
      }),
    );
    photoBucket.grantPut(role, `${AUTOMATION_SCREENSHOT_PREFIX}*`);
    role.addToPrincipalPolicy(startRunner(this.runnerServiceArn(environment)));
    return service;
  }

  /** Built from its names: the runner's own role cannot reference the service it runs in. */
  private runnerServiceArn(environment: string): string {
    return this.formatArn({
      service: 'ecs',
      resource: 'service',
      resourceName: `${clusterName(environment)}/${RUNNER_SERVICE_NAME}`,
    });
  }

  /**
   * `api.<domain>`: its certificate, validated in the domain's hosted zone, and `alias`, which
   * points the name at the endpoint and returns the API's URL.
   */
  private apiDomain(dns: DnsTarget): {
    readonly name: string;
    readonly certificate: acm.ICertificate;
    readonly alias: (target: route53.IAliasRecordTarget) => string;
  } {
    const name = `${API_SUBDOMAIN}.${dns.domain}`;
    const zone = route53.PublicHostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: dns.hostedZoneId,
      zoneName: dns.domain,
    });
    const certificate = new acm.Certificate(this, 'ApiCertificate', {
      domainName: name,
      validation: acm.CertificateValidation.fromDns(zone),
    });
    const alias = (target: route53.IAliasRecordTarget): string => {
      new route53.ARecord(this, 'ApiAlias', {
        zone,
        recordName: API_SUBDOMAIN,
        target: route53.RecordTarget.fromAlias(target),
      });
      return `https://${name}`;
    };
    return { name, certificate, alias };
  }

  /**
   * A task definition `listora-<environment>-<name>` running the given containers, each
   * logging to `/listora/<environment>/<container>`.
   */
  private taskDefinition(
    { settings, target }: ListoraStackProps,
    name: string,
    size: ServiceSize,
    containers: readonly ServiceName[],
  ): ecs.FargateTaskDefinition {
    const environment = target.environment;
    const logGroups = containers.map(
      (container) =>
        new logs.LogGroup(this, `${container}-logs`, {
          logGroupName: `/listora/${environment}/${container}`,
          retention: settings.logRetention,
          removalPolicy: removalPolicyFor(settings),
        }),
    );
    const taskDefinition = new ecs.FargateTaskDefinition(this, `${name}-task`, {
      family: `listora-${environment}-${name}`,
      cpu: size.cpu,
      memoryLimitMiB: size.memoryMiB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    containers.forEach((container, index) => {
      const logGroup = logGroups[index];
      if (logGroup === undefined) throw new Error(`no log group for ${container}`);
      taskDefinition.addContainer(container, {
        ...this.containerOptions(container),
        logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: container }),
      });
    });
    return taskDefinition;
  }

  private service(
    { settings }: ListoraStackProps,
    name: string,
    taskDefinition: ecs.FargateTaskDefinition,
    size: ServiceSize,
    securityGroups: ec2.ISecurityGroup[],
  ): ecs.FargateService {
    const placement = taskPlacement(settings);
    const runsApi = taskDefinition.findContainer('api') !== undefined;
    const fargate = new ecs.FargateService(this, `${name}-service`, {
      serviceName: name,
      cluster: this.cluster,
      taskDefinition,
      vpcSubnets: placement.subnets,
      securityGroups,
      assignPublicIp: placement.assignPublicIp,
      // A deploy whose tasks never become healthy rolls back to the previous revision.
      circuitBreaker: { enable: true, rollback: true },
      // A deploy starts the new tasks, waits until they are healthy, then stops the old ones,
      // so the API is up throughout, also in personal with its one task.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      ...(runsApi && settings.ingress.via === 'load-balancer'
        ? { healthCheckGracePeriod: Duration.seconds(60) }
        : {}),
    });
    const scaling = fargate.autoScaleTaskCount({
      minCapacity: size.minTasks,
      maxCapacity: size.maxTasks,
    });
    if (size.maxTasks > size.minTasks) {
      scaling.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: TARGET_CPU_PERCENT });
    }
    return fargate;
  }
}

/**
 * The API container's own liveness check, run inside the container (the image has Node but
 * no curl): the same `/health/live` the load balancer checks, which checks no dependency.
 */
function apiHealthCheck(): ecs.HealthCheck {
  const probe =
    `fetch('http://127.0.0.1:${String(API_PORT)}/health/live')` +
    '.then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))';
  return {
    command: ['CMD', 'node', '-e', probe],
    interval: Duration.seconds(15),
    timeout: Duration.seconds(5),
    retries: 3,
    startPeriod: Duration.seconds(30),
  };
}

/** Changing the runner service's desired count: the worker starts it, the runner stops it. */
function startRunner(runnerServiceArn: string): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'ScaleBrowserRunner',
    actions: ['ecs:UpdateService'],
    resources: [runnerServiceArn],
  });
}
