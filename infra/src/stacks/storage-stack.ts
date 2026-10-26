import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
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
 */
export class StorageStack extends ListoraStack {
  readonly photoBucket: s3.Bucket;
  readonly photoDistribution: cloudfront.Distribution;

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
      ],
    });

    // The origin access control is set up here rather than by `withOriginAccessControl`,
    // whose bucket policy statement would let the distribution read every object.
    const access = new cloudfront.S3OriginAccessControl(this, 'PhotoCdnAccess', {
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });
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
    });
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
    new CfnOutput(this, 'PhotoCdnDomain', {
      value: this.photoDistribution.distributionDomainName,
    });
  }
}
