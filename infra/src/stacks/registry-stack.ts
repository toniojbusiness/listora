import { RemovalPolicy } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import type { Construct } from 'constructs';

import { ListoraStack, type ListoraStackProps } from './common.ts';

/** One image runs both services; the task definition picks the entry point. */
export const IMAGE_REPOSITORY_NAME = 'listora/app';

/** The browser runner's image: the same sources with headless Chromium (the `runner` stage). */
export const RUNNER_IMAGE_REPOSITORY_NAME = 'listora/runner';

/** How many images to keep for rollbacks. */
const KEPT_IMAGES = 50;

/**
 * The image repositories: the application's, and the browser runner's. They are their own
 * stack because the deploy workflow pushes the images before the compute stack can start tasks
 * from them. Tags are immutable (one per git commit) and every push is scanned for known
 * vulnerabilities.
 */
export class RegistryStack extends ListoraStack {
  readonly repository: ecr.Repository;
  readonly runnerRepository: ecr.Repository;

  constructor(scope: Construct, id: string, props: ListoraStackProps) {
    super(scope, id, props);

    const repository = (logicalId: string, repositoryName: string): ecr.Repository =>
      new ecr.Repository(this, logicalId, {
        repositoryName,
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
    this.repository = repository('App', IMAGE_REPOSITORY_NAME);
    this.runnerRepository = repository('Runner', RUNNER_IMAGE_REPOSITORY_NAME);
  }
}
