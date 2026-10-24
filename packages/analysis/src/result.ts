/**
 * Turns a validated model answer into the contract's `AnalysisResult`: every value with its
 * confidence and an honest provenance, the four marketplace variants, the labeled price
 * estimate, and whether to escalate.
 *
 * Provenance is the server's call, not the model's. A value counts as `ocr` or `barcode` only
 * when the phone's reads support it; otherwise it is `ai`, whatever the model said. The
 * deterministic tag facts are evidence too: when the model agrees with one, the value takes
 * the fact's provenance; when it found nothing, a confident fact fills the value in; when it
 * disagrees, the model's value is kept but its confidence is capped so the review screen
 * highlights it.
 */
import type {
  AnalysisResult,
  AnalyzedCondition,
  AnalyzedDetails,
  AnalyzedText,
  AnalyzedTextList,
  KnownAnalysisProvenance,
  VariantSuggestion,
} from '@listora/api-contract';
import {
  normalizeText,
  parseTagText,
  toGtin,
  type FiberComponent,
  type Parsed,
  type TagFacts,
  type TagValueTypes,
  type ValueSource,
} from '@listora/tag-parse';

import type { AiTier } from '@listora/ai';

import type { AnalysisInput } from './input.ts';
import type { EvidenceSource, ItemAnalysisOutput } from './output-schema.ts';
import { categoryPath } from './vocabulary.ts';

/** The label every AI price estimate carries (architecture section 5). */
export const AI_ESTIMATE_LABEL = 'AI estimate - not based on sold listings';

/** A parsed tag fact at least this confident fills in a value the model left out. */
export const PARSED_FACT_MIN_CONFIDENCE = 0.7;
/** The confidence a value keeps at most when it contradicts a confident parsed fact. */
export const CONTRADICTED_CONFIDENCE = 0.5;
/** A brand or product proposed below this confidence asks for the premium identification. */
export const LOW_IDENTITY_CONFIDENCE = 0.6;

/** Fiber facts for these parts (or for no named part) describe the item's main material. */
const MAIN_FIBER_PARTS: ReadonlySet<FiberComponent['part']> = new Set([null, 'shell', 'body']);

/** An analysis result, and whether the job queues the premium identification on its own. */
export interface BuiltAnalysisResult {
  readonly result: AnalysisResult;
  /**
   * True when the result asks for escalation for a reason worth a premium call without the
   * user asking: an unidentified brand alone only suggests "Identify harder".
   */
  readonly autoEscalate: boolean;
}

interface Evidence {
  /** Every OCR line as its words (`normalizeText`, split at anything but letters and digits). */
  readonly ocrWords: readonly (readonly string[])[];
  /** Every barcode payload, trimmed. */
  readonly barcodes: readonly string[];
  readonly facts: TagFacts;
}

type Field<T> = { value: T; confidence: number; source: EvidenceSource } | null;

export function buildAnalysisResult(
  output: ItemAnalysisOutput,
  input: AnalysisInput,
  facts: TagFacts,
  tier: AiTier,
): BuiltAnalysisResult {
  const evidence: Evidence = {
    ocrWords: input.photos.flatMap((photo) => photo.ocrLines.map((line) => words(line.text))),
    barcodes: input.photos.flatMap((photo) => photo.barcodes.map((code) => code.payload.trim())),
    facts,
  };
  const details = analyzedDetails(withCanonicalSize(output), evidence);
  const escalation = tier === 'standard' ? escalationOf(output, details) : undefined;
  const price = output.priceEstimate;
  const result: AnalysisResult = {
    details,
    variants: variants(output),
    ...(price === null
      ? {}
      : {
          priceEstimate: {
            label: AI_ESTIMATE_LABEL,
            low: { amountCents: price.lowCents, currency: 'USD' },
            mid: { amountCents: price.midCents, currency: 'USD' },
            high: { amountCents: price.highCents, currency: 'USD' },
            confidence: price.confidence,
          },
        }),
    needsEscalation: escalation !== undefined,
    ...(escalation === undefined ? {} : { escalationReason: escalation.reason }),
  };
  return { result, autoEscalate: escalation?.automatic ?? false };
}

