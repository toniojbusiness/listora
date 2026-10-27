import type { Email } from './mailer.ts';

/** One message from the alarm topic, as SNS delivers it to the Lambda. */
export interface TopicMessage {
  /** Set by CloudWatch ("ALARM: ..."), AWS Budgets, and RDS; absent for EventBridge rules. */
  readonly subject: string | undefined;
  readonly message: string;
  readonly timestamp: string;
}

export interface AlertContext {
  /** `personal`, `staging`, or `prod`. */
  readonly environment: string;
  readonly region: string;
}

/** Where every alarm's meaning and first steps are written down. */
export const RUNBOOK = 'docs/features/alerts.md';

/** The fields of CloudWatch's alarm notification this email uses. */
interface AlarmNotification {
  readonly AlarmName: string;
  readonly AlarmDescription?: string | null;
  readonly NewStateValue: string;
  readonly OldStateValue?: string;
  readonly NewStateReason?: string;
  readonly StateChangeTime?: string;
}

/** The fields of an RDS event notification this email uses. */
interface RdsEventNotification {
  readonly 'Event Message': string;
  readonly 'Source ID'?: string;
  readonly 'Event Time'?: string;
  readonly 'Event ID'?: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAlarmNotification(value: unknown): value is AlarmNotification {
  return (
    isRecord(value) &&
    typeof value['AlarmName'] === 'string' &&
    typeof value['NewStateValue'] === 'string'
  );
}

function isRdsEvent(value: unknown): value is RdsEventNotification {
  return isRecord(value) && typeof value['Event Message'] === 'string';
}

/**
 * The email for one message on the alarm topic. CloudWatch alarms (firing and recovering), RDS
 * events, and AWS Budgets each get a subject that names the environment and what happened; the
 * EventBridge rules' messages (task stops, failed deploys) are already sentences. Anything else
 * is sent as it came, so no message on the topic is ever dropped for its shape.
 */
export function alertEmail(message: TopicMessage, context: AlertContext): Email {
  const tag = `[Listora ${context.environment}]`;
  const footer = [
    '',
    `What each alert means and what to do first: ${RUNBOOK} in the Listora repository.`,
  ];
  const body = parseJson(message.message);

  if (isAlarmNotification(body)) {
    // Alarm names are `listora-<env>-<id>`; the id is what the runbook lists.
    const id = body.AlarmName.replace(`listora-${context.environment}-`, '');
    const state = body.NewStateValue;
    const headline =
      state === 'OK' ? `Recovered: ${id}` : state === 'ALARM' ? `ALARM: ${id}` : `${state}: ${id}`;
    const link =
      `https://${context.region}.console.aws.amazon.com/cloudwatch/home?region=` +
      `${context.region}#alarmsV2:alarm/${encodeURIComponent(body.AlarmName)}`;
    return {
      subject: `${tag} ${headline}`,
      text: [
        state === 'OK' ? `The alarm ${id} is back to OK.` : `The alarm ${id} is in ${state}.`,
        '',
        body.AlarmDescription ?? '(no description)',
        '',
        `State: ${body.OldStateValue ?? '?'} -> ${state} at ${body.StateChangeTime ?? message.timestamp}`,
        `Reason: ${body.NewStateReason ?? '(none given)'}`,
        `Alarm: ${link}`,
        ...footer,
      ].join('\n'),
    };
  }

  if (isRdsEvent(body)) {
    return {
      subject: `${tag} Database event: ${body['Event Message']}`,
      text: [
        `RDS reported an event on ${body['Source ID'] ?? 'the database'}:`,
        '',
        body['Event Message'],
        '',
        `Time: ${body['Event Time'] ?? message.timestamp}`,
        ...(body['Event ID'] === undefined ? [] : [`Event: ${body['Event ID']}`]),
        ...footer,
      ].join('\n'),
    };
  }

  const firstLine = message.message.split('\n', 1)[0] ?? '';
  const headline = message.subject ?? firstLine;
  return {
    subject: `${tag} ${headline === '' ? 'Alert' : headline}`,
    text: [message.message, '', `Time: ${message.timestamp}`, ...footer].join('\n'),
  };
}
