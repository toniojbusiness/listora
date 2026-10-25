import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { photoSetHash, sha256Hex } from '@listora/shared';
import { describe, expect, it } from 'vitest';

import { DEFAULT_FAKE_FIXTURES_DIR } from './config.ts';
import { AiProviderError } from './errors.ts';
import {
  directoryFixtures,
  estimateImageTokens,
  FakeAiProvider,
  inMemoryFixtures,
  type FakeFixture,
} from './fake-provider.ts';
import { photoSetHashOfImages } from './photo-set-hash.ts';
import type { ProviderRequest } from './provider.ts';
import { COLOR_OUTPUT, image, RED_PIXEL_PNG } from './test-support.ts';
import type { AiImage } from './types.ts';

const FRONT = image('front photo bytes');
const TAG = image('tag photo bytes', 784, 784);

function request(
  images: readonly AiImage[],
  overrides: Partial<ProviderRequest<unknown>> = {},
): ProviderRequest<{ color: string; confidence: number }> {
  return {
    model: 'claude-haiku-5-5',
    effort: 'low',
    system: 'Name the dominant color.',
    prompt: 'Answer in JSON.',
    photoSetHash: photoSetHashOfImages(images),
    images,
    output: COLOR_OUTPUT,
    maxOutputTokens: 1_000,
    ...overrides,
  } as ProviderRequest<{ color: string; confidence: number }>;
}

function provider(fixtures: Record<string, FakeFixture>): FakeAiProvider {
  return new FakeAiProvider({ fixtures: inMemoryFixtures(fixtures) });
}

async function failure(work: Promise<unknown>): Promise<AiProviderError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(AiProviderError);
  return error as AiProviderError;
}

describe('FakeAiProvider', () => {
  const hash = photoSetHashOfImages([FRONT, TAG]);
  const fixtures = {
    [hash]: { outputs: { dominant_color: { color: 'navy', confidence: 0.9 } } },
  };

  it('answers from the fixture keyed by the photo-set hash and the schema name', async () => {
    const result = await provider(fixtures).generate(request([FRONT, TAG]));
    expect(result.output).toEqual({ color: 'navy', confidence: 0.9 });
  });

  it('keys by the item’s photo-set hash, not by the bytes of the images sent', async () => {
    // The item's hash covers its uploads; the request carries their smaller `ai` derivatives.
    const itemHash = photoSetHash([sha256Hex('front upload'), sha256Hex('tag upload')]);
    const fake = provider({
      [itemHash]: { outputs: { dominant_color: { color: 'olive', confidence: 0.8 } } },
    });
    const result = await fake.generate(request([FRONT, TAG], { photoSetHash: itemHash }));
    expect(result.output).toEqual({ color: 'olive', confidence: 0.8 });

    const missing = await failure(fake.generate(request([FRONT, TAG])));
    expect(missing.code).toBe('fixture_missing');
    expect(missing.message).toContain(photoSetHashOfImages([FRONT, TAG]));
  });

  it('is deterministic: the same request gets the same answer and usage every time', async () => {
    const first = await provider(fixtures).generate(request([FRONT, TAG]));
    const again = await provider(fixtures).generate(request([FRONT, TAG]));
    const third = await provider(fixtures).generate(request([FRONT, TAG]));
    expect(again).toEqual(first);
    expect(third).toEqual(first);
  });

  it('estimates usage the way the API counts it', async () => {
    const { usage } = await provider(fixtures).generate(request([FRONT, TAG]));
    // 1024x768 = 37 x 28 patches; 784x784 = 28 x 28; text is about 4 characters per token.
    const text =
      Math.ceil('Name the dominant color.'.length / 4) + Math.ceil('Answer in JSON.'.length / 4);
    expect(usage).toEqual({
      inputTokens: 1_036 + 784 + text,
      outputTokens: Math.ceil(JSON.stringify({ color: 'navy', confidence: 0.9 }).length / 4),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearches: 0,
    });
    expect(estimateImageTokens(1_000, 1_000)).toBe(1_296);
    // Larger images are downsized to a 2,576 px long edge first.
    expect(estimateImageTokens(5_152, 2_576)).toBe(estimateImageTokens(2_576, 1_288));
  });

  it('lets a fixture override the usage', async () => {
    const result = await provider({
      [hash]: { ...fixtures[hash], usage: { inputTokens: 5, cacheReadTokens: 7 } },
    }).generate(request([FRONT, TAG]));
    expect(result.usage).toMatchObject({ inputTokens: 5, cacheReadTokens: 7 });
  });

  it('fails with fixture_missing for an unknown photo set or another schema', async () => {
    const fake = provider(fixtures);
    const unknown = await failure(fake.generate(request([FRONT])));
    expect(unknown.code).toBe('fixture_missing');
    expect(unknown.message).toContain(photoSetHashOfImages([FRONT]));
    // The same photos in another order are the same photo set.
    await expect(fake.generate(request([TAG, FRONT]))).resolves.toMatchObject({
      output: { color: 'navy' },
    });
    expect(
      (
        await failure(
          fake.generate(request([FRONT, TAG], { output: { ...COLOR_OUTPUT, name: 'other' } })),
        )
      ).code,
    ).toBe('fixture_missing');
  });

  it('fails with invalid_output, still billing usage, when the fixture breaks the schema', async () => {
    const error = await failure(
      provider({ [hash]: { outputs: { dominant_color: { color: 42 } } } }).generate(
        request([FRONT, TAG]),
      ),
    );
    expect(error.code).toBe('invalid_output');
    expect(error.usage.inputTokens).toBeGreaterThan(0);
  });

  it('injects the failure a fixture describes, with its usage', async () => {
    const error = await failure(
      provider({
        [hash]: {
          error: { code: 'truncated', retryable: false },
          usage: { inputTokens: 1_900, outputTokens: 8_000 },
        },
      }).generate(request([FRONT, TAG])),
    );
    expect(error).toMatchObject({
      code: 'truncated',
      retryable: false,
      usage: { inputTokens: 1_900, outputTokens: 8_000 },
    });
  });

  it('honours an aborted signal without answering', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await failure(
      provider(fixtures).generate(request([FRONT, TAG], { signal: controller.signal })),
    );
    expect(error.code).toBe('aborted');
  });
});

describe('directoryFixtures', () => {
  it('loads <photo-set hash>.json files and reports missing ones as undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'listora-ai-fixtures-'));
    try {
      await writeFile(
        join(dir, `${'a'.repeat(64)}.json`),
        JSON.stringify({ outputs: { dominant_color: { color: 'red', confidence: 1 } } }),
      );
      const source = directoryFixtures(dir);
      expect(await source.load('a'.repeat(64))).toEqual({
        outputs: { dominant_color: { color: 'red', confidence: 1 } },
      });
      expect(await source.load('b'.repeat(64))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('fails loudly on a malformed fixture', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'listora-ai-fixtures-'));
    try {
      await writeFile(join(dir, `${'c'.repeat(64)}.json`), JSON.stringify({ output: {} }));
      await expect(directoryFixtures(dir).load('c'.repeat(64))).rejects.toThrow(/malformed/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('ships a sample fixture in the default directory', async () => {
    const fake = new FakeAiProvider({ fixtures: directoryFixtures(DEFAULT_FAKE_FIXTURES_DIR) });
    const result = await fake.generate(request([image(RED_PIXEL_PNG, 1, 1)]));
    expect(result.output).toEqual({ color: 'red', confidence: 0.99 });
  });
});