function analyzedDetails(output: ItemAnalysisOutput, evidence: Evidence): AnalyzedDetails {
  const a = output.attributes;
  const details: AnalyzedDetails = {};
  const set = <K extends keyof AnalyzedDetails>(key: K, value: AnalyzedDetails[K] | undefined) => {
    if (value !== undefined) details[key] = value;
  };

  set('title', {
    value: output.title.value,
    confidence: output.title.confidence,
    provenance: 'ai',
  });
  set('description', {
    value: output.description.value,
    confidence: output.description.confidence,
    provenance: 'ai',
  });
  set('brand', text(a.brand, evidence));
  set('productName', text(a.productName, evidence));
  set(
    'styleNumber',
    withFact(a.styleNumber, evidence.facts.style, evidence, {
      same: (value, fact) => squash(value) === squash(fact),
      fromFact: (fact) => fact,
    }),
  );
  set(
    'rnNumber',
    withFact(a.rnNumber, evidence.facts.rn, evidence, {
      same: (value, fact) => value === fact,
      fromFact: (fact) => fact,
    }),
  );
  set('upc', upc(a.upc, evidence));
  set('department', text(a.department, evidence));
  set('category', category(output));
  const size = withFact(
    a.sizeLabel,
    evidence.facts.size,
    evidence,
    {
      same: (value, fact) => squash(value) === squash(fact.value),
      fromFact: (fact) => fact.value,
    },
    (value, fact) => a.sizeSystem === null || a.sizeSystem.value === fact.system,
  );
  set('sizeLabel', size);
  set('sizeSystem', sizeSystem(output, size, evidence.facts.size));
  set('colors', textList(a.colors));
  set('pattern', text(a.pattern, evidence));
  set('materials', materials(a.materials, evidence));
  set('condition', condition(a.condition));
  set('conditionNotes', text(a.conditionNotes, evidence));
  set('flaws', textList(a.flaws));
  set('keywords', textList(a.keywords));
  return details;
}

/**
 * The model's size in the tag parsers' canonical form ("Extra Large" is `XL`, "W32/L32" is
 * `32x32`), so it compares with the parsed facts and maps to marketplace sizes. A label
 * naming several systems ("US 4 / UK 8 / EU 36") keeps the one in the model's `sizeSystem`,
 * or the first. A label the parsers cannot read stays as the model wrote it.
 */
function withCanonicalSize(output: ItemAnalysisOutput): ItemAnalysisOutput {
  const { sizeLabel, sizeSystem } = output.attributes;
  if (sizeLabel === null) return output;
  const sizes = parseTagText({ lines: [{ text: `SIZE ${sizeLabel.value}` }] }).size.map(
    (parsed) => parsed.value,
  );
  const size = sizes.find((candidate) => candidate.system === sizeSystem?.value) ?? sizes[0];
  if (size === undefined) return output;
  return {
    ...output,
    attributes: {
      ...output.attributes,
      sizeLabel: { ...sizeLabel, value: size.value },
      sizeSystem: {
        value: size.system,
        confidence: sizeSystem?.confidence ?? sizeLabel.confidence,
        source: sizeLabel.source,
      },
    },
  };
}

/** A text value with the provenance its evidence supports. */
function text(field: Field<string>, evidence: Evidence): AnalyzedText | undefined {
  if (field === null) return undefined;
  return {
    value: field.value,
    confidence: field.confidence,
    provenance: verifiedProvenance(field.source, field.value, evidence),
  };
}

function textList(field: { values: string[]; confidence: number } | null) {
  if (field === null) return undefined;
  // Judged from the photos (colors) or written by the model (keywords, flaws): always `ai`.
  return {
    values: [...new Set(field.values)],
    confidence: field.confidence,
    provenance: 'ai',
  } satisfies AnalyzedTextList;
}

function condition(field: Field<AnalyzedCondition['value']>): AnalyzedCondition | undefined {
  if (field === null) return undefined;
  return { value: field.value, confidence: field.confidence, provenance: 'ai' };
}

/**
 * A value read off a tag or barcode is `barcode` when a scanned barcode is the value, `ocr`
 * when a phone OCR line contains it as whole words, and otherwise `ai` (the model read it
 * itself). A value judged from the photos is always `ai`.
 */
function verifiedProvenance(
  source: EvidenceSource,
  value: string,
  evidence: Evidence,
): KnownAnalysisProvenance {
  switch (source) {
    case 'tag_text':
    case 'barcode': {
      if (evidence.barcodes.includes(value)) return 'barcode';
      return evidence.ocrWords.some((line) => spells(line, value)) ? 'ocr' : 'ai';
    }
    case 'photo':
      return 'ai';
  }
}

function factProvenance(source: ValueSource): KnownAnalysisProvenance {
  return source.kind;
}

