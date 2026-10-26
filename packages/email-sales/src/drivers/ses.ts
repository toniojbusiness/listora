/**
 * The SES driver (`EMAIL_INGEST=ses`). SES receives mail for the inbound domain, scans it, and
 * its receipt rule stores the raw message in the inbound mail bucket (under `inbound/`) and
 * publishes a notification to an SNS topic that delivers it, raw, to an SQS queue
 * (infra/src/stacks/email-stack.ts). The worker reads the queue: each notification names the
 * stored object and carries SES's verdicts.
 *
 * - **Verdicts.** SPF is SES's `spfVerdict`. DKIM must be SES's `dkimVerdict` PASS *and* name the
 *   signing domain, which only SES's own `Authentication-Results` header (the first in the
 *   stored message, from `amazonses.com`) shows. Spam or virus FAIL flags the message.
 * - **Done** deletes the stored object, then the queue message. A message that keeps failing
 *   moves to the dead-letter queue after a few receives; the bucket's lifecycle rule deletes any
 *   raw message left behind after a few days.
 * - A notification that is not SES's received notification (SES's setup test, or a stored
 *   object in another bucket) is deleted without reading anything.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  type S3Client,
} from '@aws-sdk/client-s3';
import { DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { z } from 'zod';

import type { Logger } from '@listora/shared';

import {
  authenticationFromHeaders,
  UNVERIFIED,
  type AuthVerdict,
  type MailAuthentication,
} from '../authentication.ts';
import type { MailSource, ReceivedMail } from './source.ts';

/** The receiver id SES writes in the `Authentication-Results` header it adds. */
export const SES_RECEIVER = 'amazonses.com';

/** The queue, as the driver uses it (SQS in AWS, an in-memory fake in tests). */
export interface MailQueue {
  receive(max: number): Promise<{ receiptHandle: string; body: string; messageId: string }[]>;
  delete(receiptHandle: string): Promise<void>;
}

/** The inbound mail bucket, as the driver uses it. */
export interface MailBucket {
  /** The object, or undefined when it no longer exists (processed and deleted before). */
  get(bucket: string, key: string): Promise<Uint8Array | undefined>;
  delete(bucket: string, key: string): Promise<void>;
}

const VERDICT = z.object({ status: z.string() });

/** SES's notification for a message its S3 action stored (the parts Listora reads). */
const receivedNotification = z.object({
  notificationType: z.literal('Received'),
  receipt: z.object({
    recipients: z.array(z.string()),
    spamVerdict: VERDICT,
    virusVerdict: VERDICT,
    spfVerdict: VERDICT,
    dkimVerdict: VERDICT,
    action: z.object({
      type: z.literal('S3'),
      bucketName: z.string(),
      objectKey: z.string(),
    }),
  }),
});

const SPF_VERDICTS: Record<string, AuthVerdict> = {
  PASS: 'pass',
  FAIL: 'fail',
  GRAY: 'none',
  PROCESSING_FAILED: 'temperror',
};

/** The SES notification in a queue message: raw delivery, or inside SNS's envelope. */
function notificationOf(body: string): unknown {
  const parsed: unknown = JSON.parse(body);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as Record<string, unknown>)['Type'] === 'Notification' &&
    typeof (parsed as Record<string, unknown>)['Message'] === 'string'
  ) {
    return JSON.parse((parsed as Record<string, string>)['Message'] ?? '');
  }
  return parsed;
}

export class SesMailSource implements MailSource {
  readonly #queue: MailQueue;
  readonly #bucket: MailBucket;
  readonly #bucketName: string;
  readonly #logger: Logger;

  constructor(options: {
    queue: MailQueue;
    bucket: MailBucket;
    bucketName: string;
    logger: Logger;
  }) {
    this.#queue = options.queue;
    this.#bucket = options.bucket;
    this.#bucketName = options.bucketName;
    this.#logger = options.logger;
  }

  async receive(max: number): Promise<ReceivedMail[]> {
    const messages = await this.#queue.receive(Math.min(max, 10));
    const mail: ReceivedMail[] = [];
    for (const message of messages) {
      let notification;
      try {
        notification = receivedNotification.safeParse(notificationOf(message.body));
      } catch {
        notification = undefined;
      }
      if (
        notification?.success !== true ||
        notification.data.receipt.action.bucketName !== this.#bucketName
      ) {
        this.#logger.warn(
          { queueMessageId: message.messageId },
          'not a received-mail notification; deleting it',
        );
        await this.#queue.delete(message.receiptHandle);
        continue;
      }
      const { receipt } = notification.data;
      const key = receipt.action.objectKey;
      const raw = await this.#bucket.get(this.#bucketName, key);
      if (raw === undefined) {
        // Processed before; only the queue message was left.
        await this.#queue.delete(message.receiptHandle);
        continue;
      }
      mail.push({
        id: message.messageId,
        raw,
        envelopeRecipients: receipt.recipients,
        authenticate: (parsed): MailAuthentication => {
          const dkimPassed = receipt.dkimVerdict.status === 'PASS';
          const header = authenticationFromHeaders(parsed, SES_RECEIVER);
          return {
            ...UNVERIFIED,
            spf: SPF_VERDICTS[receipt.spfVerdict.status] ?? 'none',
            dkimPassDomains: dkimPassed ? header.dkimPassDomains : [],
            flagged:
              receipt.spamVerdict.status === 'FAIL' || receipt.virusVerdict.status === 'FAIL',
          };
        },
        done: async () => {
          await this.#bucket.delete(this.#bucketName, key);
          await this.#queue.delete(message.receiptHandle);
        },
      });
    }
    return mail;
  }
}

/** The queue over SQS: a short long-poll, so each ingest run sees every waiting message. */
export function sqsMailQueue(client: SQSClient, queueUrl: string): MailQueue {
  return {
    async receive(max) {
      const output = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: max,
          WaitTimeSeconds: 1,
        }),
      );
      return (output.Messages ?? []).flatMap((message) =>
        message.ReceiptHandle === undefined || message.Body === undefined
          ? []
          : [
              {
                receiptHandle: message.ReceiptHandle,
                body: message.Body,
                messageId: message.MessageId ?? 'unknown',
              },
            ],
      );
    },
    async delete(receiptHandle) {
      await client.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
      );
    },
  };
}

/** The bucket over S3. */
export function s3MailBucket(client: S3Client): MailBucket {
  return {
    async get(bucket, key) {
      try {
        const output = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return output.Body === undefined ? undefined : await output.Body.transformToByteArray();
      } catch (error) {
        if (error instanceof NoSuchKey) return undefined;
        throw error;
      }
    },
    async delete(bucket, key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
