/**
 * Prompt assembly. The system prompt is stable (providers cache it with the schema), so it
 * holds every rule and vocabulary and nothing about one item; the per-request prompt carries
 * the item's evidence: which image is which photo, the on-device reads, the deterministic tag
 * facts, the seller's own description style when they saved one, and, for an escalation, the
 * first analysis.
 */
import type { AiImage } from '@listora/ai';
import type { AnalysisResult } from '@listora/api-contract';
import { parseTagText, type TagFacts, type TagField } from '@listora/tag-parse';

import { MAX_TAG_CROPS, selectAnalysisPhotos, type AnalysisInput } from './input.ts';
import { DEFAULT_DEPOP_DESCRIPTION_STYLE } from './description-style.ts';
import { DEPOP_DRAFT_LENGTH, MARKETPLACE_COPY_LIMITS as LIMITS } from './marketplace-copy.ts';
import { CATEGORY_TREE, COLORS, MATERIALS, PATTERNS } from './vocabulary.ts';

function list(values: readonly string[]): string {
  return values.join(', ');
}

const categoryLines = Object.entries(CATEGORY_TREE)
  .map(([category, subcategories]) => `  - ${category}: ${list(subcategories)}`)
  .join('\n');

/** Stable instructions for every analysis call (both tiers). */
export const ITEM_ANALYSIS_SYSTEM = `You identify secondhand items for a reseller from their photos and write their listings.
Answer with one JSON object that follows the schema exactly.

Evidence
- The images are the item's photos in display order, then sharper crops of tag photos. The
  request says which image is which photo and role (front, back, tag, flaw, detail).
- The request also has the text the phone read on each photo (OCR lines), scanned barcodes,
  and facts a deterministic parser found in them. These are hints: OCR misreads characters
  and misses text, so check every hint against the images. Never report a fact that neither
  the images nor the hints show.
- "confidence" holds how sure you are of each value, 0 to 1; use less than 0.6 whenever a
  person should check the value, and 0 for a value you left empty.
- Use an empty value ("" or an empty list) for anything you cannot tell, and an all-zero
  priceEstimate when you cannot price the item. A missing value is far better than a guess.

Attributes
- brand: the maker as printed (for example "Levi's"). productName: the product or style name
  when the tag or item shows it. styleNumber: a style or model number as printed.
- rnNumber: digits of an "RN" number on the tag. upc: the UPC/EAN digits of a barcode or the
  printed digits under it, with a valid check digit.
- department: women, men, kids, or unisex.
- category and subcategory, from this tree (category: subcategories):
${categoryLines}
- sizeLabel: the one size of the item in short form: XS to XXXL for letter sizes ("XL", not
  "Extra Large"), the number for numeric sizes, 32x30 for waist and inseam, OS for one
  size. When the tag gives several systems, give the US size. sizeSystem: letter, numeric,
  waist_inseam, us, uk, or eu (labeled on the tag), or one_size.
- colors (main colors first): ${list(COLORS)}.
- pattern: ${list(PATTERNS)}.
- materials (main material first; fibers as on the tag): ${list(MATERIALS)}.
- condition: new_with_tags (store tags attached), new_without_tags, new_with_defects,
  pre_owned_excellent (no visible wear), pre_owned_good (light wear), pre_owned_fair
  (visible wear or flaws). Describe every visible flaw in flaws, and summarize wear in
  conditionNotes. Never hide or downplay a flaw.
- keywords: search terms a buyer would type (style, era, fit, occasion), lowercase.

Listing copy
- Be accurate: describe only what the photos and tags show. Name every flaw. No claims of
  authenticity, rarity, or value you cannot see, and no contact details.
- title and description: Listora's own neutral title and description of the item.
- variants, one per marketplace:
  - ebay: a keyword title of at most ${String(LIMITS.ebay.title)} characters (brand, item type, key
    attributes, size; no filler words or punctuation runs) and a factual description.
  - depop: style-forward, casual copy in the Depop description style below that fits in
    ${String(DEPOP_DRAFT_LENGTH)} characters together with up to ${String(LIMITS.depop.hashtags)} hashtags (lowercase, without the #,
    in hashtags and never in the description); no email addresses. The title is a short
    headline.
  - poshmark: fashion copy (brand, style, fit, how to wear it); title at most
    ${String(LIMITS.poshmark.title)} characters, description at most ${String(LIMITS.poshmark.description)}.
  - mercari: plain, factual copy; title at most ${String(LIMITS.mercari.title)} characters,
    description at most ${String(LIMITS.mercari.description)}.

Depop description style
- The request's "depopStyle", when it has one, is the seller's own style: follow it instead of
  the default below. Either style shapes only the wording and layout of the depop variant; the
  rules above still hold (accuracy, every flaw named, the limits, hashtags in their own field).
- The default style:
${DEFAULT_DEPOP_DESCRIPTION_STYLE}

Price
- priceEstimate is your guess of a fair US resale price in cents (low, mid, high), from the
  brand, item, and condition. It is shown as "AI estimate - not based on sold listings", so
  never say it is based on sales or comparable listings. Use all zeros when you cannot tell.

Escalation
- looksVintage: the item looks 20 or more years old. looksDesigner: a luxury or designer
  brand. needsEscalation: true when a closer look by a stronger model would likely change the
  brand, product, or price; say why in escalationReason.
- When the request includes a "firstAnalysis", it is a faster model's answer for the same
  photos. Check it, keep what is right, and correct what is wrong.

Scan read
- When the request includes a "scanRead", the seller scanned the item at the store first: it
  is a quick model's read of one shot of the item in hand, before these photos were taken.
  Use it as a hint only. Keep what these photos confirm, correct what they contradict, and
  never copy a detail from it that these photos do not show; these photos always win.`;