interface FactRules<V, F> {
  readonly same: (value: V, fact: F) => boolean;
  readonly fromFact: (fact: F) => string;
}

/**
 * Combines the model's value with the most confident parsed fact for the same detail.
 * `compatible` can veto agreement (a size that matches in value but not in system).
 */
function withFact<F>(
  field: Field<string>,
  parsed: readonly Parsed<F>[],
  evidence: Evidence,
  rules: FactRules<string, F>,
  compatible: (value: string, fact: F) => boolean = () => true,
): AnalyzedText | undefined {
  const fact = parsed[0];
  const confident = fact !== undefined && fact.confidence >= PARSED_FACT_MIN_CONFIDENCE;
  if (field === null) {
    if (!confident) return undefined;
    return {
      value: rules.fromFact(fact.value),
      confidence: round(fact.confidence),
      provenance: factProvenance(fact.source),
    };
  }
  const agreeing = parsed.find(
    (candidate) =>
      rules.same(field.value, candidate.value) && compatible(field.value, candidate.value),
  );
  if (agreeing !== undefined) {
    return {
      value: field.value,
      confidence: round(Math.max(field.confidence, agreeing.confidence)),
      provenance: factProvenance(agreeing.source),
    };
  }
  const analyzed: AnalyzedText = {
    value: field.value,
    confidence: field.confidence,
    provenance: verifiedProvenance(field.source, field.value, evidence),
  };
  return confident
    ? { ...analyzed, confidence: Math.min(analyzed.confidence, CONTRADICTED_CONFIDENCE) }
    : analyzed;
}

/** The UPC in its canonical form: UPC-A keeps 12 digits (an EAN-13 starting with 0 too). */
function upc(field: Field<string>, evidence: Evidence): AnalyzedText | undefined {
  const canonical = field === null ? null : { ...field, value: canonicalGtin(field.value) };
  const result = withFact(canonical, evidence.facts.gtin, evidence, {
    same: (value, fact) => value === fact.digits,
    fromFact: (fact) => fact.digits,
  });
  // A barcode reading the EAN-13 form of a UPC-A still counts as the barcode.
  if (result?.provenance === 'ai' && field?.source === 'barcode') {
    const read = evidence.barcodes.some(
      (payload) => toGtin(payload)?.digits === result.value || payload === field.value,
    );
    if (read) return { ...result, provenance: 'barcode' };
  }
  return result;
}

function canonicalGtin(digits: string): string {
  return toGtin(digits)?.digits ?? digits;
}

/**
 * The size system follows the size: from the fact that supplied or confirmed the size, else
 * the model's.
 */
function sizeSystem(
  output: ItemAnalysisOutput,
  size: AnalyzedText | undefined,
  parsed: readonly Parsed<TagValueTypes['size']>[],
): AnalyzedText | undefined {
  if (size === undefined) return undefined;
  const fact = parsed.find((candidate) => squash(candidate.value.value) === squash(size.value));
  if (size.provenance !== 'ai' && fact !== undefined) {
    return { value: fact.value.system, confidence: size.confidence, provenance: size.provenance };
  }
  const system = output.attributes.sizeSystem;
  if (system === null) return undefined;
  return { value: system.value, confidence: system.confidence, provenance: 'ai' };
}

function category(output: ItemAnalysisOutput): AnalyzedText | undefined {
  const { category, subcategory } = output.attributes;
  if (category === null) return undefined;
  if (subcategory === null) {
    return { value: category.value, confidence: category.confidence, provenance: 'ai' };
  }
  return {
    value: categoryPath(category.value, subcategory.value),
    confidence: Math.min(category.confidence, subcategory.confidence),
    provenance: 'ai',
  };
}

/**
 * Materials agree with the fiber facts when every one is on the tag and none of the main
 * material's fibers (no named part, the shell, or the body) is missing: a lining or trim
 * fiber may be left out. Filled in from the facts, the main material comes first.
 */
