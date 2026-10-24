/**
 * Generates the code derived from openapi.yaml, checks that the committed copy is current,
 * and compiles and tests the Swift package.
 *
 *   node tools/codegen.ts generate     rewrite src/generated and the Swift Generated folder
 *   node tools/codegen.ts check        regenerate into a temp dir; exit 1 if anything differs
 *   node tools/codegen.ts swift-test   `swift test` the ListoraAPI package (compile proof)
 *
 * Root scripts: `npm run contract:generate` and `npm run contract:check` (see README.md).
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import openapiTS, { astToString } from 'openapi-typescript';

const packageDir = resolve(import.meta.dirname, '..');
const repoRoot = resolve(packageDir, '../..');
const specPath = join(packageDir, 'openapi.yaml');
const swiftPackageDir = join(packageDir, 'swift');
const swiftGeneratorPackageDir = join(packageDir, 'tools/swift-generator');
/** SwiftPM build output and caches stay inside the checkout (gitignored `.build/`). */
const swiftBuildRoot = join(repoRoot, '.build/api-contract');
const swiftCachePath = join(repoRoot, '.build/swiftpm-cache');

const TS_HEADER = `/**
 * Generated from packages/api-contract/openapi.yaml by openapi-typescript.
 * Do not edit: change openapi.yaml and run \`npm run contract:generate\`.
 */

`;

export interface GenerationTarget {
  /** Shown in messages. */
  name: string;
  /** Committed output directory, relative to the package directory. */
  dir: string;
  generate: (outDir: string) => Promise<void>;
}

export const TARGETS: readonly GenerationTarget[] = [
  { name: 'TypeScript types', dir: 'src/generated', generate: generateTypeScript },
  { name: 'Swift client', dir: 'swift/Sources/ListoraAPI/Generated', generate: generateSwift },
];

/** Writes `openapi.ts` (types only, plus `as const` enum value arrays) into `outDir`. */
export async function generateTypeScript(outDir: string): Promise<void> {
  const ast = await openapiTS(pathToFileURL(specPath), {
    // Root aliases (`Item`, `Money`, ...) and runtime enum value arrays for server validation.
    rootTypes: true,
    rootTypesNoSchemaPrefix: true,
    enumValues: true,
    silent: true,
  });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'openapi.ts'), TS_HEADER + astToString(ast));
}

/** Builds the pinned swift-openapi-generator and writes the Swift types and client into `outDir`. */
export async function generateSwift(outDir: string): Promise<void> {
  const scratchPath = join(swiftBuildRoot, 'swift-generator');
  const buildArgs = ['-c', 'release', '--product', 'swift-openapi-generator'];
  runSwift(['build', ...buildArgs], swiftGeneratorPackageDir, scratchPath);
  const binDir = runSwift(
    ['build', ...buildArgs, '--show-bin-path'],
    swiftGeneratorPackageDir,
    scratchPath,
  ).trim();

  await mkdir(outDir, { recursive: true });
  run(
    join(binDir, 'swift-openapi-generator'),
    [
      'generate',
      specPath,
      '--config',
      join(swiftPackageDir, 'openapi-generator-config.yaml'),
      '--output-directory',
      outDir,
    ],
    packageDir,
  );
  await dropPublicImports(outDir);
}

/**
 * The generator repeats every `public import` in each of its split output files, and Swift
 * warns about each one a file does not use publicly. Without `InternalImportsByDefault`, a
 * plain `import` is already public, so dropping the modifier keeps the meaning and silences
 * the warnings.
 */
async function dropPublicImports(outDir: string): Promise<void> {
  for (const path of await listFiles(outDir)) {
    if (!path.endsWith('.swift')) continue;
    const file = join(outDir, path);
    const source = await readFile(file, 'utf8');
    await writeFile(file, source.replace(/^((?:@_spi\(\w+\) )?)public import /gm, '$1import '));
  }
}

/** Compiles the ListoraAPI package (generated code included) and runs its tests. */
export function testSwiftPackage(): void {
  runSwift(['test'], swiftPackageDir, join(swiftBuildRoot, 'swift'), 'inherit');
}

export type DriftKind = 'changed' | 'missing' | 'unexpected';

export interface Drift {
  /** Path relative to the compared directories. */
  path: string;
  /** `missing`: generated but not committed. `unexpected`: committed but no longer generated. */
  kind: DriftKind;
}