/** One image of the request and what it shows. */
interface ImageEntry {
  readonly image: number;
  readonly photo: number;
  readonly role: string;
  readonly kind: 'photo' | 'tag_crop';
}

export interface AnalysisRequest {
  readonly system: string;
  readonly prompt: string;
  readonly images: readonly AiImage[];
  /** The deterministic facts the prompt carries; the result is checked against them. */
  readonly tagFacts: TagFacts;
}

/**
 * The parsed tag facts of every photo's reads, with the photo each value came from. Lines
 * and barcodes of all photos go to the parsers, since a phone reads text wherever it is.
 */
export function tagFactsOf(input: AnalysisInput): TagFacts {
  return parseTagText({
    lines: input.photos.flatMap((photo) =>
      photo.ocrLines.map((line) => ({
        text: line.text,
        confidence: line.confidence,
        photoId: photo.photoId,
      })),
    ),
    barcodes: input.photos.flatMap((photo) =>
      photo.barcodes.map((barcode) => ({
        payload: barcode.payload,
        symbology: barcode.symbology,
        photoId: photo.photoId,
      })),
    ),
  });
}

/** The images, prompt, and facts of one call. `firstAnalysis` makes it an escalation. */
export function buildAnalysisRequest(
  input: AnalysisInput,
  options: { firstAnalysis?: AnalysisResult } = {},
): AnalysisRequest {
  const photos = selectAnalysisPhotos(input.photos);
  const entries: ImageEntry[] = [];
  const images: AiImage[] = [];
  photos.forEach((photo, index) => {
    images.push(photo.image);
    entries.push({ image: images.length, photo: index + 1, role: photo.role, kind: 'photo' });
  });
  let crops = 0;
  photos.forEach((photo, index) => {
    if (photo.tagCrop === undefined || crops >= MAX_TAG_CROPS) return;
    crops += 1;
    images.push(photo.tagCrop);
    entries.push({ image: images.length, photo: index + 1, role: photo.role, kind: 'tag_crop' });
  });

  const tagFacts = tagFactsOf(input);
  const prompt = {
    images: entries,
    photos: photos.map((photo, index) => ({
      photo: index + 1,
      role: photo.role,
      ocrLines: photo.ocrLines.map((line) => line.text),
      barcodes: photo.barcodes.map((barcode) => ({
        symbology: barcode.symbology,
        payload: barcode.payload,
      })),
    })),
    parsedTagFacts: parsedFactsForPrompt(tagFacts),
    ...(input.depopStyle === undefined ? {} : { depopStyle: input.depopStyle }),
    ...(input.scanRead === undefined ? {} : { scanRead: input.scanRead }),
    ...(options.firstAnalysis === undefined ? {} : { firstAnalysis: options.firstAnalysis }),
  };
  return {
    system: ITEM_ANALYSIS_SYSTEM,
    prompt: JSON.stringify(prompt),
    images,
    tagFacts,
  };
}

/** Each field's values with their confidence, highest first, without the source details. */
function parsedFactsForPrompt(facts: TagFacts): Record<TagField, unknown[]> {
  const pick = (field: TagField) =>
    facts[field].map((parsed) => ({
      value: parsed.value,
      confidence: Math.round(parsed.confidence * 100) / 100,
    }));
  return {
    rn: pick('rn'),
    ca: pick('ca'),
    gtin: pick('gtin'),
    size: pick('size'),
    fiber: pick('fiber'),
    origin: pick('origin'),
    style: pick('style'),
  };
}
