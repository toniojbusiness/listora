import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as actions from 'aws-cdk-lib/aws-ses-actions';
import type { Construct } from 'constructs';

import type { DeployTarget, DnsTarget } from '../config.ts';
import { ListoraStack, type ListoraStackProps } from './common.ts';

/** Raw inbound messages land under this prefix of the inbound mail bucket. */
export const INBOUND_MAIL_PREFIX = 'inbound/';

/** Label under the environment's domain that receives forwarded sale emails. */
export const INBOUND_MAIL_SUBDOMAIN = 'in';

/**
 * SES inbound for sale-email ingest (T-23): every address at `in.<domain>` is accepted, spam
 * and virus scanned, and stored as a raw message in a private bucket. The domain identity is
 * verified with Easy DKIM records in the environment's hosted zone.
 *
 * SES allows one active receipt rule set per account and region, and CloudFormation cannot
 * activate one, so the first deploy is followed by one manual activation (infra/README.md).
 *
 * Receiving email needs a domain. Without one (personal, until a domain is added) the stack
 * holds only the empty bucket, so the worker's grant and the deploy are the same either way;
 * sales are then detected by the scheduled checks and marketplace webhooks alone.
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
        // Parsed into sale records on arrival; the raw message is kept for re-parsing only.
        { id: 'expire-raw-mail', prefix: INBOUND_MAIL_PREFIX, expiration: Duration.days(90) },
      ],
    });

    this.receiptRuleSet = dns === undefined ? undefined : this.storeMail(dns, target);
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

  /** Receipt rules that scan every message to `in.<domain>` and store it in the bucket. */
  private storeMail(dns: DnsTarget, target: DeployTarget): ses.ReceiptRuleSet {
    const inboundDomain = `${INBOUND_MAIL_SUBDOMAIN}.${dns.domain}`;
    const receiptRuleSet = new ses.ReceiptRuleSet(this, 'ReceiptRules', {
      receiptRuleSetName: `listora-${target.environment}`,
    });
    receiptRuleSet.addRule('StoreSaleEmail', {
      recipients: [inboundDomain],
      scanEnabled: true,
      tlsPolicy: ses.TlsPolicy.REQUIRE,
      actions: [
        new actions.S3({ bucket: this.inboundMailBucket, objectKeyPrefix: INBOUND_MAIL_PREFIX }),
      ],
    });

    new CfnOutput(this, 'InboundMailDomain', { value: inboundDomain });
    new CfnOutput(this, 'ReceiptRuleSetName', { value: receiptRuleSet.receiptRuleSetName });
    return receiptRuleSet;
  }
}
