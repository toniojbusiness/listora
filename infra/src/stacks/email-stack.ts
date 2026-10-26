import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as actions from 'aws-cdk-lib/aws-ses-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

import type { DeployTarget, DnsTarget } from '../config.ts';
import { ListoraStack, type ListoraStackProps } from './common.ts';

/** Raw inbound messages land under this prefix of the inbound mail bucket. */
export const INBOUND_MAIL_PREFIX = 'inbound/';

/** Label under the environment's domain that receives forwarded sale emails. */
export const INBOUND_MAIL_SUBDOMAIN = 'in';

/**
 * Days a raw message can stay in the bucket, and a notification in the dead-letter queue. The
 * worker deletes each message once it is processed (packages/email-sales); this only removes
 * what could never be processed.
 */
export const RAW_MAIL_RETENTION_DAYS = 14;

/** Receives of a notification before it moves to the dead-letter queue. */
export const SALE_EMAIL_MAX_RECEIVES = 5;

/** What the worker reads sale emails with, where the environment receives them. */
export interface SaleEmailIngest {
  /** `in.<domain>`: every account's forwarding address is `sales+<token>@` it. */
  readonly inboundDomain: string;
  /** SES's notifications (through SNS) of each stored message. */
  readonly queue: sqs.Queue;
}

/**
 * SES inbound for sale-email ingest (T-23, docs/features/email-sales.md): every address at
 * `in.<domain>` is accepted, spam and virus scanned, and stored as a raw message in a private
 * bucket under `inbound/`; SES then publishes its notification (the stored object's key and the
 * SPF, DKIM, spam, and virus verdicts) to an SNS topic that delivers it, raw, to an SQS queue the
 * worker reads every minute. The worker deletes each message once processed. The domain identity
 * is verified with Easy DKIM records in the environment's hosted zone.
 *
 * SES allows one active receipt rule set per account and region, and CloudFormation cannot
 * activate one, so the first deploy is followed by one manual activation (infra/README.md).
 *
 * Receiving email needs a domain. Without one (personal, until a domain is added) the stack
 * holds only the empty bucket, with no receipt rule, topic, or queue, and the containers run
 * with `EMAIL_INGEST=off`; sales are then detected by the scheduled checks and marketplace
 * webhooks alone. Adding the domain turns it all on (infra/README.md, Adding a domain later).
 *
 * With an owner pool (`ownerEmail`, personal), the stack also holds the owner's address as an
 * SES identity: the pool emails the sign-in codes through SES, and in the SES sandbox SES sends
 * only to verified addresses (and, without a domain, from one). Creating it emails the owner a
 * verification link, the one manual step of the first deploy (infra/README.md); the auth stack
 * deploys after it, once the address is verified.
 */
export class EmailStack extends ListoraStack {
  readonly inboundMailBucket: s3.Bucket;
  /** Absent without a domain. */
  readonly receiptRuleSet: ses.ReceiptRuleSet | undefined;
  /** Absent without a domain: no mail is received. */
  readonly saleEmail: SaleEmailIngest | undefined;

  constructor(scope: Construct, id: string, props: ListoraStackProps) {
    super(scope, id, props);
    const { target } = props;
    const { dns } = target;

    if (dns !== undefined) this.verifyDomain(dns, target);
    // An identity that already exists outside this stack is left alone (`ownerEmailIdentity`);
    // the deploy still waits until it is verified before the user pool deploys.
    if (target.ownerEmail !== undefined && target.ownerEmailIdentity === 'create') {
      new ses.EmailIdentity(this, 'OwnerAddress', {
        identity: ses.Identity.email(target.ownerEmail),
      });
    }

    this.inboundMailBucket = new s3.Bucket(this, 'InboundMail', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        // The worker deletes each message once processed; this removes any it never could.
        {
          id: 'expire-raw-mail',
          prefix: INBOUND_MAIL_PREFIX,
          expiration: Duration.days(RAW_MAIL_RETENTION_DAYS),
        },
      ],
    });

    if (dns === undefined) {
      this.receiptRuleSet = undefined;
      this.saleEmail = undefined;
    } else {
      const inboundDomain = `${INBOUND_MAIL_SUBDOMAIN}.${dns.domain}`;
      const queue = this.notificationQueue(target);
      this.receiptRuleSet = this.storeMail(inboundDomain, target, queue);
      this.saleEmail = { inboundDomain, queue };
    }
  }

  /** The worker's queue of SES notifications, with a dead-letter queue for any it cannot process. */
  private notificationQueue(target: DeployTarget): sqs.Queue {
    const deadLetters = new sqs.Queue(this, 'SaleEmailDeadLetters', {
      queueName: `listora-${target.environment}-sale-email-dead-letters`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(RAW_MAIL_RETENTION_DAYS),
    });
    return new sqs.Queue(this, 'SaleEmailQueue', {
      queueName: `listora-${target.environment}-sale-email`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(4),
      // Longer than one message's processing, so another run never reads it at the same time.
      visibilityTimeout: Duration.minutes(5),
      deadLetterQueue: { queue: deadLetters, maxReceiveCount: SALE_EMAIL_MAX_RECEIVES },
    });
  }

  /** The SES domain identity (Easy DKIM) and the MX record for `in.<domain>`. */
  private verifyDomain(dns: DnsTarget, target: DeployTarget): void {
    const zone = route53.PublicHostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: dns.hostedZoneId,
      zoneName: dns.domain,
    });

    new ses.EmailIdentity(this, 'DomainIdentity', {
      identity: ses.Identity.publicHostedZone(zone),
    });

    new route53.MxRecord(this, 'InboundMx', {
      zone,
      recordName: INBOUND_MAIL_SUBDOMAIN,
      values: [{ priority: 10, hostName: `inbound-smtp.${target.region}.amazonaws.com` }],
    });
  }

  /**
   * Receipt rules that scan every message to `in.<domain>`, store it in the bucket, and notify
   * the worker's queue through an SNS topic only SES (of this account) may publish to.
   */
  private storeMail(
    inboundDomain: string,
    target: DeployTarget,
    queue: sqs.Queue,
  ): ses.ReceiptRuleSet {
    // The notification holds only the stored object's key, the verdicts, and the headers SES
    // reports; SES cannot publish to a topic encrypted with an AWS managed key, and the queue is
    // encrypted.
    const topic = new sns.Topic(this, 'SaleEmailTopic', {
      topicName: `listora-${target.environment}-sale-email`,
      enforceSSL: true,
    });
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'SesPublishes',
        actions: ['sns:Publish'],
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        resources: [topic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );
    topic.addSubscription(new subscriptions.SqsSubscription(queue, { rawMessageDelivery: true }));

    const receiptRuleSet = new ses.ReceiptRuleSet(this, 'ReceiptRules', {
      receiptRuleSetName: `listora-${target.environment}`,
    });
    receiptRuleSet.addRule('StoreSaleEmail', {
      recipients: [inboundDomain],
      scanEnabled: true,
      tlsPolicy: ses.TlsPolicy.REQUIRE,
      actions: [
        new actions.S3({
          bucket: this.inboundMailBucket,
          objectKeyPrefix: INBOUND_MAIL_PREFIX,
          topic,
        }),
      ],
    });

    new CfnOutput(this, 'InboundMailDomain', { value: inboundDomain });
    new CfnOutput(this, 'ReceiptRuleSetName', { value: receiptRuleSet.receiptRuleSetName });
    return receiptRuleSet;
  }
}
