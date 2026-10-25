import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEV_INBOUND_DOMAIN,
  EmailIngestConfigError,
  loadEmailIngestConfig,
} from './config.ts';

describe('loadEmailIngestConfig', () => {
  it('defaults to the folder driver with the development domain', () => {
    expect(loadEmailIngestConfig({})).toMatchObject({
      driver: 'folder',
      inboundDomain: DEFAULT_DEV_INBOUND_DOMAIN,
    });
    expect(loadEmailIngestConfig({ EMAIL_INGEST: 'off' })).toEqual({ driver: 'off' });
  });

  it('reads the SES driver’s queue, bucket, and region', () => {
    expect(
      loadEmailIngestConfig({
        EMAIL_INGEST: 'ses',
        EMAIL_INBOUND_DOMAIN: 'In.Example.com',
        EMAIL_SES_QUEUE_URL:
          'https://sqs.us-east-1.amazonaws.com/123456789012/listora-prod-sale-email',
        EMAIL_SES_BUCKET: 'listora-prod-inbound-mail',
        EMAIL_SES_REGION: 'us-east-1',
      }),
    ).toEqual({
      driver: 'ses',
      inboundDomain: 'in.example.com',
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/listora-prod-sale-email',
      bucket: 'listora-prod-inbound-mail',
      region: 'us-east-1',
    });
  });

  it('names every missing or bad key without echoing values', () => {
    let error: unknown;
    try {
      loadEmailIngestConfig({ EMAIL_INGEST: 'ses', EMAIL_SES_QUEUE_URL: 'secret-value' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EmailIngestConfigError);
    const { issues } = error as EmailIngestConfigError;
    expect(issues).toEqual([
      'EMAIL_INBOUND_DOMAIN is required when EMAIL_INGEST=ses',
      'EMAIL_SES_QUEUE_URL must be an SQS queue URL',
      'EMAIL_SES_BUCKET is required when EMAIL_INGEST=ses',
      'EMAIL_SES_REGION is required when EMAIL_INGEST=ses',
    ]);
    expect(issues.join(' ')).not.toContain('secret-value');
    expect(() => loadEmailIngestConfig({ EMAIL_INGEST: 'imap' })).toThrow(EmailIngestConfigError);
  });
});
