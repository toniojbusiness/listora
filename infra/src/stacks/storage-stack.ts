import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

import { ListoraStack, type ListoraStackProps } from './common.ts';

/**
 * Objects under this prefix are reachable through CloudFront; nothing else in the bucket is.
 * Listing photos that marketplaces fetch by URL go here under unguessable keys.
 */
export const PUBLIC_PHOTO_PREFIX = 'public/';

/**
 * The photo bucket and the CloudFront distribution marketplaces fetch listing images from.
 *
 * The bucket is private (all public access blocked, TLS only). CloudFront reads it through
 * origin access control with the origin path `/public`, so a URL can only ever name an
 * object under `public/`, and only by its exact key: the distribution has no list access,
 * and a key that does not exist answers 403, the same as one that is not allowed. Keys must
 * therefore be unguessable (random, at least 128 bits); the storage driver (T-07) owns that.
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
      ],
    });

    this.photoDistribution = new cloudfront.Distribution(this, 'PhotoCdn', {
      comment: `listora-${target.environment} listing photos`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.photoBucket, {
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

    new CfnOutput(this, 'PhotoBucketName', { value: this.photoBucket.bucketName });
    new CfnOutput(this, 'PhotoCdnDomain', {
      value: this.photoDistribution.distributionDomainName,
    });
  }
}
