import { CfnOutput, Duration } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

import type { ServiceName, ServiceSize } from '../config.ts';
import { API_PORT, containerEnvironment, SERVICE_COMMANDS } from '../containers.ts';
import { ListoraStack, removalPolicyFor, type ListoraStackProps } from './common.ts';
import { INBOUND_MAIL_PREFIX } from './email-stack.ts';
import { containerSecrets, databaseUrl } from './task-config.ts';

export interface ComputeStackProps extends ListoraStackProps {
  readonly vpc: ec2.IVpc;
  readonly loadBalancerSecurityGroup: ec2.ISecurityGroup;
  readonly apiSecurityGroup: ec2.ISecurityGroup;
  readonly workerSecurityGroup: ec2.ISecurityGroup;
  readonly database: rds.DatabaseInstance;
  readonly repository: ecr.IRepository;
  readonly photoBucket: s3.IBucket;
  readonly inboundMailBucket: s3.IBucket;
  readonly tokenKey: kms.IKey;
}

/** Label under the environment's domain that serves the API. */
export const API_SUBDOMAIN = 'api';

/** Target CPU utilization for service autoscaling. */
const TARGET_CPU_PERCENT = 60;

/**
 * Fargate services for the API and the worker on one ECS cluster, plus the public
 * load balancer for the API at `https://api.<domain>`.
 *
 * Container configuration comes from `containerEnvironment` (src/containers.ts). The database
 * password reaches the processes only as `PGPASSWORD`, injected by ECS from the RDS-generated
 * secret, so no secret appears in a task definition. Each service has its own task role,
 * granted only the resources that service is designed to use.
 *
 * The services set no desired count: CloudFormation would reset the running count to it on
 * every deploy. Autoscaling owns the count, between `minTasks` and `maxTasks`.
 */
export class ComputeStack extends ListoraStack {
  readonly cluster: ecs.Cluster;
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly apiTargetGroup: elbv2.ApplicationTargetGroup;
  readonly apiService: ecs.FargateService;
  readonly workerService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    const { settings, target } = props;
    const environment = target.environment;
    const apiDomain = `${API_SUBDOMAIN}.${target.domain}`;

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `listora-${environment}`,
      vpc: props.vpc,
      containerInsightsV2: settings.containerInsights
        ? ecs.ContainerInsights.ENABLED
        : ecs.ContainerInsights.DISABLED,
    });

    const image = ecs.ContainerImage.fromEcrRepository(props.repository, target.imageTag);
    const url = databaseUrl(props.database);

    const api = this.taskDefinition(props, 'api', {
      image,
      environment: containerEnvironment('api', url),
      secrets: containerSecrets(this, environment, 'api', props.database),
      portMappings: [{ containerPort: API_PORT }],
    });

    const worker = this.taskDefinition(props, 'worker', {
      image,
      environment: containerEnvironment('worker', url),
      secrets: containerSecrets(this, environment, 'worker', props.database),
      portMappings: [],
    });

    // Designed access, least privilege: photos for both (uploads, derivatives), raw sale
    // emails for the worker only, and envelope encryption of marketplace tokens for both.
    props.photoBucket.grantReadWrite(api.taskRole);
    props.photoBucket.grantReadWrite(worker.taskRole);
    props.inboundMailBucket.grantRead(worker.taskRole, `${INBOUND_MAIL_PREFIX}*`);
    for (const role of [api.taskRole, worker.taskRole]) {
      props.tokenKey.grant(role, 'kms:GenerateDataKey', 'kms:Decrypt');
    }

    this.apiService = this.service('api', api, settings.api, props.apiSecurityGroup);
    this.workerService = this.service('worker', worker, settings.worker, props.workerSecurityGroup);

    const zone = route53.PublicHostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: target.hostedZoneId,
      zoneName: target.domain,
    });
    const certificate = new acm.Certificate(this, 'ApiCertificate', {
      domainName: apiDomain,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      loadBalancerName: `listora-${environment}-api`,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      internetFacing: true,
      securityGroup: props.loadBalancerSecurityGroup,
      dropInvalidHeaderFields: true,
      deletionProtection: settings.protectData,
    });
    this.loadBalancer.addRedirect({ sourcePort: 80, targetPort: 443, open: false });
    const https = this.loadBalancer.addListener('Https', {
      port: 443,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      open: false,
    });
    this.apiTargetGroup = https.addTargets('Api', {
      port: API_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.apiService],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        // Liveness, not readiness (apps/api/src/health.ts): ECS replaces tasks that fail this
        // check, and a database failover must not restart every API task at once.
        path: '/health/live',
        healthyHttpCodes: '200',
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    new route53.ARecord(this, 'ApiAlias', {
      zone,
      recordName: API_SUBDOMAIN,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.LoadBalancerTarget(this.loadBalancer),
      ),
    });

    new CfnOutput(this, 'ApiUrl', { value: `https://${apiDomain}` });
    new CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
  }

  private taskDefinition(
    { settings, target }: ListoraStackProps,
    service: ServiceName,
    options: {
      image: ecs.ContainerImage;
      environment: Record<string, string>;
      secrets: Record<string, ecs.Secret>;
      portMappings: ecs.PortMapping[];
    },
  ): ecs.FargateTaskDefinition {
    const environment = target.environment;
    const size = settings[service];
    const logGroup = new logs.LogGroup(this, `${service}-logs`, {
      logGroupName: `/listora/${environment}/${service}`,
      retention: settings.logRetention,
      removalPolicy: removalPolicyFor(settings),
    });
    const taskDefinition = new ecs.FargateTaskDefinition(this, `${service}-task`, {
      family: `listora-${environment}-${service}`,
      cpu: size.cpu,
      memoryLimitMiB: size.memoryMiB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    taskDefinition.addContainer(service, {
      image: options.image,
      command: [...SERVICE_COMMANDS[service]],
      environment: options.environment,
      secrets: options.secrets,
      portMappings: options.portMappings,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: service }),
      readonlyRootFilesystem: true,
      // Both processes drain on SIGTERM (handleShutdownSignals in @listora/shared).
      stopTimeout: Duration.seconds(30),
    });
    return taskDefinition;
  }

  private service(
    service: ServiceName,
    taskDefinition: ecs.FargateTaskDefinition,
    size: ServiceSize,
    securityGroup: ec2.ISecurityGroup,
  ): ecs.FargateService {
    const fargate = new ecs.FargateService(this, `${service}-service`, {
      serviceName: service,
      cluster: this.cluster,
      taskDefinition,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [securityGroup],
      assignPublicIp: false,
      // A deploy whose tasks never become healthy rolls back to the previous revision.
      circuitBreaker: { enable: true, rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      ...(service === 'api' ? { healthCheckGracePeriod: Duration.seconds(60) } : {}),
    });
    const scaling = fargate.autoScaleTaskCount({
      minCapacity: size.minTasks,
      maxCapacity: size.maxTasks,
    });
    scaling.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: TARGET_CPU_PERCENT });
    return fargate;
  }
}
