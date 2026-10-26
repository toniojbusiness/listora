import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/deploy-personal.sh', import.meta.url));
const ACCOUNT = '976033325938';
const POLICY_ARN = `arn:aws:iam::${ACCOUNT}:policy/listora-personal-cdk-execution`;
const OWNER = 'owner@example.com';
/** The commit the fake `git` checks out. */
const HEAD = '0123456789abcdef0123456789abcdef01234567';

/** An answer of the fake `aws`: printed output and exit status. */
interface Answer {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status?: number;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs the script with fake `aws`, `docker`, `git`, `curl`, and `npx` first on PATH. The fake
 * `aws` answers `<service> <operation>` from `answers`, or `<service> <operation> <stack>` for a
 * call naming `--stack-name <stack>` (anything else fails loudly), and records every call, so a
 * test sees exactly what the script asked AWS; `awsScript`, bash run first with the call's
 * words in `args` and its stack in `stack`, answers what depends on more than that. `npx`
 * fails, except `cdk synth` with `realSynth` (offline, as the script runs it), so no test can
 * reach a cdk command that talks to AWS. `git diff` exits `gitDiff` (1: the paths changed).
 */
function deploy(
  args: string[],
  answers: Record<string, Answer> = {},
  {
    key = 'not-a-real-test-key',
    realSynth = false,
    owner = 'Owner@Example.com',
    awsScript = '',
    gitDiff = 0,
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-personal-'));
  dirs.push(dir);
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  for (const [operation, answer] of Object.entries(answers)) {
    const file = join(dir, `answer_${operation.replaceAll(' ', '_')}`);
    writeFileSync(`${file}.out`, answer.stdout ?? '');
    writeFileSync(`${file}.err`, answer.stderr ?? '');
    writeFileSync(`${file}.status`, String(answer.status ?? 0));
  }
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  stub(
    'aws',
    `echo "$*" >>"${calls}"
all="$*"; args=(); stack=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile|--region) shift 2 ;;
    --stack-name) stack=$2; args+=("$1"); shift ;;
    *) args+=("$1"); shift ;;
  esac
done
${awsScript}
for file in "${dir}/answer_\${args[0]}_\${args[1]}_\${stack}" "${dir}/answer_\${args[0]}_\${args[1]}"; do
  if [[ -e "$file.out" ]]; then cat "$file.out"; cat "$file.err" >&2; exit "$(cat "$file.status")"; fi
done
echo "unexpected aws call: \${args[*]}" >&2; exit 99`,
  );
  stub('docker', `[[ "$1" == info ]] || echo "docker $*" >>"${calls}"`);
  stub(
    'git',
    `case "$1" in status | cat-file) exit 0 ;; rev-parse) echo ${HEAD} ;; diff) exit ${String(gitDiff)} ;; esac`,
  );
  stub('curl', `echo "curl $*" >>"${calls}"; echo '{"status":"ok","checks":{"database":"ok"}}'`);
  const npx = spawnSync('bash', ['-c', 'command -v npx'], { encoding: 'utf8' }).stdout.trim();
  stub(
    'npx',
    `echo "npx $*" >>"${calls}"
if [[ -n "\${AWS_CONFIG_FILE:-}" ]]; then sed 's/^/config: /' "$AWS_CONFIG_FILE" >>"${calls}"; fi
if [[ "${String(realSynth)}" == true && "$1 $2" == "cdk synth" ]]; then exec "${npx}" "$@"; fi
echo "npx must not run in this test" >&2; exit 98`,
  );
  const keyFile = join(dir, 'anthropic.env');
  writeFileSync(keyFile, `ANTHROPIC_API_KEY=${key}\n# a comment\n`);
  const result = spawnSync('bash', [script, ...args, '--anthropic-env', keyFile], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env['PATH'] ?? ''}`,
      HOME: process.env['HOME'],
      LISTORA_OWNER_EMAIL: owner,
    },
  });
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    dir,
  };
}

const identity = (account: string): Answer => ({ stdout: `${account}\n` });
const zones: Answer = {
  stdout: 'us-east-1a\tuse1-az1\nus-east-1b\tuse1-az2\nus-east-1c\tuse1-az3\n',
};

describe('scripts/deploy-personal.sh', () => {
  it('refuses a profile of any other account before anything else', () => {
    const run = deploy(['--profile', 'other'], {
      'sts get-caller-identity': identity('111111111111'),
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain(
      `profile other is account 111111111111, not ${ACCOUNT}; refusing to deploy`,
    );
    expect(run.calls).toEqual([
      '--profile other --region us-east-1 sts get-caller-identity --query Account --output text',
    ]);
  });

  it('refuses to run without a profile', () => {
    const run = deploy([]);
    expect(run.status).toBe(1);
    expect(run.output).toContain('name the AWS profile');
    expect(run.calls).toEqual([]);
  });

  it('refuses to run without the owner email, the only person who can sign in', () => {
    const run = deploy(['--profile', 'p'], {}, { owner: '' });
    expect(run.status).toBe(1);
    expect(run.output).toContain('set LISTORA_OWNER_EMAIL');
    expect(run.calls).toEqual([]);
  });

  it('refuses when the Anthropic key file has no key, and never prints the key', () => {
    const empty = deploy(['--profile', 'p'], {}, { key: '' });
    expect(empty.status).toBe(1);
    expect(empty.output).toContain('has no ANTHROPIC_API_KEY= line');
    expect(empty.calls).toEqual([]);
    const present = deploy(['--profile', 'p'], { 'sts get-caller-identity': identity('1') });
    expect(present.output).toContain('Anthropic key found');
    expect(present.output).not.toContain('not-a-real-test-key');
  });

  it('refuses zones that include use1-az3 and suggests two others', () => {
    const run = deploy(['--profile', 'p'], {
      'sts get-caller-identity': identity(ACCOUNT),
      'ec2 describe-availability-zones': {
        stdout: 'us-east-1a\tuse1-az3\nus-east-1b\tuse1-az1\nus-east-1c\tuse1-az2\n',
      },
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain('set LISTORA_AVAILABILITY_ZONES=us-east-1b,us-east-1c');
  });

  it('stops at a stack that needs a person, changing nothing', () => {
    const run = deploy(['--profile', 'p'], {
      'sts get-caller-identity': identity(ACCOUNT),
      'ec2 describe-availability-zones': zones,
      'cloudformation describe-stacks': {
        stdout: JSON.stringify({ Stacks: [{ StackStatus: 'ROLLBACK_COMPLETE' }] }),
      },
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain(
      'listora-personal-registry is ROLLBACK_COMPLETE and needs a person',
    );
    expect(run.calls.some((call) => / (create|put|update|delete|run)-/.test(call))).toBe(false);
  });

  /** Answers that pass every check before the bootstrap step: a fresh account. */
  const freshAccount: Record<string, Answer> = {
    'sts get-caller-identity': identity(ACCOUNT),
    'ec2 describe-availability-zones': zones,
    'cloudformation describe-stacks': {
      stderr: 'An error occurred (ValidationError): Stack with id x does not exist',
      status: 254,
    },
    'sesv2 get-email-identity': {
      stderr: 'An error occurred (NotFoundException) when calling the GetEmailIdentity operation',
      status: 254,
    },
  };
  const toolkit = (policies: string): Answer => ({
    stdout: JSON.stringify({
      Stacks: [
        {
          StackStatus: 'CREATE_COMPLETE',
          Parameters: [
            { ParameterKey: 'CloudFormationExecutionPolicies', ParameterValue: policies },
          ],
        },
      ],
    }),
  });

  it('creates the owner email identity only when the account does not already have it', () => {
    const synthOf = (answers: Record<string, Answer>) => {
      const run = deploy(['--profile', 'p'], { ...freshAccount, ...answers });
      return { run, synth: run.calls.find((call) => call.startsWith('npx cdk synth')) ?? '' };
    };
    // A fresh account: the email stack creates it (and AWS emails the verification link).
    expect(synthOf({}).synth).toContain('--context ownerEmailIdentity=create');

    // Already in the account, outside Listora's stacks: left alone, never taken over.
    const outside = synthOf({
      'sesv2 get-email-identity': { stdout: '{"VerifiedForSendingStatus": true}' },
      'cloudformation list-stack-resources': { stdout: '' },
    });
    expect(outside.synth).toContain('--context ownerEmailIdentity=existing');
    expect(outside.run.output).toContain('already in the account outside Listora');

    // Made by Listora's email stack on an earlier deploy: the stack keeps managing it.
    const owned = synthOf({
      'sesv2 get-email-identity': { stdout: '{"VerifiedForSendingStatus": true}' },
      'cloudformation list-stack-resources': { stdout: `${OWNER}\n` },
    });
    expect(owned.synth).toContain('--context ownerEmailIdentity=create');
    // Three runs of the script: past the default timeout on a busy machine.
  }, 120_000);

  it("refuses Listora's bootstrap when it is not the restricted one, changing nothing", () => {
    const run = deploy(
      ['--profile', 'p'],
      {
        ...freshAccount,
        'cloudformation describe-stacks CDKToolkit-listora': toolkit(''),
      },
      { realSynth: true },
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain(
      `CDKToolkit-listora runs CloudFormation with 'AdministratorAccess (the default)', not ${POLICY_ARN}`,
    );
    // It looked only at Listora's own toolkit stack, never the account's default CDKToolkit.
    expect(run.calls.some((call) => / --stack-name CDKToolkit( |$)/.test(call))).toBe(false);
    expect(run.calls.some((call) => / (create|put|update|delete|run)-/.test(call))).toBe(false);
  }, 120_000);

  it("creates the policy and bootstraps when Listora's bootstrap does not exist yet", () => {
    const run = deploy(
      ['--profile', 'p'],
      {
        ...freshAccount,
        'iam get-policy': {
          stderr: 'An error occurred (NoSuchEntity) when calling the GetPolicy operation',
          status: 254,
        },
        'iam create-policy': { stdout: '{}' },
      },
      { realSynth: true },
    );
    // The fake npx refuses the bootstrap itself, after the policy exists.
    expect(run.output).toContain('cdk bootstrap failed');
    expect(run.calls).toContainEqual(
      expect.stringMatching(/iam create-policy --policy-name listora-personal-cdk-execution /),
    );
    expect(run.calls).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^npx cdk bootstrap aws://${ACCOUNT}/us-east-1 --app cdk.out/deploy-personal --qualifier listora --toolkit-stack-name CDKToolkit-listora --cloudformation-execution-policies ${POLICY_ARN} --termination-protection --profile listora-deploy-cdk `,
        ),
      ),
    );
    // cdk gets the profile's credentials from the AWS CLI through a private config, which
    // names the CLI command but holds no credentials.
    expect(run.calls).toContain('config: [profile listora-deploy-cdk]');
    expect(run.calls).toContainEqual(
      expect.stringMatching(
        /^config: credential_process = env AWS_CONFIG_FILE=".+" aws configure export-credentials --profile p --format process$/,
      ),
    );
    expect(run.calls.filter((call) => call.startsWith('config: '))).not.toContainEqual(
      expect.stringMatching(/aws_access_key_id|aws_secret_access_key|aws_session_token/i),
    );
  }, 120_000);

  it('goes past an existing restricted bootstrap without bootstrapping again', () => {
    const run = deploy(
      ['--profile', 'p'],
      {
        ...freshAccount,
        'cloudformation describe-stacks CDKToolkit-listora': toolkit(POLICY_ARN),
        'iam get-policy': { stdout: JSON.stringify({ Policy: { DefaultVersionId: 'v1' } }) },
        'iam get-policy-version': { stdout: '{"Version":"2012-10-17","Statement":[]}' },
        'iam list-policy-versions': { stdout: '1\n' },
        'iam create-policy-version': { stdout: '{}' },
      },
      { realSynth: true },
    );
    expect(run.output).toContain(`CDKToolkit-listora uses ${POLICY_ARN}`);
    expect(run.output).toContain(
      'listora-personal-cdk-execution updated to the committed document',
    );
    expect(run.calls.some((call) => call.startsWith('npx cdk bootstrap'))).toBe(false);
    // Every cdk command that talks to AWS first renews the sign-in through the CLI.
    const deployCall = run.calls.findIndex((call) => call.startsWith('npx cdk deploy'));
    expect(run.calls[deployCall - 1]).toMatch(/sts get-caller-identity$/);
    // Next it deploys the registry, which the fake npx refuses.
    expect(run.calls).toContainEqual(
      expect.stringMatching(
        /^npx cdk deploy --app cdk.out\/deploy-personal --require-approval never listora-personal-registry/,
      ),
    );
  }, 120_000);

  it('dry run: checks everything offline, prints every step, and never calls AWS', () => {
    const run = deploy(['--dry-run', '--profile', 'p']);
    // npx is the fake here, so synthesis fails, after the checks that need no AWS at all.
    expect(run.calls).toEqual([
      expect.stringMatching(
        /^npx cdk synth --quiet .*--context env=personal --context account=976033325938/,
      ),
    ]);
    expect(run.output).toContain('would run: aws sts get-caller-identity --profile p');
    expect(run.output).toContain('cdk synth failed');
    expect(run.calls[0]).toContain(`--context ownerEmail=${OWNER}`);
  });
});

