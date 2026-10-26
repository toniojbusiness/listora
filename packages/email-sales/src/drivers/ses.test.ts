/**
 * The SES driver against an in-memory queue and bucket: it reads each received-mail
 * notification's stored message and SES's verdicts, deletes a notification it cannot use, and
 * deletes the stored message and then the queue message once processed.
 */
import { describe, expect, it } from 'vitest';

import { createLogger } from '@listora/shared';

import { readMessage } from '../message.ts';
import { fixture } from '../test-support.ts';
import { SesMailSource, type MailBucket, type MailQueue } from './ses.ts';

const BUCKET = 'listora-test-inbound-mail';
const TO = 'sales+aaaaaaaaaaaaaaaaaaaa@in.example.com';
const logger = createLogger({ service: 'test', level: 'silent' });

function sesNotification(
  key: string,
  verdicts: Partial<Record<'spf' | 'dkim' | 'spam' | 'virus', string>> = {},
) {
  return {
    notificationType: 'Received',
    mail: { messageId: 'ses-1', destination: [TO] },
    receipt: {
      recipients: [TO],
      spamVerdict: { status: verdicts.spam ?? 'PASS' },
      virusVerdict: { status: verdicts.virus ?? 'PASS' },
      spfVerdict: { status: verdicts.spf ?? 'PASS' },
      dkimVerdict: { status: verdicts.dkim ?? 'PASS' },
      dmarcVerdict: { status: 'PASS' },
      action: {
        type: 'S3',
        topicArn: 'arn:aws:sns:us-east-1:123456789012:t',
        bucketName: BUCKET,
        objectKeyPrefix: 'inbound/',
        objectKey: key,
      },
    },
  };
}

/** The stored message as SES keeps it: its own Authentication-Results header on top. */
function stored(dkimDomain: string): Uint8Array {
  return new TextEncoder().encode(
    `Authentication-Results: amazonses.com; spf=pass (spfCheck: ok) client-ip=1.2.3.4; envelope-from=x@gmail.com; dkim=pass header.i=@${dkimDomain};\r\n${fixture('poshmark-sold').replace(/\n/g, '\r\n')}`,
  );
}

function fakes(messages: { body: string }[], objects: Record<string, Uint8Array>) {
  const queue = messages.map((message, index) => ({
    ...message,
    receiptHandle: `rh-${String(index)}`,
    messageId: `m-${String(index)}`,
  }));
  const deleted: string[] = [];
  const mailQueue: MailQueue = {
    receive: async (max) => queue.splice(0, max),
    delete: async (handle) => {
      deleted.push(`queue:${handle}`);
    },
  };
  const bucket: MailBucket = {
    get: async (name, key) => (name === BUCKET ? objects[key] : undefined),
    delete: async (name, key) => {
      deleted.push(`object:${name}/${key}`);
    },
  };
  return {
    source: new SesMailSource({ queue: mailQueue, bucket, bucketName: BUCKET, logger }),
    deleted,
  };
}

describe('SesMailSource', () => {
  it('reads the stored message with SES’s verdicts and its DKIM signing domain', async () => {
    const { source, deleted } = fakes([{ body: JSON.stringify(sesNotification('inbound/abc')) }], {
      'inbound/abc': stored('poshmark.com'),
    });
    const [mail] = await source.receive(10);
    if (mail === undefined) throw new Error('no mail');
    expect(mail.envelopeRecipients).toEqual([TO]);
    const message = await readMessage(mail.raw);
    expect(mail.authenticate(message)).toEqual({
      spf: 'pass',
      dkimPassDomains: ['poshmark.com'],
      flagged: false,
    });
    await mail.done();
    expect(deleted).toEqual([`object:${BUCKET}/inbound/abc`, 'queue:rh-0']);
  });

  it('takes SES’s own verdicts over the header: a DKIM or SPF failure, spam, or a virus', async () => {
    const { source } = fakes(
      [
        { body: JSON.stringify(sesNotification('inbound/a', { dkim: 'FAIL' })) },
        { body: JSON.stringify(sesNotification('inbound/b', { spf: 'FAIL' })) },
        { body: JSON.stringify(sesNotification('inbound/c', { virus: 'FAIL' })) },
      ],
      {
        'inbound/a': stored('poshmark.com'),
        'inbound/b': stored('poshmark.com'),
        'inbound/c': stored('poshmark.com'),
      },
    );
    const mail = await source.receive(10);
    const verdicts = await Promise.all(
      mail.map(async (one) => one.authenticate(await readMessage(one.raw))),
    );
    expect(verdicts).toEqual([
      { spf: 'pass', dkimPassDomains: [], flagged: false },
      { spf: 'fail', dkimPassDomains: ['poshmark.com'], flagged: false },
      { spf: 'pass', dkimPassDomains: ['poshmark.com'], flagged: true },
    ]);
  });

  it('reads a notification inside SNS’s envelope too', async () => {
    const envelope = {
      Type: 'Notification',
      MessageId: 'sns-1',
      Message: JSON.stringify(sesNotification('inbound/abc')),
    };
    const { source } = fakes([{ body: JSON.stringify(envelope) }], {
      'inbound/abc': stored('poshmark.com'),
    });
    expect(await source.receive(10)).toHaveLength(1);
  });

  it('deletes notifications it cannot use, and one whose message was processed before', async () => {
    const otherBucket = sesNotification('inbound/x');
    otherBucket.receipt.action.bucketName = 'someone-elses-bucket';
    const { source, deleted } = fakes(
      [
        { body: JSON.stringify({ notificationType: 'AMAZON_SES_SETUP_NOTIFICATION' }) },
        { body: 'not json' },
        { body: JSON.stringify(otherBucket) },
        { body: JSON.stringify(sesNotification('inbound/gone')) },
      ],
      {},
    );
    expect(await source.receive(10)).toEqual([]);
    expect(deleted).toEqual(['queue:rh-0', 'queue:rh-1', 'queue:rh-2', 'queue:rh-3']);
  });
});
