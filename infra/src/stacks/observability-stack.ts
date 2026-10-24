import { assertNever } from '@listora/shared';
import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';

import { ListoraStack, type ListoraStackProps } from './common.ts';
import type { ApiEndpoint, ListoraService } from './compute-stack.ts';

export interface ObservabilityStackProps extends ListoraStackProps {
  readonly endpoint: ApiEndpoint;
  readonly services: readonly ListoraService[];
  readonly database: rds.DatabaseInstance;
}

const GIB = 1024 ** 3;

/**
 * Baseline alarms on the platform: API errors, health, and latency (from the load balancer or
 * the HTTP API, whichever serves the API); service CPU and memory; database CPU, storage,
 * and memory. Every alarm notifies the alarm topic when it fires and
 * when it recovers. Database storage has two signals: the free-storage alarm (autoscaling is
 * not keeping up) and RDS's own low-storage events, which include storage autoscaling
 * reaching its ceiling, so the ceiling alerts well before writes stop. Log groups live next to what writes them (compute, migrate, data, network)
 * with the environment's retention. Product SLO alarms (delist latency, verified-success
 * rate, unverified operations, AI cost) are T-32.
 */
export class ObservabilityStack extends ListoraStack {
  readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    const { settings, target } = props;
    const prefix = `listora-${target.environment}`;

    this.alarmTopic = new sns.Topic(this, 'Alarms', {
      topicName: `${prefix}-alarms`,
      enforceSSL: true,
    });
    if (target.alarmEmail !== undefined) {
      this.alarmTopic.addSubscription(new subscriptions.EmailSubscription(target.alarmEmail));
    }
    const notify = new cloudwatchActions.SnsAction(this.alarmTopic);

