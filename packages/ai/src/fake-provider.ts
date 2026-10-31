import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { AI_ERROR_CODES, AiProviderError } from './errors.ts';
import type { AiProvider, ProviderRequest, ProviderResponse } from './provider.ts';
import type { TokenUsage } from './types.ts';

const usageSchema = z
  .object({
    inputTokens: z.int().nonnegative(),
    outputTokens: z.int().nonnegative(),
    cacheReadTokens: z.int().nonnegative(),
    cacheWriteTokens: z.int().nonnegative(),
    webSearches: z.int().nonnegative(),
  })
  .partial()
  .strict();

/**
 * One fixture file, `<photo-set hash>.json`. `outputs` holds the answer per output schema
 * name. `usage` overrides the estimated usage. `error` makes every call on this photo set fail
 * the way the real provider would, still billing `usage`.
 */
export const fakeFixtureSchema = z
  .object({
    description: z.string().optional(),
    outputs: z.record(z.string(), z.unknown()).optional(),
    usage: usageSchema.optional(),
    /** The pages a web-search call "found", returned with its answer. */
    webSources: z.array(z.object({ url: z.string(), title: z.string() }).strict()).optional(),
    error: z
      .object({
        code: z.enum(AI_ERROR_CODES),
        message: z.string().optional(),
        retryable: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type FakeFixture = z.infer<typeof fakeFixtureSchema>;

export interface FixtureSource {
  /** The fixture for a photo set, or undefined when there is none. */
  load(photoSetHash: string): Promise<FakeFixture | undefined>;
}

/** The file in a fixture directory that answers every photo set without a file of its own. */
export const DEFAULT_FIXTURE_FILE = 'default.json';

/**
 * Fixtures as `<dir>/<photo-set hash>.json` files, falling back to `<dir>/default.json` when it
 * exists (a directory for end-to-end runs, whose photo sets are not known in advance). A
 * malformed file fails loudly.
 */
export function directoryFixtures(dir: string): FixtureSource {
  return {
    async load(photoSetHash) {
      return (
        (await readFixture(dir, `${photoSetHash}.json`)) ??
        (await readFixture(dir, DEFAULT_FIXTURE_FILE))
      );
    },
  };
}

async function readFixture(dir: string, file: string): Promise<FakeFixture | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, file), 'utf8');
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = fakeFixtureSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new TypeError(`fake AI fixture ${file} is malformed: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Fixtures held in memory, keyed by photo-set hash; for tests. */
export function inMemoryFixtures(fixtures: Readonly<Record<string, FakeFixture>>): FixtureSource {
  return {
    load(photoSetHash) {
      return Promise.resolve(
        Object.hasOwn(fixtures, photoSetHash) ? fixtures[photoSetHash] : undefined,
      );
    },
  };
}

/**
 * Deterministic stand-in for a real provider: the answer is fixture JSON keyed by the
 * request's photo-set hash (the item's, not a hash of the images sent) and the output schema's
 * name. It never touches the
 * network, and the same request always gets the same answer and the same usage.
 *
 * It keeps the real contract: outputs are validated against the schema (a mismatch is an
 * `invalid_output` failure that still bills usage), and usage is estimated the way the real
 * provider counts it, so metering and budgets behave the same in development.
 */
export class FakeAiProvider implements AiProvider {
  readonly id = 'fake';
  readonly #fixtures: FixtureSource;

  constructor(options: { fixtures: FixtureSource }) {
    this.#fixtures = options.fixtures;
  }

  async generate<T>(request: ProviderRequest<T>): Promise<ProviderResponse<T>> {
    if (request.signal?.aborted === true) {
      throw new AiProviderError('aborted', 'the call was aborted before it was sent');
    }
    const hash = request.photoSetHash;
    const fixture = await this.#fixtures.load(hash);
    const answer = fixture?.outputs?.[request.output.name];
    const estimated = estimateUsage(request, answer);
    const override = fixture?.usage ?? {};
    const usage: TokenUsage = {
      inputTokens: override.inputTokens ?? estimated.inputTokens,
      outputTokens: override.outputTokens ?? estimated.outputTokens,
      cacheReadTokens: override.cacheReadTokens ?? estimated.cacheReadTokens,
      cacheWriteTokens: override.cacheWriteTokens ?? estimated.cacheWriteTokens,
      webSearches: override.webSearches ?? estimated.webSearches,
    };

    if (fixture?.error !== undefined) {
      throw new AiProviderError(
        fixture.error.code,
        fixture.error.message ?? `fake provider: injected ${fixture.error.code}`,
        { retryable: fixture.error.retryable ?? false, usage },
      );
    }
    if (fixture === undefined || answer === undefined) {
      throw new AiProviderError(
        'fixture_missing',
        `fake provider: no ${request.output.name} fixture for photo set ${hash}`,
      );
    }
    const parsed = request.output.schema.safeParse(answer);
    if (!parsed.success) {
      throw new AiProviderError(
        'invalid_output',
        `fake provider: the ${request.output.name} fixture for photo set ${hash} does not ` +
          `match the schema: ${parsed.error.message}`,
        { usage },
      );
    }
    return {
      output: parsed.data,
      usage,
      ...(fixture.webSources === undefined ? {} : { webSources: fixture.webSources }),
    };
  }
}

/** Long edge the API downsizes larger images to before counting their tokens. */
const MAX_IMAGE_EDGE = 2_576;

/** Image tokens as the API counts them: one per 28x28 pixel patch. */
export function estimateImageTokens(width: number, height: number): number {
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
  return Math.ceil((width * scale) / 28) * Math.ceil((height * scale) / 28);
}

/** About four characters per text token. */
function textTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateUsage(request: ProviderRequest<unknown>, answer: unknown): TokenUsage {
  const imageTokens = request.images.reduce(
    (sum, image) => sum + estimateImageTokens(image.width, image.height),
    0,
  );
  return {
    inputTokens: textTokens(request.system) + textTokens(request.prompt) + imageTokens,
    outputTokens: answer === undefined ? 0 : textTokens(JSON.stringify(answer)),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    webSearches: request.webSearch === undefined ? 0 : 1,
  };
}
