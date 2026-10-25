/**
 * The worker's ingest job (`email_ingest`, every minute): reads every waiting message from the
 * configured source, processes each (process.ts), and deletes it once processed. A sale is
 * then recorded within about a minute of its email reaching Listora.
 */
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';

import { assertNever, type Logger } from '@listora/shared';

import type { EmailIngestConfig } from './config.ts';
import { FolderMailSource } from './drivers/folder.ts';
import { s3MailBucket, SesMailSource, sqsMailQueue } from './drivers/ses.ts';
import type { MailSource } from './drivers/source.ts';
import {
  processInboundEmail,
  type EmailOutcome,
  type EmailProcessingDependencies,
} from './process.ts';

export const EMAIL_INGEST_TASK = 'email_ingest';
export const EMAIL_INGEST_SCHEDULE = '* * * * *';

/** Messages one run reads at most; the next minute's run takes the rest. */
const MAX_PER_RUN = 200;

/** The configured source, or undefined when this deployment reads no mail (`EMAIL_INGEST=off`). */
export function createMailSource(
  config: EmailIngestConfig,
  logger: Logger,
): MailSource | undefined {
  switch (config.driver) {
    case 'off':
      return undefined;
    case 'folder':
      return new FolderMailSource(config.inboxDir);
    case 'ses':
      return new SesMailSource({
        queue: sqsMailQueue(new SQSClient({ region: config.region }), config.queueUrl),
        bucket: s3MailBucket(new S3Client({ region: config.region })),
        bucketName: config.bucket,
        logger,
      });
    default:
      return assertNever(config, 'EMAIL_INGEST');
  }
}

/** Processes the waiting mail; returns how many of each outcome. */
export async function runEmailIngest(
  deps: EmailProcessingDependencies & { source: MailSource },
  signal?: AbortSignal,
): Promise<Partial<Record<EmailOutcome, number>>> {
  const counts: Partial<Record<EmailOutcome, number>> = {};
  let read = 0;
  while (read < MAX_PER_RUN && signal?.aborted !== true) {
    const batch = await deps.source.receive(Math.min(10, MAX_PER_RUN - read));
    if (batch.length === 0) break;
    let failed = 0;
    for (const mail of batch) {
      read += 1;
      try {
        const outcome = await processInboundEmail(deps, mail);
        await mail.done();
        counts[outcome] = (counts[outcome] ?? 0) + 1;
      } catch (error) {
        // Left in place: the next run reads it again.
        failed += 1;
        deps.logger.error(
          {
            task: EMAIL_INGEST_TASK,
            mailId: mail.id,
            err: error instanceof Error ? { name: error.name, message: error.message } : error,
          },
          'email could not be processed; it is read again later',
        );
      }
    }
    // The folder lists failed files again at once; stop and let the next run retry them.
    if (failed > 0) break;
  }
  if (read > 0)
    deps.logger.info({ task: EMAIL_INGEST_TASK, read, outcomes: counts }, 'emails processed');
  return counts;
}
