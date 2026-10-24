import { assertNever } from '@listora/shared';
import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';

import { METRIC_NAMESPACE, type TrustMetricName } from '@listora/observability/catalog';

import type { EnvironmentSettings } from '../config.ts';
import { ListoraStack, type ListoraStackProps } from './common.ts';
import type { ApiEndpoint, ListoraService } from './compute-stack.ts';

export interface ObservabilityStackProps extends ListoraStackProps {
  readonly endpoint: ApiEndpoint;
  readonly services: readonly ListoraService[];
  readonly database: rds.DatabaseInstance;
}

const GIB = 1024 ** 3;

interface AlarmOptions {
  comparison?: cloudwatch.ComparisonOperator;
  evaluationPeriods?: number;
  datapointsToAlarm?: number;
  missingData?: cloudwatch.TreatMissingData;
}

/** Creates the alarm `listora-<environment>-<id>`, notifying the topic on alarm and recovery. */
type AlarmFactory = (
  id: string,
  description: string,
  metric: cloudwatch.IMetric,
  threshold: number,
  options?: AlarmOptions,
) => void;

/** The fewest tasks the named service (api, worker, or app) runs. */
function serviceMinimum(settings: EnvironmentSettings, name: string): number {
  const layout = settings.services;
  switch (layout.layout) {
    case 'separate':
      if (name === 'api' || name === 'worker') return layout[name].minTasks;
      break;
    case 'combined':
      if (name === 'app') return layout.app.minTasks;
      break;
    default:
      assertNever(layout);
  }
  throw new Error(`no service named ${name}`);
}

