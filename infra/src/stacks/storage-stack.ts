import { Annotations, CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

import { ListoraStack, type ListoraStackProps } from './common.ts';

/**
 * Objects under this prefix are reachable through CloudFront; nothing else in the bucket is.
 * Listing photos that marketplaces fetch by URL go here under unguessable keys.
 */
export const PUBLIC_PHOTO_PREFIX = 'public/';

/** Private: the browser runner's screenshots of failed runs (`SCREENSHOT_PREFIX`). */
export const AUTOMATION_SCREENSHOT_PREFIX = 'automation/';

/** Private: photo files uploaded by the app, until the worker processes them (`storageKeys`). */
export const UPLOAD_PREFIX = 'uploads/';

/** Private: package photos, which show the buyer's label (`PACK_PHOTO_PREFIX`). */
export const PACK_PHOTO_PREFIX = 'pack/';

/** With a domain, listing photos are served at `photos.<domain>`. */
export const PHOTO_CDN_SUBDOMAIN = 'photos';

/** CloudFront takes its viewer certificates only from this region. */
export const CLOUDFRONT_CERTIFICATE_REGION = 'us-east-1';

/**
 * The photo bucket and the CloudFront distribution marketplaces fetch listing images from.
 *
 * The bucket is private (all public access blocked, TLS only). CloudFront reads it through
 * origin access control with the origin path `/public`, so a URL can only ever name an
 * object under `public/`, and only by its exact key: the distribution has no list access,
 * and a key that does not exist answers 403, the same as one that is not allowed. The bucket
 * policy lets the distribution read only `public/` too, so a behavior or origin added later
 * cannot expose uploads, private derivatives, or screenshots. Keys must therefore be
 * unguessable (random, at least 128 bits); the storage driver (T-07) owns that.
 *
 * With a domain (in us-east-1, where CloudFront's certificates live), photo URLs use
 * `photos.<domain>`, with a certificate validated in the domain's hosted zone and viewers held
 * to TLS 1.2 or later (`TLS_V1_2_2021`). The distribution's own `*.cloudfront.net` name keeps
 * working, so URLs handed out before stay valid, but AWS serves that name with its default
 * certificate, whose security policy is always TLSv1 and cannot be changed: without a domain
 * there is no minimum TLS version to set.
 */
export class StorageStack extends ListoraStack {
  readonly photoBucket: s3.Bucket;
  readonly photoDistribution: cloudfront.Distribution;
  /** The host photo URLs use: `photos.<domain>`, or else the distribution's own name. */
  readonly photoCdnDomain: string;

  constructor(scope: Construct, id: string, props: ListoraStackProps) {
    super(scope, id, props);
    const { target } = props;

    this.photoBucket = new s3.Bucket(this, 'Photos', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      // Versioning undoes an accidental overwrite or delete; old versions expire below.
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { id: 'abort-incomplete-uploads', abortIncompleteMultipartUploadAfter: Duration.days(1) },
        {
          id: 'expire-replaced-versions',
          // Deleted photos are gone for good after 30 days (account deletion relies on this).
          noncurrentVersionExpiration: Duration.days(30),
          expiredObjectDeleteMarker: true,
        },
        {
          // The worker deletes each upload once it has processed it, and an upload session
          // lasts a day, so an upload still here after a week was never attached: expire it,
          // so unused uploads cannot fill the bucket.
          id: 'expire-unattached-uploads',
          prefix: UPLOAD_PREFIX,
          expiration: Duration.days(7),
        },
        {
          // The browser runner's redacted screenshots of failed runs; the worker deletes them
          // after 14 days, and this is the backstop.
          id: 'expire-automation-screenshots',
          prefix: AUTOMATION_SCREENSHOT_PREFIX,
          expiration: Duration.days(30),
        },
        {
          // Package photos: the worker deletes each one 60 days after its sale shipped
          // (PACK_PHOTO_RETENTION_DAYS), and this is the backstop.
          id: 'expire-package-photos',
          prefix: PACK_PHOTO_PREFIX,
          expiration: Duration.days(180),
        },
      ],
    });

    // The origin access control is set up here rather than by `withOriginAccessControl`,
    // whose bucket policy statement would let the distribution read every object.
    const access = new cloudfront.S3OriginAccessControl(this, 'PhotoCdnAccess', {
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });
    const domain = this.photoDomain(props);
    this.photoDistribution = new cloudfront.Distribution(this, 'PhotoCdn', {
      comment: `listora-${target.environment} listing photos`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withBucketDefaults(this.photoBucket, {
          originPath: `/${PUBLIC_PHOTO_PREFIX.slice(0, -1)}`,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        // JPEG and WebP are already compressed.
        compress: false,
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      ...(domain === undefined
        ? {}
        : {
            domainNames: [domain.name],
            certificate: domain.certificate,
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
          }),
    });
    if (domain === undefined) {
      this.photoCdnDomain = this.photoDistribution.distributionDomainName;
    } else {
      const target = route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(this.photoDistribution),
      );
      const record = { zone: domain.zone, recordName: PHOTO_CDN_SUBDOMAIN, target };
      new route53.ARecord(this, 'PhotoCdnAlias', record);
      new route53.AaaaRecord(this, 'PhotoCdnAliasIpv6', record);
      this.photoCdnDomain = domain.name;
    }
    (this.photoDistribution.node.defaultChild as cloudfront.CfnDistribution).addPropertyOverride(
      'DistributionConfig.Origins.0.OriginAccessControlId',
      access.originAccessControlId,
    );
    this.photoBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [this.photoBucket.arnForObjects(`${PUBLIC_PHOTO_PREFIX}*`)],
        conditions: { StringEquals: { 'AWS:SourceArn': this.photoDistribution.distributionArn } },
      }),
    );

    new CfnOutput(this, 'PhotoBucketName', { value: this.photoBucket.bucketName });
    new CfnOutput(this, 'PhotoCdnDomain', { value: this.photoCdnDomain });
  }

  /**
   * `photos.<domain>` and its certificate, validated in the domain's hosted zone; none without
   * a domain, or outside the region CloudFront takes certificates from.
   */
  private photoDomain({
    target,
  }: ListoraStackProps):
    { name: string; zone: route53.IHostedZone; certificate: acm.ICertificate } | undefined {
    const dns = target.dns;
    if (dns === undefined) return undefined;
    if (target.region !== CLOUDFRONT_CERTIFICATE_REGION) {
      Annotations.of(this).addWarningV2(
        'listora:photo-cdn-domain',
        `Photos stay at the CloudFront default name, which allows TLS 1.0: a photos.${dns.domain} ` +
          `certificate would have to be in ${CLOUDFRONT_CERTIFICATE_REGION}, not ${target.region}.`,
      );
      return undefined;
    }
    const name = `${PHOTO_CDN_SUBDOMAIN}.${dns.domain}`;
    const zone = route53.PublicHostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: dns.hostedZoneId,
      zoneName: dns.domain,
    });
    const certificate = new acm.Certificate(this, 'PhotoCdnCertificate', {
      domainName: name,
      validation: acm.CertificateValidation.fromDns(zone),
    });
    return { name, zone, certificate };
  }
}
