/**
 * Listora's own CDK bootstrap, separate from any other CDK app's in the same account: its
 * resources are named with this qualifier (`cdk-listora-*` roles, the
 * `cdk-listora-assets-<account>-<region>` bucket, the `/cdk-bootstrap/listora/version`
 * parameter) and live in this toolkit stack, so bootstrapping and deploying Listora never
 * changes the account's default `CDKToolkit` (qualifier `hnb659fds`) or the apps that use it.
 * `cdk.json` sets both for every `cdk` command (`bootstrap.test.ts` checks it), and
 * scripts/deploy-personal.sh bootstraps with them (infra/README.md, Trust boundary).
 */
export const CDK_BOOTSTRAP_QUALIFIER = 'listora';
export const CDK_TOOLKIT_STACK_NAME = 'CDKToolkit-listora';
