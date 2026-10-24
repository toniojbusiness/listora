// CDK app entry point (`cdk.json` runs `node src/main.ts`). Synthesizes one environment, chosen
// with `-c env=staging|prod|personal` (or LISTORA_ENV); see infra/README.md for every setting.
import { App } from 'aws-cdk-lib';

import { defineListora } from './app.ts';
import { DeployConfigError, loadDeployTarget } from './config.ts';

const app = new App();
try {
  defineListora(
    app,
    loadDeployTarget((key) => app.node.tryGetContext(key)),
  );
} catch (error) {
  if (!(error instanceof DeployConfigError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
app.synth();