/**
 * Baseline alarms on the platform: API errors, health, and latency (from the load balancer or
 * the HTTP API, whichever serves the API); running tasks, CPU, and memory per service; database
 * CPU, storage, and memory. Then the product's trust alarms, on the metrics the worker
 * publishes (`trustAlarms`). Every alarm notifies the alarm topic when it fires and when it
 * recovers. Database storage has two signals: the free-storage alarm (autoscaling is not
 * keeping up) and RDS's own low-storage events, which include storage autoscaling reaching its
 * ceiling, so the ceiling alerts well before writes stop. Every unplanned task stop (a crash,
 * an exited container, a failed health check) is also sent to the topic. Log groups live next
 * to what writes them (compute, migrate, data, network) with the environment's retention.
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

    const alarm: AlarmFactory = (id, description, metric, threshold, options = {}) => {
      const created = new cloudwatch.Alarm(this, id, {
        alarmName: `${prefix}-${id}`,
        alarmDescription: description,
        metric,
        threshold,
        comparisonOperator:
          options.comparison ?? cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: options.evaluationPeriods ?? 3,
        ...(options.datapointsToAlarm === undefined
          ? {}
          : { datapointsToAlarm: options.datapointsToAlarm }),
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
        // is registered, 504 after 30 seconds) together. One user sends few requests, so any
        // server error counts; 2 of 3 periods keeps a single blip quiet.
        alarm(
          'api-5xx',
          'The API answered server errors in at least 2 of 3 consecutive 5-minute periods.',
          api.metricServerError({ period: fiveMinutes, statistic: 'Sum' }),
          1,
          { datapointsToAlarm: 2 },
        );
        alarm(
          'api-latency-p95',
          'API p95 response time stayed above 2 seconds for 15 minutes.',
          api.metricIntegrationLatency({ period: fiveMinutes, statistic: 'p95' }),
          2000,
          { comparison: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD },
        );
        break;
      }
      default:
        assertNever(endpoint);
    }

    for (const { name, service } of props.services) {
      this.runningTasksAlarm(alarm, settings, name, service);
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

    this.alertOnUnplannedTaskStops(prefix, props.services);
    this.trustAlarms(alarm, settings);

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

  /**
   * `<service>-running-tasks`: the service ran fewer tasks than it should for 3 minutes (a
   * worker that stops leaves operations unverified while every API alarm stays quiet). With
   * Container Insights, running is compared with desired. Without it, ECS still reports a
   * service's CPU every minute from each running task, so the number of samples is the number
   * of running tasks, held against the service's minimum. Deploys never drop below either:
   * they start new tasks before stopping old ones (minimum healthy 100%).
   */
  private runningTasksAlarm(
    alarm: AlarmFactory,
    settings: EnvironmentSettings,
    name: string,
    service: ecs.FargateService,
  ): void {
    const minute = Duration.minutes(1);
    const id = `${name}-running-tasks`;
    if (settings.containerInsights) {
      const taskCount = (metricName: string, statistic: string): cloudwatch.Metric =>
        new cloudwatch.Metric({
          namespace: 'ECS/ContainerInsights',
          metricName,
          dimensionsMap: {
            ClusterName: service.cluster.clusterName,
            ServiceName: service.serviceName,
          },
          statistic,
          period: minute,
        });
      alarm(
        id,
        `The ${name} service ran fewer tasks than desired for 3 minutes.`,
        new cloudwatch.MathExpression({
          expression: 'desired - running',
          usingMetrics: {
            desired: taskCount('DesiredTaskCount', 'Maximum'),
            running: taskCount('RunningTaskCount', 'Minimum'),
          },
          period: minute,
          label: 'Tasks short of desired',
        }),
        1,
        { missingData: cloudwatch.TreatMissingData.BREACHING },
      );
      return;
    }
    const minimum = serviceMinimum(settings, name);
    alarm(
      id,
      `The ${name} service ran fewer than its ${String(minimum)} minimum tasks for 3 minutes.`,
      service.metricCpuUtilization({ period: minute, statistic: 'SampleCount' }),
      minimum,
      {
        comparison: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        // No samples means no task: exactly the failure this alarm exists for.
        missingData: cloudwatch.TreatMissingData.BREACHING,
      },
    );
  }

  /**
   * The product's trust alarms, on the metrics the worker publishes (@listora/observability):
   * an operation unverified for over 30 minutes, any failed delist, an account's AI cost today
   * over the threshold, a connection the seller must link again, and per marketplace, the p95
   * delist latency over an hour above its threshold and a verified-success rate over a day
   * below 90%. Missing data is not breaching: the worker publishes nothing while it is down,
   * which the running-tasks alarm covers, and nothing for a marketplace without operations.
   */
  private trustAlarms(alarm: AlarmFactory, settings: EnvironmentSettings): void {
    const trust = (
      metricName: TrustMetricName,
      statistic: string,
      options: { period?: Duration; dimensions?: Record<string, string> } = {},
    ): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName,
        statistic,
        period: options.period ?? Duration.minutes(5),
        ...(options.dimensions === undefined ? {} : { dimensionsMap: options.dimensions }),
      });
    alarm(
      'operation-unverified',
      'A marketplace operation has gone 30 minutes without a verified result (queued, running, ' +
        'retrying, or verifying): its status may be wrong or stuck.',
      trust('OldestUnverifiedOperationAge', 'Maximum'),
      30 * 60,
      { evaluationPeriods: 1 },
    );
    alarm(
      'delist-failed',
      'A delist (end or mark-sold) failed on a marketplace: the item may still be for sale there.',
      trust('DelistFailed', 'Sum'),
      1,
      { evaluationPeriods: 1 },
    );
    alarm(
      'ai-daily-cost',
      `An account's AI cost today (UTC) reached $${settings.aiDailyCostAlarmUsd.toFixed(2)}.`,
      trust('AiDailyCostUsd', 'Maximum'),
      settings.aiDailyCostAlarmUsd,
      { evaluationPeriods: 1 },
    );
    // A level, not an increase: while one connection waits for its seller, the alarm stays in
    // ALARM and another connection breaking sends nothing new. That suits one seller
    // (personal); an environment with many sellers should alarm on increases instead.
    alarm(
      'connection-needs-relink',
      'A marketplace connection needs the seller to link it again (reauth_required or revoked).',
      trust('ConnectionsNeedingRelink', 'Maximum'),
      1,
      { evaluationPeriods: 1 },
    );
    const latencies = Object.entries(settings.delistLatencyAlarmMinutes);
    for (const [marketplace, minutes] of latencies) {
      const limit =
        minutes % 60 === 0 ? `${String(minutes / 60)} hours` : `${String(minutes)} minutes`;
      alarm(
        `delist-latency-${marketplace}`,
        `The p95 delist latency on ${marketplace} over the last hour (from the sale being ` +
          `recorded to the verified delist) exceeded ${limit}: sold items stay for sale there.`,
        trust('DelistLatency', 'p95', {
          period: Duration.hours(1),
          dimensions: { Marketplace: marketplace },
        }),
        minutes * 60_000,
        { comparison: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, evaluationPeriods: 1 },
      );
    }
    for (const [marketplace] of latencies) {
      alarm(
        `verified-success-${marketplace}`,
        `Fewer than 90% of the ${marketplace} operations that settled over the last day ` +
          'succeeded with a verified result.',
        trust('VerifiedSuccess', 'Average', {
          period: Duration.days(1),
          dimensions: { Marketplace: marketplace },
        }),
        0.9,
        { comparison: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD, evaluationPeriods: 1 },
      );
    }
  }

  /**
   * Sends every task stop that no deploy or scale-in asked for to the alarm topic. A crash
   * loop keeps the services' CPU samples coming from each replacement task, so no alarm sees
   * it; the stop events do. Deploys and scale-ins stop tasks with a reason that starts with
   * `Scaling activity initiated by`. AWS service events reach SNS at no EventBridge charge.
   */
  private alertOnUnplannedTaskStops(prefix: string, services: readonly ListoraService[]): void {
    const cluster = services[0]?.service.cluster;
    if (cluster === undefined) throw new Error('no service to watch');
    const rule = new events.Rule(this, 'TaskStopped', {
      ruleName: `${prefix}-task-stopped`,
      description: 'Unplanned ECS task stops: crashes, exited containers, failed health checks.',
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          clusterArn: [cluster.clusterArn],
          group: services.map(({ name }) => `service:${name}`),
          lastStatus: ['STOPPED'],
          stoppedReason: events.Match.anythingButPrefix('Scaling activity initiated by'),
        },
      },
    });
    const field = (path: string): string => events.EventField.fromPath(`$.detail.${path}`);
    const topic = this.alarmTopic;
    rule.addTarget({
      bind: () => ({
        arn: topic.topicArn,
        input: events.RuleTargetInput.fromText(
          `ECS stopped a ${field('group')} task in ${prefix}: ${field('stoppedReason')} ` +
            `(stop code ${field('stopCode')}, task ${field('taskArn')}).`,
        ),
      }),
    });
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'TaskStoppedEvents',
        actions: ['sns:Publish'],
        principals: [new iam.ServicePrincipal('events.amazonaws.com')],
        resources: [topic.topicArn],
        conditions: { ArnEquals: { 'aws:SourceArn': rule.ruleArn } },
      }),
    );
  }
}
