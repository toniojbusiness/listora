import { describe, expect, it } from 'vitest';

import { DEFAULT_DEPOP_DESCRIPTION_STYLE } from './description-style.ts';
import { MAX_ANALYSIS_PHOTOS, scanReadHint, selectAnalysisPhotos } from './input.ts';
import { buildAnalysisRequest, ITEM_ANALYSIS_SYSTEM } from './prompt.ts';
import { image, photo, tagInput } from './test-support.ts';

describe('buildAnalysisRequest', () => {
  it('sends the photos in display order, then the tag crops, and says which image is which', () => {
    const input = tagInput();
    const request = buildAnalysisRequest(input);
    expect(request.images.map((entry) => new TextDecoder().decode(entry.data))).toEqual([
      'front',
      'tag',
      'tag-crop',
    ]);
    const prompt = JSON.parse(request.prompt) as {
      images: unknown[];
      photos: { photo: number; role: string; ocrLines: string[]; barcodes: unknown[] }[];
      parsedTagFacts: Record<string, { value: unknown; confidence: number }[]>;
    };
    expect(prompt.images).toEqual([
      { image: 1, photo: 1, role: 'front', kind: 'photo' },
      { image: 2, photo: 2, role: 'tag', kind: 'photo' },
      { image: 3, photo: 2, role: 'tag', kind: 'tag_crop' },
    ]);
    expect(prompt.photos[1]).toMatchObject({
      photo: 2,
      role: 'tag',
      ocrLines: expect.arrayContaining(['RN 12345']) as unknown,
      barcodes: [{ symbology: 'upc_a', payload: '036000291452' }],
    });
    expect(prompt.parsedTagFacts['rn']).toEqual([
      { value: '12345', confidence: expect.any(Number) as unknown },
    ]);
    expect(prompt.parsedTagFacts['gtin']?.[0]?.value).toEqual({
      format: 'upc_a',
      digits: '036000291452',
    });
    expect(prompt).not.toHaveProperty('firstAnalysis');
    expect(prompt).not.toHaveProperty('scanRead');
  });

  it('keeps the system prompt identical for every item, so providers can cache it', () => {
    const other = tagInput({ photos: [photo({ photoId: 'other', role: 'back' })] });
    expect(buildAnalysisRequest(tagInput()).system).toBe(ITEM_ANALYSIS_SYSTEM);
    expect(buildAnalysisRequest(other).system).toBe(ITEM_ANALYSIS_SYSTEM);
    // The vocabulary is spelled out for the model.
    expect(ITEM_ANALYSIS_SYSTEM).toContain('clothing/tops: t_shirts');
    expect(ITEM_ANALYSIS_SYSTEM).toContain('at most 80 characters');
  });

  it("holds Listora's default Depop style, and sends a seller's own style with the item", () => {
    expect(ITEM_ANALYSIS_SYSTEM).toContain(DEFAULT_DEPOP_DESCRIPTION_STYLE);
    expect(ITEM_ANALYSIS_SYSTEM).toContain('fits in\n    929 characters');
    const plain = JSON.parse(buildAnalysisRequest(tagInput()).prompt) as Record<string, unknown>;
    expect(plain).not.toHaveProperty('depopStyle');

    const depopStyle = 'One plain sentence, then the measurements. No emoji.';
    const request = buildAnalysisRequest(tagInput({ depopStyle }));
    // The seller's style travels in the request, so the cached system prompt stays the same.
    expect(request.system).toBe(ITEM_ANALYSIS_SYSTEM);
    const prompt = JSON.parse(request.prompt) as Record<string, unknown>;
    expect(prompt['depopStyle']).toBe(depopStyle);
  });

  it('includes the first analysis when escalating', () => {
    const firstAnalysis = { details: {}, variants: [], needsEscalation: true };
    const prompt = JSON.parse(buildAnalysisRequest(tagInput(), { firstAnalysis }).prompt) as Record<
      string,
      unknown
    >;
    expect(prompt['firstAnalysis']).toEqual(firstAnalysis);
  });

  it("sends the thrift scan's read of a kept item as a hint, with the cached system prompt", () => {
    const scanRead = scanReadHint({
      brand: 'Patagonia',
      item: 'green fleece pullover',
      line: 'Synchilla',
      styleNumber: '',
      era: 'vintage 1990s',
      material: 'fleece',
      category: 'clothing/tops',
      department: 'men',
      sizeLabel: 'M',
      condition: 'good',
      identityConfidence: 0.7,
      flags: { visibleDamage: true, lotOrBundle: false, counterfeitProne: false },
    });
    expect(scanRead).toBeDefined();
    if (scanRead === undefined) return;
    const request = buildAnalysisRequest(tagInput({ scanRead }));
    expect(request.system).toBe(ITEM_ANALYSIS_SYSTEM);
    expect(ITEM_ANALYSIS_SYSTEM).toContain('these photos always win');
    const prompt = JSON.parse(request.prompt) as Record<string, unknown>;
    expect(prompt['scanRead']).toEqual({
      brand: 'Patagonia',
      item: 'green fleece pullover',
      line: 'Synchilla',
      styleNumber: null,
      era: 'vintage 1990s',
      material: 'fleece',
      category: 'clothing/tops',
      department: 'men',
      sizeLabel: 'M',
      condition: 'good',
      identityConfidence: 0.7,
      visibleDamage: true,
    });
    // The scan's price guess never rides along: the analysis prices from its own photos.
    expect(JSON.stringify(prompt['scanRead'])).not.toContain('Cents');
  });
});

describe('scanReadHint', () => {
  it('keeps only the identity fields, and leaves out any it cannot trust', () => {
    expect(
      scanReadHint({
        brand: '  ',
        item: 'tee',
        identityConfidence: 3,
        flags: 'none',
        aiEstimate: { lowCents: 1000, midCents: 2000, highCents: 3000 },
      }),
    ).toEqual({
      brand: null,
      item: 'tee',
      line: null,
      styleNumber: null,
      era: null,
      material: null,
      category: null,
      department: null,
      sizeLabel: null,
      condition: null,
      identityConfidence: null,
      visibleDamage: null,
    });
  });

  it('gives nothing for a read that names nothing', () => {
    expect(scanReadHint(null)).toBeUndefined();
    expect(scanReadHint('read')).toBeUndefined();
    expect(scanReadHint({ brand: '', item: '' })).toBeUndefined();
  });
});

describe('selectAnalysisPhotos', () => {
  it('keeps every photo of a small set, in order', () => {
    const photos = tagInput().photos;
    expect(selectAnalysisPhotos(photos)).toEqual(photos);
  });

  it('caps a large set and keeps the first tag photos wherever they are', () => {
    const photos = Array.from({ length: 12 }, (_, index) =>
      photo({
        photoId: `p${String(index)}`,
        role: index >= 9 ? 'tag' : 'detail',
        image: image(`p${String(index)}`),
      }),
    );
    const selected = selectAnalysisPhotos(photos).map((entry) => entry.photoId);
    expect(selected).toHaveLength(MAX_ANALYSIS_PHOTOS);
    expect(selected).toEqual(['p0', 'p1', 'p2', 'p3', 'p9']);
  });
});
