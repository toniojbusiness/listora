import { assertNever } from '@listora/shared';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

import { AVAILABILITY_ZONE_COUNT } from '../config.ts';
import { API_PORT } from '../containers.ts';
import { ListoraStack, removalPolicyFor, type ListoraStackProps } from './common.ts';

/** PostgreSQL's port, the only one the database security group opens. */
export const DATABASE_PORT = 5432;

/**
 * VPC and security groups, in two availability zones. With NAT egress there are three subnet
 * tiers: `public` (load balancer, NAT), `app` (Fargate tasks, egress through NAT), and `data`
 * (RDS, no internet route). With public-IP egress the tasks run in `public` and there is no
 * `app` tier and no NAT. Every security group lives here so the data and compute stacks can
 * reference one another's groups without a dependency cycle.
 */
export class NetworkStack extends ListoraStack {
  readonly vpc: ec2.Vpc;
  /**
   * The group the API's traffic arrives from: the load balancer's, or the API Gateway VPC
   * link's (`ingress`). Only a load balancer is open to the internet.
   */
  readonly ingressSecurityGroup: ec2.SecurityGroup;
  readonly apiSecurityGroup: ec2.SecurityGroup;
  readonly workerSecurityGroup: ec2.SecurityGroup;
  readonly databaseSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: ListoraStackProps) {
    super(scope, id, props);
    const { settings, target } = props;
    const egress = settings.network.taskEgress;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `listora-${target.environment}`,
      ipAddresses: ec2.IpAddresses.cidr(settings.network.cidr),
      maxAzs: AVAILABILITY_ZONE_COUNT,
      natGateways: egress.via === 'nat' ? egress.natGateways : 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        ...(egress.via === 'nat'
          ? [{ name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 }]
          : []),
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      // Free; keeps photo and image-layer traffic off the NAT gateways and public addresses.
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
      restrictDefaultSecurityGroup: true,
    });

    if (settings.network.rejectedFlowLogs) {
      const flowLogs = new logs.LogGroup(this, 'RejectedFlowLogs', {
        logGroupName: `/listora/${target.environment}/vpc-rejected`,
        retention: settings.logRetention,
        removalPolicy: removalPolicyFor(settings),
      });
      this.vpc.addFlowLog('RejectedTraffic', {
        destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogs),
        trafficType: ec2.FlowLogTrafficType.REJECT,
      });
    }

    let ingressName: string;
    switch (settings.ingress.via) {
      case 'load-balancer':
        ingressName = 'the load balancer';
        this.ingressSecurityGroup = this.securityGroup('LoadBalancer', 'API load balancer');
        this.ingressSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
        this.ingressSecurityGroup.addIngressRule(
          ec2.Peer.anyIpv4(),
          ec2.Port.tcp(80),
          'HTTP, redirected to HTTPS',
        );
        break;
      case 'http-api':
        ingressName = 'the VPC link';
        // The VPC link's network interfaces only open connections to the tasks; nothing
        // connects to them.
        this.ingressSecurityGroup = this.securityGroup('VpcLink', 'API Gateway VPC link');
        break;
      default:
        assertNever(settings.ingress);
    }
    this.apiSecurityGroup = this.securityGroup('Api', 'API tasks', true);
    this.apiSecurityGroup.addIngressRule(
      this.ingressSecurityGroup,
      ec2.Port.tcp(API_PORT),
      `From ${ingressName}`,
    );
    this.ingressSecurityGroup.addEgressRule(
      this.apiSecurityGroup,
      ec2.Port.tcp(API_PORT),
      'To API tasks',
    );

    this.workerSecurityGroup = this.securityGroup('Worker', 'Worker tasks (no inbound)', true);

    this.databaseSecurityGroup = this.securityGroup('Database', 'PostgreSQL');
    for (const [peer, name] of [
      [this.apiSecurityGroup, 'API'],
      [this.workerSecurityGroup, 'worker'],
    ] as const) {
      this.databaseSecurityGroup.addIngressRule(
        peer,
        ec2.Port.tcp(DATABASE_PORT),
        `From ${name} tasks`,
      );
    }
  }

  /**
   * A security group with no rules yet. Only task groups get unrestricted egress (marketplace,
   * AI, and AWS APIs); the ingress and database groups get explicit rules only.
   */
  private securityGroup(id: string, description: string, allowAllOutbound = false) {
    return new ec2.SecurityGroup(this, `${id}SecurityGroup`, {
      vpc: this.vpc,
      description: `Listora ${description}`,
      allowAllOutbound,
    });
  }
}
