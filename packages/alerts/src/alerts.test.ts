import { describe, expect, it } from 'vitest';

import { alertEmail } from './alert-email.ts';
import { collectHealth, type HealthReader, type MetricQuery } from './collect.ts';
import { loadAlertsConfig, sendAlerts, sendWeeklySummary, type AlertsConfig } from './handler.ts';
import { RecordingMailer, subjectLine } from './mailer.ts';
import type { BackupStatus } from './summary.ts';

const CONTEXT = { environment: 'personal', region: 'us-east-1' };
const NOW = new Date('2026-11-02T14:00:12Z');

const CONFIG: AlertsConfig = {
  environment: 'personal',
  region: 'us-east-1',
  from: 'owner@example.com',
  to: 'owner@example.com',
  databaseInstanceId: 'listora-personal',
  marketplaces: ['ebay', 'depop'],
  monthlyCostThresholdUsd: 50,
};

function alarmMessage(state: string, name = 'listora-personal-worker-heartbeat'): string {
  return JSON.stringify({
    AlarmName: name,
    AlarmDescription: 'The worker published no trust metrics for 15 minutes.',
    NewStateValue: state,
    OldStateValue: state === 'OK' ? 'ALARM' : 'OK',
    NewStateReason: 'Threshold Crossed: 3 out of the last 3 datapoints were less than 1.',
    StateChangeTime: '2026-11-02T13:00:00.000+0000',
  });
}

describe('alert emails', () => {
  it('names the environment and the alarm, and links the alarm and the runbook', () => {
    const email = alertEmail(
      {
        subject: 'ALARM: "listora-personal-worker-heartbeat" in US East (N. Virginia)',
        message: alarmMessage('ALARM'),
        timestamp: '2026-11-02T13:00:01Z',
      },
      CONTEXT,
    );
    expect(email.subject).toBe('[Listora personal] ALARM: worker-heartbeat');
    expect(email.text).toContain('The worker published no trust metrics for 15 minutes.');
    expect(email.text).toContain('State: OK -> ALARM');
    expect(email.text).toContain('Threshold Crossed');
    expect(email.text).toContain(
      'https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#alarmsV2:alarm/listora-personal-worker-heartbeat',
    );
    expect(email.text).toContain('docs/features/alerts.md');
  });

  it('says when an alarm recovers', () => {
    const email = alertEmail(
      { subject: undefined, message: alarmMessage('OK'), timestamp: '2026-11-02T13:30:00Z' },
      CONTEXT,
    );
    expect(email.subject).toBe('[Listora personal] Recovered: worker-heartbeat');
    expect(email.text).toContain('back to OK');
  });

  it('describes an RDS event', () => {
    const email = alertEmail(
      {
        subject: 'RDS Notification Message',
        message: JSON.stringify({
          'Event Source': 'db-instance',
          'Event Time': '2026-11-02 13:00:00.000',
          'Source ID': 'listora-personal',
          'Event ID':
            'http://docs.amazonwebservices.com/AmazonRDS/latest/UserGuide/USER_Events.html#RDS-EVENT-0089',
          'Event Message': 'The free storage capacity for DB Instance: listora-personal is low.',
        }),
        timestamp: '2026-11-02T13:00:01Z',
      },
      CONTEXT,
    );
    expect(email.subject).toBe(
      '[Listora personal] Database event: The free storage capacity for DB Instance: listora-personal is low.',
    );
    expect(email.text).toContain('listora-personal');
  });

  it("keeps the subject of a budget notification and the rules' sentences as they are", () => {
    const budget = alertEmail(
      {
        subject: 'AWS Budgets: listora-personal-monthly-cost has exceeded your alert threshold',
        message: 'AWS Budget Notification November 02, 2026\nYou requested that we alert you...',
        timestamp: '2026-11-02T13:00:01Z',
      },
      CONTEXT,
    );
    expect(budget.subject).toBe(
      '[Listora personal] AWS Budgets: listora-personal-monthly-cost has exceeded your alert threshold',
    );
    expect(budget.text).toContain('You requested that we alert you');

    const deploy = alertEmail(
      {
        subject: undefined,
        message:
          'Deploy failed in listora-personal: CloudFormation stack arn:aws:cloudformation:us-east-1:1:stack/listora-personal-compute/x is UPDATE_ROLLBACK_COMPLETE (Resource update cancelled).',
        timestamp: '2026-11-02T13:00:01Z',
      },
      CONTEXT,
    );
    expect(deploy.subject).toMatch(/^\[Listora personal\] Deploy failed in listora-personal: /);
    expect(deploy.text).toContain('UPDATE_ROLLBACK_COMPLETE');
  });

  it('sends a message of any other shape as it came, never dropping it', () => {
    const email = alertEmail({ subject: undefined, message: '', timestamp: 'now' }, CONTEXT);
    expect(email.subject).toBe('[Listora personal] Alert');
  });

  it('keeps subjects to one short line', () => {
    expect(subjectLine('a\nb')).toBe('a b');
    const long = subjectLine('x'.repeat(500));
    expect(long).toHaveLength(200);
    expect(long.endsWith('...')).toBe(true);
  });
});