    const alarm = (
      id: string,
      description: string,
      metric: cloudwatch.IMetric,
      threshold: number,
      options: {
        comparison?: cloudwatch.ComparisonOperator;
        evaluationPeriods?: number;
        missingData?: cloudwatch.TreatMissingData;
      } = {},
    ): void => {
      const created = new cloudwatch.Alarm(this, id, {
        alarmName: `${prefix}-${id}`,
        alarmDescription: description,
        metric,
        threshold,
        comparisonOperator:
          options.comparison ?? cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: options.evaluationPeriods ?? 3,
        // No data means no traffic or no samples, which is not an outage by itself.
        treatMissingData: options.missingData ?? cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      created.addAlarmAction(notify);
      created.addOkAction(notify);
    };

    const fiveMinutes = Duration.minutes(5);
    const endpoint = props.endpoint;
    switch (endpoint.kind) {
      case 'load-balancer': {
        const lb = endpoint.loadBalancer.metrics;
        const tg = endpoint.targetGroup.metrics;
        alarm(
          'api-5xx',
          'The API answered at least 10 server errors in each of 3 consecutive 5-minute periods.',
          tg.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
            period: fiveMinutes,
            statistic: 'Sum',
          }),
          10,
        );
        alarm(
          'load-balancer-5xx',
          'The load balancer itself answered server errors (often: no healthy API task).',
          lb.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
            period: fiveMinutes,
            statistic: 'Sum',
          }),
          10,
          { evaluationPeriods: 1 },
        );
        alarm(
          'api-unhealthy-tasks',
          'At least one API task failed the load balancer health check (/health/live) for 3 minutes.',
          tg.unhealthyHostCount({ period: Duration.minutes(1), statistic: 'Maximum' }),
          1,
        );
        alarm(
          'api-latency-p95',
          'API p95 response time stayed above 2 seconds for 15 minutes.',
          tg.targetResponseTime({ period: fiveMinutes, statistic: 'p95' }),
          2,
          { comparison: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD },
        );
        break;
      }
      case 'http-api': {
        const api = endpoint.httpApi;
        // The HTTP API counts the API's own server errors and its own (503 when no API task
        // is registered, 504 after 30 seconds) together.
        alarm(
          'api-5xx',
          'The API answered at least 10 server errors in each of 3 consecutive 5-minute periods.',
          api.metricServerError({ period: fiveMinutes, statistic: 'Sum' }),
          10,
        );
        alarm(
          'api-latency-p95',
          'API p95 response time stayed above 2 seconds for 15 minutes.',
          api.metricIntegrationLatency({ period: fiveMinutes, statistic: 'p95' }),
          2000,
          { comparison: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD },
        );
        // No load balancer counts healthy tasks. ECS reports a service's CPU every minute
        // while a task runs, so minutes without a sample mean no task is running.
        const apiService = props.services.find(({ service }) =>
          service.taskDefinition.findContainer('api'),
        );
        if (apiService === undefined) throw new Error('no service runs the api container');
        alarm(
          'api-no-running-task',
          `No ${apiService.name} task, so no API, has run for 3 minutes.`,
          apiService.service.metricCpuUtilization({
            period: Duration.minutes(1),
            statistic: 'SampleCount',
          }),
          1,
          {
            comparison: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
            missingData: cloudwatch.TreatMissingData.BREACHING,
          },
        );
        break;
      }
      default:
        assertNever(endpoint);
    }

    for (const { name, service } of props.services) {
      alarm(
        `${name}-cpu`,
        `The ${name} service averaged over 85% CPU for 15 minutes (at maximum scale or not scaling).`,
        service.metricCpuUtilization({ period: fiveMinutes }),
        85,
        { comparison: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD },
      );
      alarm(
        `${name}-memory`,
        `The ${name} service averaged over 85% memory for 15 minutes.`,
        service.metricMemoryUtilization({ period: fiveMinutes }),
        85,
        { comparison: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD },
      );
    }

    const db = props.database;
    // Storage autoscaling grows the volume whenever free space falls below 10% of its size, so
    // free space normally stays above 10% of the initial size. Below half of that, autoscaling
    // is no longer keeping up, most often because the volume reached its ceiling.
    const lowStorageGiB = settings.database.allocatedStorageGiB * 0.05;
    const ceilingGiB = settings.database.maxAllocatedStorageGiB;
    alarm(
      'database-cpu',
      'Database CPU stayed above 80% for 15 minutes.',
      db.metricCPUUtilization({ period: fiveMinutes }),
      80,
      { comparison: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD },
    );
    alarm(
      'database-free-storage',
      `Database free storage fell below ${String(lowStorageGiB)} GiB: storage autoscaling reached ` +
        `its ${String(ceilingGiB)} GiB ceiling (raise maxAllocatedStorageGiB) or is not keeping up.`,
      db.metricFreeStorageSpace({ period: fiveMinutes, statistic: 'Minimum' }),
      lowStorageGiB * GIB,
      {
        comparison: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 1,
        missingData: cloudwatch.TreatMissingData.BREACHING,
      },
    );
    // RDS's 'low storage' event category: free space running low, storage exhausted, and
    // storage autoscaling reaching its maximum. RDS publishes them straight to the topic.
    const storageEvents = `${prefix}-database-storage`;
    const { policyDependable } = this.alarmTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'RdsStorageEvents',
        actions: ['sns:Publish'],
        principals: [new iam.ServicePrincipal('events.rds.amazonaws.com')],
        resources: [this.alarmTopic.topicArn],
        conditions: {
          ArnEquals: {
            'aws:SourceArn': `arn:${this.partition}:rds:${this.region}:${this.account}:es:${storageEvents}`,
          },
        },
      }),
    );
    const subscription = new rds.CfnEventSubscription(this, 'DatabaseStorageEvents', {
      subscriptionName: storageEvents,
      snsTopicArn: this.alarmTopic.topicArn,
      sourceType: 'db-instance',
      sourceIds: [db.instanceIdentifier],
      eventCategories: ['low storage'],
      enabled: true,
    });
    if (policyDependable !== undefined) subscription.node.addDependency(policyDependable);

    alarm(
      'database-free-memory',
      'Database freeable memory stayed below 64 MiB for 15 minutes.',
      db.metricFreeableMemory({ period: fiveMinutes, statistic: 'Minimum' }),
      64 * 1024 ** 2,
      { comparison: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD },
    );
  }
}
