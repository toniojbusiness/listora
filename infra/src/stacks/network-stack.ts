import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

import { API_PORT } from '../containers.ts';
import {
  AVAILABILITY_ZONE_COUNT,
  ListoraStack,
  removalPolicyFor,
  type ListoraStackProps,
} from './common.ts';

/** PostgreSQL's port, the only one the database security group opens. */
export const DATABASE_PORT = 5432;

/**
 * VPC and security groups. Three subnet tiers in two availability zones: `public` (load
 * balancer, NAT), `app` (Fargate tasks, egress through NAT), and `data` (RDS, no internet
 * route). Every security group lives here so the data and compute stacks can reference one
 * another's groups without a dependency cycle.
 */
export class NetworkStack extends ListoraStack {
  readonly vpc: ec2.Vpc;
  readonly loadBalancerSecurityGroup: ec2.SecurityGroup;
  readonly apiSecurityGroup: ec2.SecurityGroup;
  readonly workerSecurityGroup: ec2.SecurityGroup;
  readonly databaseSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: ListoraStackProps) {
    super(scope, id, props);
    const { settings, target } = props;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `listora-${target.environment}`,
      ipAddresses: ec2.IpAddresses.cidr(settings.network.cidr),
      maxAzs: AVAILABILITY_ZONE_COUNT,
      natGateways: settings.network.natGateways,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      // Free; keeps photo and image-layer traffic off the NAT gateways.
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
      restrictDefaultSecurityGroup: true,
    });

    const flowLogs = new logs.LogGroup(this, 'RejectedFlowLogs', {
      logGroupName: `/listora/${target.environment}/vpc-rejected`,
      retention: settings.logRetention,
      removalPolicy: removalPolicyFor(settings),
    });
    this.vpc.addFlowLog('RejectedTraffic', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogs),
      trafficType: ec2.FlowLogTrafficType.REJECT,
    });

    this.loadBalancerSecurityGroup = this.securityGroup('LoadBalancer', 'API load balancer');
    this.loadBalancerSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    this.loadBalancerSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'HTTP, redirected to HTTPS',
    );

    this.apiSecurityGroup = this.securityGroup('Api', 'API tasks', true);
    this.apiSecurityGroup.addIngressRule(
      this.loadBalancerSecurityGroup,
      ec2.Port.tcp(API_PORT),
      'From the load balancer',
    );
    this.loadBalancerSecurityGroup.addEgressRule(
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
   * AI, and AWS APIs); the load balancer and database groups get explicit rules only.
   */
  private securityGroup(id: string, description: string, allowAllOutbound = false) {
    return new ec2.SecurityGroup(this, `${id}SecurityGroup`, {
      vpc: this.vpc,
      description: `Listora ${description}`,
      allowAllOutbound,
    });
  }
}
