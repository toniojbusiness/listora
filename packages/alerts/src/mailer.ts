import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

/** One plain-text email to the operator. */
export interface Email {
  readonly subject: string;
  readonly text: string;
}

/** Sends an email to the operator, or throws: an alert that was not sent is never dropped quietly. */
export interface Mailer {
  send(email: Email): Promise<void>;
}

/** SES's subject limit is far higher; a short one reads whole in an inbox list. */
const MAX_SUBJECT_LENGTH = 200;

/** One line, at most `MAX_SUBJECT_LENGTH` characters: SES refuses a subject with a line break. */
export function subjectLine(subject: string): string {
  const line = subject.replace(/\s+/g, ' ').trim();
  return line.length <= MAX_SUBJECT_LENGTH ? line : `${line.slice(0, MAX_SUBJECT_LENGTH - 3)}...`;
}

/** Sends through SES from a verified identity (`from`) to the operator (`to`). */
export class SesMailer implements Mailer {
  private readonly client: SESv2Client;
  private readonly from: string;
  private readonly to: string;

  constructor(options: { from: string; to: string; client?: SESv2Client }) {
    this.client = options.client ?? new SESv2Client({});
    this.from = options.from;
    this.to = options.to;
  }

  async send(email: Email): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: `Listora alerts <${this.from}>`,
        Destination: { ToAddresses: [this.to] },
        Content: {
          Simple: {
            Subject: { Data: subjectLine(email.subject), Charset: 'UTF-8' },
            Body: { Text: { Data: email.text, Charset: 'UTF-8' } },
          },
        },
      }),
    );
  }
}

/** Keeps every email instead of sending it; `failWith` makes the next sends throw. */
export class RecordingMailer implements Mailer {
  readonly sent: Email[] = [];
  failWith: Error | undefined;

  send(email: Email): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.sent.push({ subject: subjectLine(email.subject), text: email.text });
    return Promise.resolve();
  }
}
