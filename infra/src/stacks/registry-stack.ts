import { RemovalPolicy } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import type { Construct } from 'constructs';

import { ListoraStack, type ListoraStackProps } from './common.ts';

/** One image runs both services; the task definition picks the entry point. */
export const IMAGE_REPOSITORY_NAME = 'listora/app';

/** How many images to keep for rollbacks. */
const KEPT_IMAGES = 50;

/**
 * The application image repository. It is its own stack because the deploy workflow pushes
 * the image before the compute stack can start tasks from it. Tags are immutable (one per git
 * commit) and every push is scanned for known vulnerabilities.
 */
export class RegistryStack extends ListoraStack {
  readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: ListoraStackProps) {
    super(scope, id, props);

    this.repository = new ecr.Repository(this, 'App', {
      repositoryName: IMAGE_REPOSITORY_NAME,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          description: `Keep the newest ${String(KEPT_IMAGES)} images`,
          maxImageCount: KEPT_IMAGES,
        },
      ],
    });
  }
}
