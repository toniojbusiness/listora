// Prints a service's container environment as a Docker env file, so the image smoke test
// (scripts/container-smoke.sh) starts each process exactly as ECS configures it.
//
//   node infra/src/container-env.ts <api|worker> <database-url>
//
// Secrets that ECS injects (PGPASSWORD and the app secrets) take their value from this
// process's environment, or the word `placeholder` when unset.
import { SERVICE_NAMES } from './config.ts';
import { containerEnvironment, containerSecretNames } from './containers.ts';

const [service, databaseUrl] = process.argv.slice(2);
const known = SERVICE_NAMES.find((name) => name === service);
if (known === undefined || databaseUrl === undefined) {
  process.stderr.write(`usage: container-env.ts <${SERVICE_NAMES.join('|')}> <database-url>\n`);
  process.exit(2);
}

const entries: [string, string][] = [
  ...Object.entries(containerEnvironment(known, databaseUrl)),
  ...containerSecretNames(known).map((name): [string, string] => [
    name,
    process.env[name] ?? 'placeholder',
  ]),
];
process.stdout.write(entries.map(([key, value]) => `${key}=${value}\n`).join(''));
