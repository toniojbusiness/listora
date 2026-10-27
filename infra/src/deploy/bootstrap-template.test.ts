import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { ENVIRONMENT_NAMES } from '../config.ts';
import {
  defaultBootstrapTemplate,
  listoraBootstrapTemplate,
  TEMPLATE_OUTPUT,
} from './bootstrap-template.ts';

interface Statement {
  Sid?: string;
  Action: string | string[];
  Resource: unknown;
}

interface Template {
  Parameters: Record<string, { Default?: unknown }>;
  Resources: Record<
    string,
    { Type: string; Properties: { Policies?: { PolicyDocument: { Statement: Statement[] } }[] } }
  >;
  Outputs: Record<string, { Value: unknown }>;
}

const list = (value: string | string[]): string[] => (typeof value === 'string' ? [value] : value);
const roleStatements = (template: Template): [string, Statement][] =>
  Object.entries(template.Resources)
    .filter(([, resource]) => resource.Type === 'AWS::IAM::Role')
    .flatMap(([name, resource]) =>
      (resource.Properties.Policies ?? []).flatMap((policy) =>
        policy.PolicyDocument.Statement.map((statement): [string, Statement] => [name, statement]),
      ),
    );

describe("Listora's CDK bootstrap template", () => {
  it.each(ENVIRONMENT_NAMES)(
    "lets the %s bootstrap roles change only that environment's stacks",
    (environment) => {
      const template = parse(listoraBootstrapTemplate(environment).yaml) as Template;
      const ownStacks = {
        'Fn::Sub': `arn:\${AWS::Partition}:cloudformation:\${AWS::Region}:\${AWS::AccountId}:stack/listora-${environment}-*/*`,
      };
      const changes = roleStatements(template).filter(([, statement]) =>
        list(statement.Action).some(
          (action) =>
            action.startsWith('cloudformation:') &&
            !/^cloudformation:(Describe|Get|List)/.test(action),
        ),
      );
      // Only the deploy role changes stacks, and only the environment's own.
      expect(changes.map(([role, statement]) => [role, statement.Sid])).toEqual([
        ['DeploymentActionRole', 'DeployPermissions'],
        ['DeploymentActionRole', 'CliPermissions'],
      ]);
      for (const [, statement] of changes) expect(statement.Resource).toEqual(ownStacks);
      expect(
        roleStatements(template).flatMap(([, statement]) => list(statement.Action)),
      ).not.toContain('cloudformation:CreateStackRefactor');
    },
  );

  it("is otherwise the CLI's own template", () => {
    const ours = parse(listoraBootstrapTemplate('personal').yaml) as Template;
    const theirs = parse(defaultBootstrapTemplate()) as Template;
    const { DeploymentActionRole: ourRole, ...ourRest } = ours.Resources;
    const { DeploymentActionRole: theirRole, ...theirRest } = theirs.Resources;
    expect(ourRest).toEqual(theirRest);
    expect(ourRole?.Properties.Policies?.[0]?.PolicyDocument.Statement.length).toBe(
      theirRole?.Properties.Policies?.[0]?.PolicyDocument.Statement.length,
    );
    const { [TEMPLATE_OUTPUT]: marker, ...ourOutputs } = ours.Outputs;
    expect(ourOutputs).toEqual(theirs.Outputs);
    expect(marker?.Value).toBe(listoraBootstrapTemplate('personal').hash);
    const { BootstrapVariant: ourVariant, ...ourParameters } = ours.Parameters;
    const { BootstrapVariant: theirVariant, ...theirParameters } = theirs.Parameters;
    expect(ourParameters).toEqual(theirParameters);
    expect(ourVariant?.Default).not.toBe(theirVariant?.Default);
  });

  it('names a different template per environment, and the same one every time', () => {
    const hashes = ENVIRONMENT_NAMES.map((name) => listoraBootstrapTemplate(name).hash);
    expect(new Set(hashes).size).toBe(ENVIRONMENT_NAMES.length);
    expect(listoraBootstrapTemplate('personal')).toEqual(listoraBootstrapTemplate('personal'));
    expect(hashes[0]).toMatch(/^[0-9a-f]{16}$/);
  });

  it('prints the template and its hash from its command line and refuses bad arguments', () => {
    const script = fileURLToPath(new URL('bootstrap-template.ts', import.meta.url));
    const printed = spawnSync('node', [script, 'personal'], { encoding: 'utf8' });
    expect(printed.status).toBe(0);
    expect(printed.stdout).toBe(listoraBootstrapTemplate('personal').yaml);
    const hash = spawnSync('node', [script, 'personal', 'hash'], { encoding: 'utf8' });
    expect(hash.stdout).toBe(`${listoraBootstrapTemplate('personal').hash}\n`);
    const refused = spawnSync('node', [script, 'nowhere'], { encoding: 'utf8' });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('usage:');
    // Three Node processes start here; on a loaded machine that takes longer than the default 5 s.
  }, 30_000);
});
