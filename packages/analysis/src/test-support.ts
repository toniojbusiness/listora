/**
 * Test-only helpers for this package's tests (not exported from the package).
 */
import {
  AiClient,
  createModelRegistry,
  CURRENT_PRICE_TABLE,
  FakeAiProvider,
  InMemoryUsageStore,
  inMemoryFixtures,
  photoSetHashOfImages,
  staticKillSwitch,
  type AiImage,
  type AiProvider,
  type FakeFixture,
  type FixtureSource,
  type QuotaPolicy,
} from '@listora/ai';

import type { AnalysisInput, AnalysisPhoto } from './input.ts';
import {
  encodeAnalysisAnswer,
  ITEM_ANALYSIS_OUTPUT_NAME,
  type ItemAnalysisOutput,
} from './output-schema.ts';

export const ACCOUNT = '00000000-0000-7000-8000-0000000000a1';
export const NOW = new Date('2026-10-24T15:30:00Z');

export function image(label: string, width = 1024, height = 768): AiImage {
  return { mediaType: 'image/jpeg', data: new TextEncoder().encode(label), width, height };
}

export function photo(overrides: Partial<AnalysisPhoto> & { photoId: string }): AnalysisPhoto {
  return {
    role: 'front',
    image: image(overrides.photoId),
    ocrLines: [],
    barcodes: [],
    ...overrides,
  };
}

/** A front photo and a tag photo whose phone reads name an RN, a UPC, a size, and fibers. */
export function tagInput(overrides: Partial<AnalysisInput> = {}): AnalysisInput {
  const photos = overrides.photos ?? [
    photo({ photoId: 'front' }),
    photo({
      photoId: 'tag',
      role: 'tag',
      tagCrop: image('tag-crop', 784, 784),
      ocrLines: [
        { text: "LEVI'S", confidence: 0.98 },
        { text: 'RN 12345', confidence: 0.97 },
        { text: 'SIZE M', confidence: 0.96 },
        { text: '60% COTTON 40% POLYESTER', confidence: 0.95 },
        { text: 'STYLE 501-0193', confidence: 0.9 },
      ],
      barcodes: [{ symbology: 'upc_a', payload: '036000291452' }],
    }),
  ];
  return {
    accountId: ACCOUNT,
    userId: null,
    itemId: null,
    photoSetHash: photoSetHashOfImages(photos.map((entry) => entry.image)),
    ...overrides,
    photos,
  };
}

/** A valid answer for `tagInput()`; tests override the parts they look at. */
export function answer(overrides: Partial<ItemAnalysisOutput> = {}): ItemAnalysisOutput {
  const base: ItemAnalysisOutput = {
    attributes: {
      brand: { value: "Levi's", confidence: 0.95, source: 'tag_text' },
      productName: { value: '501 Original', confidence: 0.8, source: 'tag_text' },
      styleNumber: { value: '501-0193', confidence: 0.9, source: 'tag_text' },
      rnNumber: { value: '12345', confidence: 0.92, source: 'tag_text' },
      upc: { value: '036000291452', confidence: 0.95, source: 'barcode' },
      department: { value: 'men', confidence: 0.9, source: 'photo' },
      category: { value: 'clothing/bottoms', confidence: 0.95, source: 'photo' },
      subcategory: { value: 'jeans', confidence: 0.9, source: 'photo' },
      sizeLabel: { value: 'M', confidence: 0.9, source: 'tag_text' },
      sizeSystem: { value: 'letter', confidence: 0.9, source: 'tag_text' },
      colors: { values: ['blue'], confidence: 0.9, source: 'photo' },
      pattern: { value: 'solid', confidence: 0.85, source: 'photo' },
      materials: { values: ['cotton', 'polyester'], confidence: 0.85, source: 'tag_text' },
      condition: { value: 'pre_owned_good', confidence: 0.8, source: 'photo' },
      conditionNotes: { value: 'Light fading at the knees.', confidence: 0.7, source: 'photo' },
      flaws: { values: ['Light fading at the knees'], confidence: 0.7, source: 'photo' },
      keywords: { values: ['straight leg', 'denim'], confidence: 0.7, source: 'photo' },
    },
    title: { value: "Levi's 501 Original Jeans, Men's M", confidence: 0.85 },
    description: { value: "Men's Levi's 501 jeans in blue. Light fading.", confidence: 0.8 },
    variants: {
      ebay: { title: "Levi's 501 Original Jeans Mens M Blue Denim", description: 'Blue jeans.' },
      depop: {
        title: "Levi's 501s",
        description: 'Classic blue 501s, broken in just right.',
        hashtags: ['levis', 'denim', 'vintage'],
      },
      poshmark: { title: "Levi's 501 Original Jeans", description: 'A wardrobe staple.' },
      mercari: { title: "Levi's 501 Jeans Men's M", description: 'Blue jeans, light fading.' },
    },
    priceEstimate: { lowCents: 2_000, midCents: 2_800, highCents: 3_500, confidence: 0.6 },
    looksVintage: false,
    looksDesigner: false,
    needsEscalation: false,
    escalationReason: null,
  };
  return { ...base, ...overrides };
}

export function attributes(
  overrides: Partial<ItemAnalysisOutput['attributes']>,
): Pick<ItemAnalysisOutput, 'attributes'> {
  return { attributes: { ...answer().attributes, ...overrides } };
}

/** Fixture answers in order, then the last one forever: a model that changes its mind. */
export function sequencedFixtures(hash: string, fixtures: readonly FakeFixture[]): FixtureSource {
  let calls = 0;
  return {
    load(photoSetHash) {
      if (photoSetHash !== hash) return Promise.resolve(undefined);
      const fixture = fixtures[Math.min(calls, fixtures.length - 1)];
      calls += 1;
      return Promise.resolve(fixture);
    },
  };
}

/** A fixture answering with `output`, encoded as the model sends it. */
export function analysisFixture(output: ItemAnalysisOutput): FakeFixture {
  return { outputs: { [ITEM_ANALYSIS_OUTPUT_NAME]: encodeAnalysisAnswer(output) } };
}

export function client(
  options: {
    fixtures?: FixtureSource;
    fixture?: FakeFixture;
    hash?: string;
    provider?: AiProvider;
    quota?: QuotaPolicy;
    dailyBudgetMicros?: number;
    killSwitch?: boolean;
  } = {},
) {
  const usageStore = new InMemoryUsageStore({ now: () => NOW });
  const fixtures =
    options.fixtures ??
    inMemoryFixtures({
      [options.hash ?? tagInput().photoSetHash]: options.fixture ?? analysisFixture(answer()),
    });
  const ai = new AiClient({
    provider: options.provider ?? new FakeAiProvider({ fixtures }),
    registry: createModelRegistry({}, CURRENT_PRICE_TABLE),
    usageStore,
    killSwitch: staticKillSwitch(options.killSwitch ?? false),
    dailyBudgetMicros: options.dailyBudgetMicros ?? 1_000_000,
    now: () => NOW,
    ...(options.quota === undefined ? {} : { quota: options.quota }),
  });
  return { ai, usageStore };
}