describe('the alert function', () => {
  it('emails every message of the event', async () => {
    const mailer = new RecordingMailer();
    await sendAlerts(
      {
        Records: [
          { Sns: { Subject: null, Message: alarmMessage('ALARM'), Timestamp: 't1' } },
          { Sns: { Message: 'Deploy failed in listora-personal: x', Timestamp: 't2' } },
        ],
      },
      CONFIG,
      mailer,
    );
    expect(mailer.sent.map((email) => email.subject)).toEqual([
      '[Listora personal] ALARM: worker-heartbeat',
      '[Listora personal] Deploy failed in listora-personal: x',
    ]);
  });

  it('fails when SES does, so Lambda retries the alert instead of losing it', async () => {
    const mailer = new RecordingMailer();
    mailer.failWith = new Error('Email address is not verified.');
    await expect(
      sendAlerts(
        { Records: [{ Sns: { Message: alarmMessage('ALARM'), Timestamp: 't' } }] },
        CONFIG,
        mailer,
      ),
    ).rejects.toThrow('not verified');
  });

  it('reads its configuration, naming a missing key but never a value', () => {
    const env = {
      LISTORA_ENV: 'personal',
      AWS_REGION: 'us-east-1',
      ALERT_FROM: 'owner@example.com',
      ALERT_TO: 'owner@example.com',
      DATABASE_INSTANCE_ID: 'listora-personal',
      MARKETPLACES: 'ebay,depop,poshmark,mercari',
      MONTHLY_COST_THRESHOLD_USD: '50',
    };
    expect(loadAlertsConfig(env)).toMatchObject({
      marketplaces: ['ebay', 'depop', 'poshmark', 'mercari'],
      monthlyCostThresholdUsd: 50,
    });
    expect(() => loadAlertsConfig({ ...env, ALERT_TO: '' })).toThrow('ALERT_TO is required');
    expect(() => loadAlertsConfig({ ...env, MONTHLY_COST_THRESHOLD_USD: 'lots' })).toThrow(
      'MONTHLY_COST_THRESHOLD_USD must be a positive number',
    );
  });
});

const HEALTHY_BACKUPS: BackupStatus = {
  instanceId: 'listora-personal',
  retentionDays: 7,
  deletionProtection: true,
  latestRestorableTime: new Date('2026-11-02T13:55:00Z'),
  latestSnapshotTime: new Date('2026-11-02T07:12:00Z'),
};

/** A reader with a healthy week; `overrides` replaces any part. */
function fakeReader(overrides: Partial<HealthReader> = {}): HealthReader & {
  queries: MetricQuery[];
  windows: [Date, Date][];
} {
  const queries: MetricQuery[] = [];
  const windows: [Date, Date][] = [];
  const values: Record<string, number> = {
    rateebay: 0.98,
    settledebay: 120,
    latencyebay: 95_000,
    heartbeat: 10_075,
    delistfailed: 0,
    aicost: 0.12,
  };
  return {
    queries,
    windows,
    firingAlarms: () => Promise.resolve([]),
    alarmFirings: () => Promise.resolve([{ id: 'api-5xx', count: 2 }]),
    weekMetrics: (_namespace, asked, start, end) => {
      queries.push(...asked);
      windows.push([start, end]);
      return Promise.resolve(new Map(asked.map((query) => [query.id, values[query.id] ?? null])));
    },
    cost: () => Promise.resolve({ monthToDateUsd: 1.5, lastMonthUsd: 6.2 }),
    backups: () => Promise.resolve(HEALTHY_BACKUPS),
    ...overrides,
  };
}