function materials(
  field: { values: string[]; confidence: number; source: EvidenceSource } | null,
  evidence: Evidence,
): AnalyzedTextList | undefined {
  const fibers = evidence.facts.fiber.filter(
    (fact) => fact.confidence >= PARSED_FACT_MIN_CONFIDENCE,
  );
  const isMain = (fact: (typeof fibers)[number]) => MAIN_FIBER_PARTS.has(fact.value.part);
  const fromFacts = [
    ...new Set(
      [...fibers]
        .sort((a, b) => Number(isMain(b)) - Number(isMain(a)) || b.value.percent - a.value.percent)
        .map((fact) => fact.value.material),
    ),
  ];
  const main = new Set(fibers.filter(isMain).map((fact) => fact.value.material));
  const confidence = Math.min(...fibers.map((fact) => fact.confidence));
  if (field === null) {
    if (fromFacts.length === 0) return undefined;
    return { values: fromFacts, confidence: round(confidence), provenance: 'ocr' };
  }
  const values = [...new Set(field.values)];
  const onTag = new Set<string>(fromFacts);
  const agrees =
    values.length > 0 &&
    values.every((value) => onTag.has(value)) &&
    [...main].every((material) => values.includes(material));
  if (fromFacts.length > 0 && agrees) {
    return {
      values,
      confidence: round(Math.max(field.confidence, confidence)),
      provenance: 'ocr',
    };
  }
  return {
    values,
    confidence:
      fromFacts.length > 0 ? Math.min(field.confidence, CONTRADICTED_CONFIDENCE) : field.confidence,
    provenance: 'ai',
  };
}

function variants(output: ItemAnalysisOutput): VariantSuggestion[] {
  const { ebay, depop, poshmark, mercari } = output.variants;
  return [
    { marketplace: 'ebay', title: ebay.title, description: ebay.description },
    {
      marketplace: 'depop',
      title: depop.title,
      description: depop.description,
      hashtags: [...new Set(depop.hashtags)],
    },
    { marketplace: 'poshmark', title: poshmark.title, description: poshmark.description },
    { marketplace: 'mercari', title: mercari.title, description: mercari.description },
  ];
}

/**
 * Why a standard analysis should be escalated to the premium identification, or undefined.
 * The model's own judgment counts, and so do rules it cannot talk its way out of: a brand or
 * product proposed with low confidence, and items that look vintage or designer, where a
 * closer look is worth the most. Those escalate on their own. A brand the model did not
 * identify at all only suggests it: many items are unbranded, and a premium call costs the
 * user's quota, so the user decides. A missing product name is no reason at all: most
 * secondhand items show none.
 */
function escalationOf(
  output: ItemAnalysisOutput,
  details: AnalyzedDetails,
): { reason: string; automatic: boolean } | undefined {
  const reasons: { text: string; automatic: boolean }[] = [];
  // A rule's reason the model already gave, in any case, is not repeated.
  const add = (text: string, automatic = true) => {
    const same = reasons.find(
      (reason) => reason.text.trim().toLowerCase() === text.trim().toLowerCase(),
    );
    if (same === undefined) reasons.push({ text, automatic });
    else same.automatic ||= automatic;
  };
  if (output.needsEscalation && output.escalationReason !== null) add(output.escalationReason);
  const { brand, productName } = details;
  if (brand === undefined) add('The brand was not identified.', false);
  else if (brand.confidence < LOW_IDENTITY_CONFIDENCE) add('The brand is uncertain.');
  if (productName !== undefined && productName.confidence < LOW_IDENTITY_CONFIDENCE) {
    add('The product is uncertain.');
  }
  if (output.looksDesigner) add('It looks like a designer item.');
  if (output.looksVintage) add('It looks vintage.');
  if (reasons.length === 0) return undefined;
  return {
    reason: reasons
      .map((reason) => reason.text)
      .join(' ')
      .slice(0, 500),
    automatic: reasons.some((reason) => reason.automatic),
  };
}

/** Uppercase letters and digits only, so "RN 12345" and "rn12345" compare. */
function squash(value: string): string {
  return normalizeText(value).replace(/[^A-Z0-9]/g, '');
}

/** A text's words: `normalizeText`, split at anything but letters and digits. */
function words(text: string): string[] {
  return normalizeText(text)
    .split(/[^A-Z0-9]+/)
    .filter((word) => word !== '');
}

/**
 * Whether consecutive words of a line spell the value, ignoring spaces and punctuation:
 * "SIZE M" spells "M" and "LEVIS" spells "Levi's", but "MADE IN USA" does not spell "M" and
 * "SINGAPORE" does not spell "Gap".
 */
function spells(line: readonly string[], value: string): boolean {
  const needle = squash(value);
  if (needle === '') return false;
  return line.some((_, start) => {
    let joined = '';
    for (const word of line.slice(start)) {
      joined += word;
      if (joined === needle) return true;
      if (joined.length >= needle.length) return false;
    }
    return false;
  });
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
