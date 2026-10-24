import { describe, expect, it } from 'vitest';

import { MAX_ANALYSIS_PHOTOS, selectAnalysisPhotos } from './input.ts';
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
  });

  it('keeps the system prompt identical for every item, so providers can cache it', () => {
    const other = tagInput({ photos: [photo({ photoId: 'other', role: 'back' })] });
    expect(buildAnalysisRequest(tagInput()).system).toBe(ITEM_ANALYSIS_SYSTEM);
    expect(buildAnalysisRequest(other).system).toBe(ITEM_ANALYSIS_SYSTEM);
    // The vocabulary is spelled out for the model.
    expect(ITEM_ANALYSIS_SYSTEM).toContain('clothing/tops: t_shirts');
    expect(ITEM_ANALYSIS_SYSTEM).toContain('at most 80 characters');
  });

  it('includes the first analysis when escalating', () => {
    const firstAnalysis = { details: {}, variants: [], needsEscalation: true };
    const prompt = JSON.parse(buildAnalysisRequest(tagInput(), { firstAnalysis }).prompt) as Record<
      string,
      unknown
    >;
    expect(prompt['firstAnalysis']).toEqual(firstAnalysis);
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
    expect(selected).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p9', 'p10']);
  });
});