describe('the weekly health summary', () => {
  it('reads the week up to the last whole hour, the trust metrics as the alarms do', async () => {
    const reader = fakeReader();
    const snapshot = await collectHealth(reader, CONFIG, NOW);
    expect(snapshot.weekEnd.toISOString()).toBe('2026-11-02T14:00:00.000Z');
    expect(snapshot.weekStart.toISOString()).toBe('2026-10-26T14:00:00.000Z');
    expect(reader.queries).toContainEqual({
      id: 'rateebay',
      metricName: 'VerifiedSuccess',
      statistic: 'Average',
      dimensions: { Marketplace: 'ebay' },
    });
    expect(reader.queries).toContainEqual({
      id: 'heartbeat',
      metricName: 'OldestUnverifiedOperationAge',
      statistic: 'SampleCount',
    });
    expect(new Set(reader.queries.map((query) => query.id)).size).toBe(reader.queries.length);
  });

  it('says a healthy week is healthy, with every section', async () => {
    const mailer = new RecordingMailer();
    await sendWeeklySummary(CONFIG, fakeReader(), mailer, NOW);
    const [email] = mailer.sent;
    expect(email?.subject).toBe('[Listora personal] Weekly health: all healthy');
    expect(email?.text).toContain('Nothing needs attention.');
    expect(email?.text).toContain('api-5xx: 2 times');
    expect(email?.text).toContain('ebay: 120 settled, 98.0% verified success, p95 delist 1.6 min');
    expect(email?.text).toContain('depop: no operations settled');
    expect(email?.text).toContain('Reported in 99.9% of minutes (10075 of 10080)');
    expect(email?.text).toContain('This month so far: $1.50 (budget $50.00)');
    expect(email?.text).toContain('automated backups kept 7 days, deletion protection on');
    expect(email?.text).toContain('Restorable to: 2026-11-02 13:55 UTC');
  });

  it('puts what needs attention first and counts it in the subject', async () => {
    const mailer = new RecordingMailer();
    const reader = fakeReader({
      firingAlarms: () =>
        Promise.resolve([
          {
            id: 'sale-checks-unhealthy',
            description: "A marketplace connection's sale checks fail.",
            since: new Date('2026-11-01T09:00:00Z'),
          },
        ]),
      backups: () =>
        Promise.resolve({
          ...HEALTHY_BACKUPS,
          deletionProtection: false,
          latestRestorableTime: new Date('2026-11-01T00:00:00Z'),
        }),
      cost: () => Promise.resolve({ monthToDateUsd: 61, lastMonthUsd: 40 }),
    });
    await sendWeeklySummary(CONFIG, reader, mailer, NOW);
    const [email] = mailer.sent;
    expect(email?.subject).toBe('[Listora personal] Weekly health: 4 things need attention');
    const text = email?.text ?? '';
    const attention = text.slice(
      text.indexOf('Needs attention:'),
      text.indexOf('Alarms firing now'),
    );
    expect(attention).toContain('sale-checks-unhealthy is firing.');
    expect(attention).toContain('Database deletion protection is off.');
    expect(attention).toContain('Point-in-time restore is behind');
    expect(attention).toContain('over the budget');
  });

  it('flags a worker that was down, failed delists, and a low verified-success rate', async () => {
    const mailer = new RecordingMailer();
    const values: Readonly<Record<string, number>> = {
      heartbeat: 8000,
      delistfailed: 2,
      rateebay: 0.5,
      settledebay: 10,
    };
    const reader = fakeReader({
      weekMetrics: (_namespace, asked) =>
        Promise.resolve(new Map(asked.map((query) => [query.id, values[query.id] ?? null]))),
    });
    await sendWeeklySummary(CONFIG, reader, mailer, NOW);
    const text = mailer.sent[0]?.text ?? '';
    expect(text).toContain('The worker reported in only 79.3% of the week');
    expect(text).toContain('2 delists failed this week.');
    expect(text).toContain('ebay: only 50.0% of operations succeeded with a verified result.');
  });

  it('reports a section it could not read instead of leaving it out or calling it healthy', async () => {
    const mailer = new RecordingMailer();
    const reader = fakeReader({
      cost: () => Promise.reject(new Error('not authorized to perform ce:GetCostAndUsage')),
    });
    await sendWeeklySummary(CONFIG, reader, mailer, NOW);
    const [email] = mailer.sent;
    expect(email?.subject).toBe('[Listora personal] Weekly health: 1 thing needs attention');
    expect(email?.text).toContain('Could not read: not authorized to perform ce:GetCostAndUsage');
    expect(email?.text).toContain('Restorable to:');
  });

  it('flags backups that are off', async () => {
    const mailer = new RecordingMailer();
    const reader = fakeReader({
      backups: () =>
        Promise.resolve({
          ...HEALTHY_BACKUPS,
          retentionDays: 0,
          latestRestorableTime: null,
          latestSnapshotTime: null,
        }),
    });
    await sendWeeklySummary(CONFIG, reader, mailer, NOW);
    const text = mailer.sent[0]?.text ?? '';
    expect(text).toContain('Automated database backups are off.');
    expect(text).toContain('Restorable to: nothing (no point-in-time restore)');
  });
});