describe('scripts/deploy-personal.sh --dry-run with the real cdk', () => {
  it('synthesizes, checks the templates, and prints every step without calling AWS', () => {
    // Only aws is faked (and fails on any call); cdk synth runs for real, offline.
    const dir = mkdtempSync(join(tmpdir(), 'deploy-personal-dry-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'aws'), `#!/usr/bin/env bash\necho "$*" >>"${dir}/calls"; exit 99\n`);
    chmodSync(join(dir, 'aws'), 0o755);
    writeFileSync(join(dir, 'anthropic.env'), 'ANTHROPIC_API_KEY=not-a-real-dry-run-key\n');
    const result = spawnSync(
      'bash',
      [script, '--dry-run', '--profile', 'p', '--anthropic-env', join(dir, 'anthropic.env')],
      {
        encoding: 'utf8',
        env: {
          PATH: `${dir}:${process.env['PATH'] ?? ''}`,
          HOME: process.env['HOME'],
          LISTORA_OWNER_EMAIL: OWNER,
        },
      },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(() => readFileSync(join(dir, 'calls'))).toThrow();
    const output = result.stdout;
    for (const expected of [
      'api: AUTH_DRIVER=cognito, AI_PROVIDER=anthropic (the fake AI is off)',
      `sign-in: the Cognito user pool, no sign-up, and ${OWNER} its only user`,
      `aws sesv2 get-email-identity --email-identity <each of ${OWNER}>`,
      'npx cdk deploy --app cdk.out/deploy-personal --require-approval never listora-personal-auth',
      'database: deletion protection on',
      `--cloudformation-execution-policies ${POLICY_ARN} --termination-protection`,
      'listora-personal-data: 6 resources',
      'scripts/run-migrations.sh personal',
      // Both images the stacks run, as the Deploy workflow builds them.
      '--target app --tag 976033325938.dkr.ecr.us-east-1.amazonaws.com/listora/app:',
      '--target runner --tag 976033325938.dkr.ecr.us-east-1.amazonaws.com/listora/runner:',
      'node infra/src/deploy/smoke.ts --api-url <ApiUrl> --auth cognito',
      'dry run ok; nothing was sent to AWS',
    ]) {
      expect(output).toContain(expected);
    }
    expect(output).not.toContain('not-a-real-dry-run-key');
    // The steps run in the deploy order of .github/workflows/deploy.yml.
    const order = [
      'Verify the AWS account',
      'restricted execution policy',
      'Deploy the image repository',
      'Build and push',
      'state stacks and the migration task',
      'Wait until SES has verified',
      'Deploy the user pool',
      'Store the Anthropic key',
      'Run the schema migrations',
      'Deploy the services and alarms',
      'Wait for the API',
      'Smoke test',
    ].map((title) => output.indexOf(title));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  }, 120_000);
});

describe('scripts/deploy-personal.sh --code-only', () => {
  /** The commit the deployed services run. */
  const DEPLOYED = 'fedcba9876543210fedcba9876543210fedcba98';
  const REGISTRY = `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com`;
  const TASKS = `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition`;
  const ASSEMBLY = fileURLToPath(new URL('../../cdk.out/deploy-personal', import.meta.url));
  const policy = spawnSync(
    'node',
    [fileURLToPath(new URL('execution-policy.ts', import.meta.url)), 'personal', ACCOUNT],
    { encoding: 'utf8' },
  ).stdout;
  // The logical ids of the services' task definitions, as the synthesized template has them.
  const compute = JSON.parse(
    readFileSync(
      new URL('../__snapshots__/personal/compute.template.json', import.meta.url),
      'utf8',
    ),
  ) as { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> };
  const serviceTasks = Object.values(compute.Resources)
    .filter((resource) => resource.Type === 'AWS::ECS::Service')
    .map((resource) => [
      String(resource.Properties['ServiceName']),
      (resource.Properties['TaskDefinition'] as { Ref: string }).Ref,
    ]);

  /** A deployed environment: every stack, Listora's bootstrap, and the key, all current. */
  const deployed: Record<string, Answer> = {
    'sts get-caller-identity': identity(ACCOUNT),
    'ec2 describe-availability-zones': zones,
    'cloudformation describe-stacks': {
      stdout: JSON.stringify({ Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }] }),
    },
    'cloudformation describe-stacks CDKToolkit-listora': {
      stdout: JSON.stringify({
        Stacks: [
          {
            StackStatus: 'UPDATE_COMPLETE',
            Parameters: [
              { ParameterKey: 'CloudFormationExecutionPolicies', ParameterValue: POLICY_ARN },
            ],
          },
        ],
      }),
    },
    'sesv2 get-email-identity': {
      stderr: 'An error occurred (NotFoundException) when calling the GetEmailIdentity operation',
      status: 254,
    },
    'iam get-policy': { stdout: JSON.stringify({ Policy: { DefaultVersionId: 'v2' } }) },
    'iam get-policy-version': { stdout: policy },
    'secretsmanager get-secret-value': { stdout: 'not-a-real-test-key\n' },
    'ecr get-login-password': { stdout: 'password\n' },
    'ecr describe-images': { stderr: 'ImageNotFoundException', status: 254 },
  };

  /**
   * The answers that depend on the call: the deployed templates (the synthesized ones with the
   * deployed commit's tag, and `changed` with a resource more), the compute stack's resources,
   * and ECS, whose services run what `update-service` last gave them (`rolledBack`: ECS put
   * them back on their old task definition).
   */
  function environment({ changed = '', rolledBack = false } = {}) {
    const definitions = JSON.stringify(
      serviceTasks.map(([service, id]) => [id, `${TASKS}/listora-personal-${String(service)}:7`]),
    );
    return String.raw`
state="$(dirname "$0")/state"; mkdir -p "$state"
service=$(sed -n 's/.*--service[s]* \([^ ]*\).*/\1/p' <<<"$all")
definition=$(sed -n 's/.*--task-definition \([^ ]*\).*/\1/p' <<<"$all")
family=$(sed -e 's/.*task-definition\///' -e 's/:[^:]*$//' <<<"$definition")
running=$(cat "$state/$service" 2>/dev/null || echo "${TASKS}/listora-personal-$service:7")
case "$all" in
  *"cloudformation get-template"*)
    jq --arg stack "$stack" 'if $stack == "${changed}" then .Resources.Extra = {"Type": "AWS::SNS::Topic"} else . end' \
      "${ASSEMBLY}/$stack.template.json" | sed "s/:${HEAD}/:${DEPLOYED}/g"
    exit 0 ;;
  *"describe-stacks"*"--query"*ClusterName*) echo listora-personal; exit 0 ;;
  *"describe-stacks"*"--query"*ApiUrl*) echo https://api.example.test; exit 0 ;;
  *"describe-stacks"*"--query Stacks[0].Outputs "*)
    echo '[{"OutputKey":"SubnetIds","OutputValue":"subnet-1"},{"OutputKey":"SecurityGroupId","OutputValue":"sg-1"},{"OutputKey":"AssignPublicIp","OutputValue":"ENABLED"}]'
    exit 0 ;;
  *"cloudformation list-stack-resources"*)
    if [[ "$stack" == listora-personal-compute ]]; then echo '${definitions}'; else echo "${TASKS}/listora-personal-migrate:8"; fi
    exit 0 ;;
  *"ecs describe-services"*"--query"*) echo "$running"; exit 0 ;;
  *"ecs describe-services"*)
    if [[ "${String(rolledBack)}" == true ]]; then running="${TASKS}/listora-personal-$service:7"; fi
    printf '{"services":[{"deployments":[{"status":"PRIMARY","taskDefinition":"%s","rolloutState":"COMPLETED","runningCount":1,"desiredCount":1}]}]}' "$running"
    exit 0 ;;
  *"ecs describe-task-definition"*)
    tag=${DEPLOYED}; if [[ "$definition" == *:new ]]; then tag=${HEAD}; fi
    repository=app; if [[ "$family" == *-runner ]]; then repository=runner; fi
    image="${REGISTRY}/listora/$repository:$tag"
    if [[ "$all" == *--query* ]]; then printf '%s\t%s\n' "$image" "$image"; exit 0; fi
    jq -n --arg arn "$definition" --arg family "$family" --arg image "$image" '{
      taskDefinition: {taskDefinitionArn: $arn, family: $family, revision: 7, status: "ACTIVE",
        requiresAttributes: [{name: "ecs.capability.secrets.asm.environment-variables"}],
        compatibilities: ["EC2", "FARGATE"], registeredAt: "2026-10-25T00:00:00Z",
        registeredBy: "arn:aws:sts::1:assumed-role/cfn", cpu: "512", memory: "1024",
        containerDefinitions: [{name: "api", image: $image}, {name: "sidecar", image: "public.ecr.aws/other/image:1.2"}]},
      tags: [{key: "project", value: "listora"}]}'
    exit 0 ;;
  *"ecs register-task-definition"*)
    file=$(sed -n 's/.*--cli-input-json file:\/\/\([^ ]*\).*/\1/p' <<<"$all")
    family=$(jq -r .family "$file"); cp "$file" "$state/registered-$family.json"
    echo "${TASKS}/$family:new"; exit 0 ;;
  *"ecs update-service"*) echo "$definition" >"$state/$service"; echo '{}'; exit 0 ;;
  *"ecs run-task"*) echo '{"tasks":[{"taskArn":"arn:aws:ecs:task/1"}]}'; exit 0 ;;
  *"ecs describe-tasks"*) echo '{"tasks":[{"lastStatus":"STOPPED","containers":[{"exitCode":0}]}]}'; exit 0 ;;
esac`;
  }
  const changes = (calls: string[]) =>
    calls.filter((call) =>
      /(^docker (build|push)| (create|put|update|delete|run|register)-)/.test(call),
    );
  const registered = (dir: string, family: string) =>
    JSON.parse(readFileSync(join(dir, 'state', `registered-${family}.json`), 'utf8')) as {
      family: string;
      containerDefinitions: { name: string; image: string }[];
      tags?: unknown;
    } & Record<string, unknown>;

  it('moves the services to new revisions with only the images changed, without CloudFormation', () => {
    const run = deploy(['--code-only', '--profile', 'p'], deployed, {
      realSynth: true,
      awsScript: environment(),
    });
    expect(run.output).toContain(
      'every stack matches the synthesized templates but for the image tag, and the Anthropic key is unchanged',
    );
    expect(run.output).toContain(`the services run ${DEPLOYED}`);
    // No CloudFormation deploy at all, and no migration: none changed since the deployed commit.
    expect(run.calls.some((call) => call.startsWith('npx cdk deploy'))).toBe(false);
    expect(run.output).toContain(`no migration changed since ${DEPLOYED.slice(0, 12)}`);
    expect(run.calls.some((call) => call.includes('ecs run-task'))).toBe(false);
    // Both images, each reusing the deployed images' layers.
    for (const [target, from] of [
      ['app', ['app']],
      ['runner', ['runner', 'app']],
    ] as const) {
      const build = run.calls.find((call) => call.includes(`--target ${target} `)) ?? '';
      expect(build).toContain(`--tag ${REGISTRY}/listora/${target}:${HEAD} --cache-to type=inline`);
      for (const repository of from) {
        expect(build).toContain(
          `--cache-from type=registry,ref=${REGISTRY}/listora/${repository}:${DEPLOYED}`,
        );
      }
      expect(run.calls).toContain(`docker push ${REGISTRY}/listora/${target}:${HEAD}`);
    }
    // Each new revision is the stack's task definition with this commit's images, nothing else.
    for (const [service] of serviceTasks) {
      const family = `listora-personal-${String(service)}`;
      const revision = registered(run.dir, family);
      expect(revision.containerDefinitions).toEqual([
        {
          name: 'api',
          image: `${REGISTRY}/listora/${service === 'runner' ? 'runner' : 'app'}:${HEAD}`,
        },
        { name: 'sidecar', image: 'public.ecr.aws/other/image:1.2' },
      ]);
      expect(revision).toMatchObject({ family, cpu: '512', memory: '1024' });
      expect(revision.tags).toEqual([{ key: 'project', value: 'listora' }]);
      for (const readOnly of ['taskDefinitionArn', 'revision', 'status', 'registeredAt'])
        expect(revision).not.toHaveProperty(readOnly);
      expect(run.calls).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `ecs update-service --cluster listora-personal --service ${String(service)} --task-definition ${TASKS}/${family}:new$`,
          ),
        ),
      );
      expect(run.output).toContain(`${String(service)}: runs only ${family}:new`);
    }
    // Then the same health wait and smoke test as the full deploy (the smoke test cannot reach
    // the fake API).
    expect(run.calls).toContain(
      'curl --silent --fail --max-time 10 https://api.example.test/health/ready',
    );
    expect(run.output).toContain('the smoke test failed against https://api.example.test');
    expect(run.status).toBe(1);
  }, 120_000);

  it('runs the migrations, with the new image, when the commit changes one', () => {
    const run = deploy(['--code-only', '--profile', 'p'], deployed, {
      realSynth: true,
      awsScript: environment(),
      gitDiff: 1,
    });
    expect(run.output).toContain(`packages/db/migrations changed since ${DEPLOYED.slice(0, 12)}`);
    expect(registered(run.dir, 'listora-personal-migrate').containerDefinitions[0]?.image).toBe(
      `${REGISTRY}/listora/app:${HEAD}`,
    );
    const migrate = run.calls.findIndex((call) =>
      call.includes(
        `ecs run-task --cluster listora-personal-migrate --task-definition ${TASKS}/listora-personal-migrate:new `,
      ),
    );
    // Before any service moves.
    expect(migrate).toBeGreaterThan(0);
    expect(run.calls.findIndex((call) => call.includes('ecs update-service'))).toBeGreaterThan(
      migrate,
    );
  }, 120_000);

  it('refuses a commit that changes the infrastructure, naming the stack, and changes nothing', () => {
    const run = deploy(['--code-only', '--profile', 'p'], deployed, {
      realSynth: true,
      awsScript: environment({ changed: 'listora-personal-data' }),
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain(
      'the infrastructure differs from what is deployed in listora-personal-data',
    );
    expect(run.output).toContain(
      'this commit needs the full deploy (nothing was changed): scripts/deploy-personal.sh --profile p',
    );
    expect(changes(run.calls)).toEqual([]);
  }, 120_000);

  it('refuses a new Anthropic key, which only the full deploy stores', () => {
    const run = deploy(
      ['--code-only', '--profile', 'p'],
      { ...deployed, 'secretsmanager get-secret-value': { stdout: 'an-older-key\n' } },
      { realSynth: true, awsScript: environment() },
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain('is new');
    expect(run.output).toContain('this commit needs the full deploy');
    expect(run.output).not.toContain('an-older-key');
    expect(changes(run.calls)).toEqual([]);
  }, 120_000);

  it('refuses an execution policy that differs from the committed one', () => {
    const run = deploy(
      ['--code-only', '--profile', 'p'],
      {
        ...deployed,
        'iam get-policy-version': { stdout: '{"Version":"2012-10-17","Statement":[]}' },
      },
      { realSynth: true, awsScript: environment() },
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain(
      'listora-personal-cdk-execution differs from the committed document',
    );
    expect(changes(run.calls)).toEqual([]);
  }, 120_000);

  it('refuses before the first full deploy, when a stack does not exist yet', () => {
    const run = deploy(['--code-only', '--profile', 'p'], {
      ...deployed,
      'cloudformation describe-stacks listora-personal-compute': {
        stderr: 'An error occurred (ValidationError): Stack with id x does not exist',
        status: 254,
      },
    });
    expect(run.status).toBe(1);
    expect(run.output).toContain(
      'listora-personal-compute does not exist yet, so --code-only has nothing to update; deploy in full',
    );
    expect(changes(run.calls)).toEqual([]);
  });

  it('fails, without the health check, when ECS rolls a service back', () => {
    const run = deploy(['--code-only', '--profile', 'p'], deployed, {
      realSynth: true,
      awsScript: environment({ rolledBack: true }),
    });
    expect(run.status).toBe(1);
    expect(run.output).toMatch(/ECS rolled the \w+ service back to its previous task definition/);
    expect(run.output).not.toContain('deploy-personal: deployed');
    expect(run.calls.some((call) => call.startsWith('curl'))).toBe(false);
  }, 120_000);
});
