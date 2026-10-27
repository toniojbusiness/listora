// Listora's CDK bootstrap template (infra/README.md, Trust boundary): the CDK CLI's own template
// with the deploy role's CloudFormation changes limited to one environment's stacks. The
// default lets the deploy role create, update, and delete any stack in the account and turn off
// any stack's termination protection, so a deploy (from GitHub, through that role) could change
// another app's stacks in a shared account.
//
// `node infra/src/deploy/bootstrap-template.ts <env>` prints the template as YAML;
// scripts/deploy-personal.sh bootstraps with it (`cdk bootstrap --template`).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';

import { ENVIRONMENT_NAMES, type EnvironmentName } from '../config.ts';

/** The output that names the template a bootstrap stack was deployed from. */
export const TEMPLATE_OUTPUT = 'ListoraBootstrapTemplate';

interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: unknown;
}

interface BootstrapTemplate {
  Parameters: Record<string, { Default?: unknown }>;
  Resources: Record<
    string,
    {
      Type: string;
      Properties: {
        Policies?: { PolicyDocument: { Statement: Statement[] } }[];
      };
    }
  >;
  Outputs: Record<string, { Value: unknown; Description?: string }>;
}

/** The CDK CLI's default bootstrap template (the version in package-lock.json). */
export function defaultBootstrapTemplate(): string {
  const require = createRequire(import.meta.url);
  return readFileSync(require.resolve('aws-cdk/lib/api/bootstrap/bootstrap-template.yaml'), 'utf8');
}

const list = (value: string | string[]): string[] => (typeof value === 'string' ? [value] : value);

/** The deploy role's statements, which every patch below expects to find unchanged. */
function deployRoleStatements(template: BootstrapTemplate): Statement[] {
  const statements =
    template.Resources['DeploymentActionRole']?.Properties.Policies?.[0]?.PolicyDocument.Statement;
  if (statements === undefined) {
    throw new Error('the CDK bootstrap template has no DeploymentActionRole policy');
  }
  return statements;
}

function take(statements: Statement[], sid: string, actions: readonly string[]): Statement {
  const statement = statements.find((candidate) => candidate.Sid === sid);
  if (statement === undefined || list(statement.Action).join() !== actions.join()) {
    throw new Error(
      `the CDK bootstrap template's deploy role statement ${sid} changed; review it and update bootstrap-template.ts`,
    );
  }
  return statement;
}

/**
 * The default template with three changes to the deploy role (`cdk-listora-deploy-role-*`),
 * everything else as the CLI ships it:
 *
 * - creating, updating, rolling back, and change sets (`DeployPermissions`), and deleting
 *   stacks and changing their termination protection (`CliPermissions`), only on
 *   `listora-<env>-*` stacks instead of every stack;
 * - no stack refactoring (`Refactor`, on every stack; Listora never refactors);
 * - a `BootstrapVariant` naming it, and the `ListoraBootstrapTemplate` output, a hash of the
 *   rest, so a deploy can tell whether the deployed bootstrap is this template.
 *
 * It throws when the CLI's template no longer has those statements as expected, so a CDK
 * upgrade that changes them is reviewed instead of silently widening the role.
 */
export function listoraBootstrapTemplate(environment: EnvironmentName): {
  readonly yaml: string;
  readonly hash: string;
} {
  const template = parse(defaultBootstrapTemplate()) as BootstrapTemplate;
  const statements = deployRoleStatements(template);
  const ownStacks = {
    'Fn::Sub': `arn:\${AWS::Partition}:cloudformation:\${AWS::Region}:\${AWS::AccountId}:stack/listora-${environment}-*/*`,
  };

  take(statements, 'DeployPermissions', [
    'cloudformation:CreateChangeSet',
    'cloudformation:DeleteChangeSet',
    'cloudformation:ExecuteChangeSet',
    'cloudformation:CreateStack',
    'cloudformation:UpdateStack',
    'cloudformation:RollbackStack',
    'cloudformation:ContinueUpdateRollback',
  ]).Resource = ownStacks;
  const cli = take(statements, 'CliPermissions', [
    'cloudformation:DeleteStack',
    'cloudformation:UpdateTerminationProtection',
    'sts:GetCallerIdentity',
  ]);
  cli.Action = ['cloudformation:DeleteStack', 'cloudformation:UpdateTerminationProtection'];
  cli.Resource = ownStacks;
  const refactor = take(statements, 'Refactor', [
    'cloudformation:CreateStackRefactor',
    'cloudformation:ExecuteStackRefactor',
  ]);
  statements.splice(statements.indexOf(refactor), 1, {
    Sid: 'CliIdentity',
    Effect: 'Allow',
    Action: ['sts:GetCallerIdentity'],
    Resource: '*',
  });

  const variant = template.Parameters['BootstrapVariant'];
  if (variant === undefined) throw new Error('the CDK bootstrap template has no BootstrapVariant');
  variant.Default = `Listora ${environment}: deploy role limited to listora-${environment}-* stacks`;
  const hash = createHash('sha256').update(stringify(template)).digest('hex').slice(0, 16);
  template.Outputs[TEMPLATE_OUTPUT] = {
    Description: 'The Listora bootstrap template (infra/src/deploy/bootstrap-template.ts)',
    Value: hash,
  };
  return { yaml: stringify(template), hash };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [environment, part] = process.argv.slice(2);
  if (
    !ENVIRONMENT_NAMES.some((name) => name === environment) ||
    (part !== undefined && part !== 'hash')
  ) {
    process.stderr.write(
      `usage: node infra/src/deploy/bootstrap-template.ts <${ENVIRONMENT_NAMES.join('|')}> [hash]\n`,
    );
    process.exit(2);
  }
  const { yaml, hash } = listoraBootstrapTemplate(environment as EnvironmentName);
  process.stdout.write(part === 'hash' ? `${hash}\n` : yaml);
}
