// Prints a container's environment as a Docker env file, so the image smoke test
// (scripts/container-smoke.sh) starts each process exactly as ECS configures it.
//
//   node infra/src/container-env.ts <api|worker|runner|migrate> <database-url>
//
// Secrets that ECS injects (PGPASSWORD and the app secrets) take their value from this
// process's environment, or the word `placeholder` when unset. The photo storage, the runner
// service, and the token key are placeholders: the smoke test starts the processes but stores
// no photo or credential, and starts no runner through ECS.
import {
  CONTAINER_NAMES,
  containerEnvironment,
  containerSecretNames,
  type ServiceResources,
} from './containers.ts';

const SMOKE_RESOURCES: ServiceResources = {
  photoStorage: {
    bucket: 'listora-smoke-photos',
    region: 'us-east-1',
    publicBaseUrl: 'https://photos.smoke.invalid',
  },
  runner: { cluster: 'listora-smoke', service: 'runner', region: 'us-east-1' },
  tokenKeyArn: 'alias/listora-smoke-tokens',
};

const [container, databaseUrl] = process.argv.slice(2);
const known = CONTAINER_NAMES.find((name) => name === container);
if (known === undefined || databaseUrl === undefined) {
  process.stderr.write(`usage: container-env.ts <${CONTAINER_NAMES.join('|')}> <database-url>\n`);
  process.exit(2);
}

const entries: [string, string][] = [
  ...Object.entries(containerEnvironment(known, databaseUrl, SMOKE_RESOURCES)),
  ...containerSecretNames(known).map((name): [string, string] => [
    name,
    process.env[name] ?? 'placeholder',
  ]),
];
process.stdout.write(entries.map(([key, value]) => `${key}=${value}\n`).join(''));
