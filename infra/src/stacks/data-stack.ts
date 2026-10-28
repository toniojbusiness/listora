import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import type { Construct } from 'constructs';

import { secretName } from '../config.ts';
import { ListoraStack, removalPolicyFor, type ListoraStackProps } from './common.ts';
import { DATABASE_PORT } from './network-stack.ts';

export interface DataStackProps extends ListoraStackProps {
  readonly vpc: ec2.IVpc;
  readonly securityGroup: ec2.ISecurityGroup;
}

/** The application database's name and its owner role (the generated secret's user). */
export const DATABASE_NAME = 'listora';
export const DATABASE_USER = 'listora';

/**
 * RDS PostgreSQL 18 in the isolated `data` subnets: encrypted storage, TLS required, daily
 * backups, Multi-AZ and deletion protection per environment, and a final snapshot when the
 * instance is removed. RDS generates the password into `listora/<environment>/database`.
 */
export class DataStack extends ListoraStack {
  readonly database: rds.DatabaseInstance;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { settings, target } = props;
    const db = settings.database;
    const instanceIdentifier = `listora-${target.environment}`;
    const engine = rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_18,
    });

    // Created here, before the instance, so its retention is ours (RDS would create it with
    // no expiry). The name is the one RDS writes `postgresql` logs to.
    const logGroup = new logs.LogGroup(this, 'PostgresLogs', {
      logGroupName: `/aws/rds/instance/${instanceIdentifier}/postgresql`,
      retention: settings.logRetention,
      removalPolicy: removalPolicyFor(settings),
    });

    const parameterGroup = new rds.ParameterGroup(this, 'Parameters', {
      engine,
      description: `Listora ${target.environment} PostgreSQL parameters`,
      parameters: {
        // Already the RDS default since PostgreSQL 15; pinned so it can never be turned off.
        'rds.force_ssl': '1',
        // Statements slower than one second are logged for diagnosis.
        log_min_duration_statement: '1000',
        // Without their bind parameters: those are sellers' and buyers' values (names,
        // addresses, codes), and the logs go to CloudWatch. Errors log none either.
        log_parameter_max_length: '0',
        log_parameter_max_length_on_error: '0',
      },
    });

    this.database = new rds.DatabaseInstance(this, 'Postgres', {
      instanceIdentifier,
      engine,
      parameterGroup,
      instanceType: new ec2.InstanceType(db.instanceType),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.securityGroup],
      port: DATABASE_PORT,
      publiclyAccessible: false,
      databaseName: DATABASE_NAME,
      credentials: rds.Credentials.fromGeneratedSecret(DATABASE_USER, {
        secretName: secretName(target.environment, 'database'),
      }),
      multiAz: db.multiAz,
      storageType: rds.StorageType.GP3,
      allocatedStorage: db.allocatedStorageGiB,
      maxAllocatedStorage: db.maxAllocatedStorageGiB,
      storageEncrypted: true,
      caCertificate: rds.CaCertificate.RDS_CA_RSA2048_G1,
      backupRetention: Duration.days(db.backupRetentionDays),
      // UTC; 07:00 is the small hours across US time zones.
      preferredBackupWindow: '07:00-08:00',
      preferredMaintenanceWindow: 'sun:08:30-sun:09:30',
      autoMinorVersionUpgrade: true,
      allowMajorVersionUpgrade: false,
      copyTagsToSnapshot: true,
      deletionProtection: settings.protectData,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      enablePerformanceInsights: db.performanceInsights,
      cloudwatchLogsExports: ['postgresql'],
    });
    this.database.node.addDependency(logGroup);
  }
}