/** Compares a freshly generated directory with the committed one, file by file. */
export async function findDrift(generatedDir: string, committedDir: string): Promise<Drift[]> {
  const [generated, committed] = await Promise.all([
    listFiles(generatedDir),
    listFiles(committedDir),
  ]);
  const drift: Drift[] = [];
  for (const path of generated) {
    if (!committed.has(path)) {
      drift.push({ path, kind: 'missing' });
      continue;
    }
    const [fresh, current] = await Promise.all([
      readFile(join(generatedDir, path)),
      readFile(join(committedDir, path)),
    ]);
    if (!fresh.equals(current)) drift.push({ path, kind: 'changed' });
  }
  for (const path of committed) {
    if (!generated.has(path)) drift.push({ path, kind: 'unexpected' });
  }
  return drift.sort((a, b) => a.path.localeCompare(b.path));
}

/** Regenerates every target into a temp dir and reports drift against `baseDir`'s copies. */
export async function checkTargets(
  targets: readonly GenerationTarget[],
  baseDir: string = packageDir,
): Promise<{ target: GenerationTarget; drift: Drift[] }[]> {
  const scratch = await mkdtemp(join(tmpdir(), 'listora-contract-'));
  try {
    const results = [];
    for (const [index, target] of targets.entries()) {
      const outDir = join(scratch, String(index));
      await target.generate(outDir);
      results.push({ target, drift: await findDrift(outDir, join(baseDir, target.dir)) });
    }
    return results;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Regenerates every target and replaces its committed directory (removing stale files). */
export async function writeTargets(
  targets: readonly GenerationTarget[],
  baseDir: string = packageDir,
): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'listora-contract-'));
  try {
    for (const [index, target] of targets.entries()) {
      const outDir = join(scratch, String(index));
      await target.generate(outDir);
      const committedDir = join(baseDir, target.dir);
      await rm(committedDir, { recursive: true, force: true });
      await cp(outDir, committedDir, { recursive: true });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function listFiles(dir: string): Promise<Set<string>> {
  const files = new Set<string>();
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile()) files.add(relative(dir, join(entry.parentPath, entry.name)));
  }
  return files;
}

function runSwift(
  args: string[],
  packagePath: string,
  scratchPath: string,
  stdio: 'pipe' | 'inherit' = 'pipe',
): string {
  return run(
    'swift',
    [
      ...args,
      '--package-path',
      packagePath,
      '--scratch-path',
      scratchPath,
      '--cache-path',
      swiftCachePath,
    ],
    packageDir,
    stdio,
  );
}

/** Runs a command; on failure, throws with its output so the cause is visible. */
function run(
  command: string,
  args: string[],
  cwd: string,
  stdio: 'pipe' | 'inherit' = 'pipe',
): string {
  const options = { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 } as const;
  try {
    if (stdio === 'inherit') {
      // Output goes straight to the terminal, so there is nothing to return.
      execFileSync(command, args, { ...options, stdio: 'inherit' });
      return '';
    }
    return execFileSync(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    const hint =
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? ` (is "${command}" installed and on PATH? The Swift toolchain ships with Xcode)`
        : '';
    throw new Error(`${command} ${args.join(' ')} failed${hint}${output ? `:\n${output}` : ''}`, {
      cause: error,
    });
  }
}

async function main(command: string | undefined): Promise<number> {
  switch (command) {
    case 'generate':
      await writeTargets(TARGETS);
      for (const target of TARGETS) {
        process.stdout.write(`Generated ${target.name} in ${target.dir}\n`);
      }
      return 0;
    case 'check': {
      let stale = false;
      for (const { target, drift } of await checkTargets(TARGETS)) {
        if (drift.length === 0) {
          process.stdout.write(`${target.name}: up to date\n`);
          continue;
        }
        stale = true;
        process.stderr.write(`${target.name} in ${target.dir} is stale:\n`);
        for (const { path, kind } of drift) process.stderr.write(`  ${kind}: ${path}\n`);
      }
      if (stale) {
        process.stderr.write(
          'Generated code does not match openapi.yaml. Run `npm run contract:generate` and commit the result.\n',
        );
        return 1;
      }
      return 0;
    }
    case 'swift-test':
      testSwiftPackage();
      return 0;
    case undefined:
    default:
      process.stderr.write('Usage: node tools/codegen.ts generate|check|swift-test\n');
      return 2;
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
