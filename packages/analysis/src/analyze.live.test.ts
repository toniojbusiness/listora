import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  AiClient,
  AnthropicProvider,
  createModelRegistry,
  CURRENT_PRICE_TABLE,
  InMemoryUsageStore,
  photoSetHashOfImages,
  staticKillSwitch,
} from '@listora/ai';

import { analyzeItem } from './analyze.ts';
import type { AnalysisInput } from './input.ts';

/** A care label drawn as an image: what a phone photo of a simple tag shows. */
async function careLabel(): Promise<Uint8Array> {
  const lines = ['NORTHWIND', 'RN 141526', 'SIZE M', '100% COTTON', 'MADE IN USA'];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768">
    <rect width="768" height="768" fill="#f4f1ea"/>
    ${lines
      .map(
        (line, index) =>
          `<text x="384" y="${String(200 + index * 90)}" font-family="Helvetica" font-size="56" text-anchor="middle" fill="#111">${line}</text>`,
      )
      .join('')}
  </svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer());
}

// Live smoke test of the whole analysis against the real API. It runs only when
// ANTHROPIC_API_KEY is set (never in CI) and costs about a fifth of a cent on Haiku 5.5.
const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
describe.skipIf(apiKey === '')('analyzeItem live smoke test', () => {
  it('reads a care label into a schema-valid analysis and meters it', async () => {
    const data = await careLabel();
    const store = new InMemoryUsageStore();
    const ai = new AiClient({
      provider: new AnthropicProvider({ apiKey, timeoutMs: 120_000 }),
      registry: createModelRegistry({}, CURRENT_PRICE_TABLE),
      usageStore: store,
      killSwitch: staticKillSwitch(false),
      dailyBudgetMicros: 100_000,
    });
    const input: AnalysisInput = {
      accountId: 'smoke-test',
      userId: null,
      itemId: null,
      photoSetHash: photoSetHashOfImages([{ data }]),
      photos: [
        {
          photoId: 'tag',
          role: 'tag',
          image: { mediaType: 'image/jpeg', data, width: 768, height: 768 },
          ocrLines: [
            { text: 'NORTHWIND', confidence: 0.99 },
            { text: 'RN 141526', confidence: 0.98 },
            { text: 'SIZE M', confidence: 0.98 },
            { text: '100% COTTON', confidence: 0.97 },
            { text: 'MADE IN USA', confidence: 0.97 },
          ],
          barcodes: [],
        },
      ],
    };
    const outcome = await analyzeItem(ai, input, { tier: 'standard' });
    expect(outcome.result.details.rnNumber).toMatchObject({ value: '141526', provenance: 'ocr' });
    expect(outcome.result.variants).toHaveLength(4);
    expect(outcome.costMicros).toBeGreaterThan(0);
    expect(store.events.length).toBe(outcome.attempts);
  }, 180_000);
});
