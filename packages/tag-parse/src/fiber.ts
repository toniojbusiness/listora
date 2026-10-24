import {
  FIBER_PART_SPELLINGS,
  MATERIAL_SPELLINGS,
  type FiberPart,
  type Material,
  type Spelling,
} from './materials.ts';
import {
  editDistance,
  lineConfidence,
  ocrSource,
  repairLetters,
  type PreparedLine,
} from './normalize.ts';
import type { FiberComponent, Parsed } from './types.ts';

/*
 * Fiber content: "60% COTTON 40% POLYESTER", "COTTON 60% / POLYESTER 40%",
 * "SHELL: 100% NYLON LINING: 100% POLYESTER", and multilingual repeats such as
 * "100% COTTON / COTON / ALGODON". A percentage pairs with the material that follows it, or,
 * when a segment starts with a material, with the material that precedes it. Translations of a
 * material already paired are ignored, and duplicates across language lines collapse.
 */

type FiberEvent =
  | { readonly kind: 'part'; readonly part: FiberPart }
  | { readonly kind: 'percent'; readonly value: number; readonly repaired: boolean }
  | { readonly kind: 'material'; readonly material: Material; readonly approximate: boolean };

interface Candidate {
  readonly component: FiberComponent;
  readonly uncertain: boolean;
  readonly line: PreparedLine;
}

const CONFIDENCE = { complete: 0.95, incomplete: 0.6, uncertainPenalty: 0.1 } as const;

const TOKEN = /([0-9OQDIL|]{1,3}(?:[.,][0-9])?)\s*%|([A-Z0-9]+(?:-[A-Z0-9]+)*)|(:)/g;
const EXCLUSIONS =
  /\b(?:EXCLUSIVE OF|EXCLUDING|EXCEPT|SANS|EXCEPTO)\s+(?:THE\s+)?[A-Z]+(?:\s+(?:AND|&)\s+[A-Z]+)?/g;
const FUZZY_MIN_LENGTH = 5;

export function parseFibers(lines: readonly PreparedLine[]): Parsed<FiberComponent>[] {
  const candidates: Candidate[] = [];
  let part: FiberPart | null = null;
  for (const line of lines) {
    const events = fiberEvents(line.text);
    if (events.length === 0) {
      part = null;
      continue;
    }
    part = pairEvents(events, part, (component, uncertain) => {
      candidates.push({ component, uncertain, line });
    });
  }
  return scoreCandidates(dedupe(candidates));
}

/**
 * Walks one line's events, emitting each percentage-material pair. Returns the part in effect
 * at the end of the line, so a composition that continues on the next line keeps its part.
 *
 * Word order is decided per segment (the events between part labels) by how it ends: a segment
 * that ends with a material is percent-first ("60% COTTON 40% POLYESTER"), one that ends with a
 * percentage is material-first ("COTTON 60% POLYESTER 40%"). Deciding by the end keeps a dropped
 * `%` ("97 VISCOSE / 3% METALLIC") from pairing a percentage with the wrong material.
 */
function pairEvents(
  events: readonly FiberEvent[],
  startPart: FiberPart | null,
  emit: (component: FiberComponent, uncertain: boolean) => void,
): FiberPart | null {
  let part = startPart;
  let segment: FiberEvent[] = [];
  const flush = (): void => {
    pairSegment(segment, part, emit);
    segment = [];
  };
  for (const event of events) {
    if (event.kind === 'part') {
      flush();
      part = event.part;
    } else {
      segment.push(event);
    }
  }
  flush();
  return part;
}

function pairSegment(
  events: readonly FiberEvent[],
  part: FiberPart | null,
  emit: (component: FiberComponent, uncertain: boolean) => void,
): void {
  const percentFirst = events.at(-1)?.kind === 'material';
  let pendingPercent: Extract<FiberEvent, { kind: 'percent' }> | null = null;
  let pendingMaterial: Extract<FiberEvent, { kind: 'material' }> | null = null;
  for (const event of events) {
    if (event.kind === 'percent') {
      if (percentFirst) {
        pendingPercent = event;
      } else if (pendingMaterial !== null) {
        emit(
          { part, material: pendingMaterial.material, percent: event.value },
          event.repaired || pendingMaterial.approximate,
        );
        pendingMaterial = null;
      }
    } else if (event.kind === 'material') {
      if (!percentFirst) {
        pendingMaterial ??= event;
      } else if (pendingPercent !== null) {
        emit(
          { part, material: event.material, percent: pendingPercent.value },
          pendingPercent.repaired || event.approximate,
        );
        pendingPercent = null;
      }
    }
  }
}

/** Tokenizes a normalized line into part labels, percentages, and materials. */
function fiberEvents(text: string): FiberEvent[] {
  // "COTTON100%" -> "COTTON 100%"; a single letter ("1O0%") is an OCR misread, not a word.
  const prepared = text.replace(EXCLUSIONS, ' ').replace(/([A-Z]{2})([0-9]{1,3}\s*%)/g, '$1 $2');
  const tokens = Array.from(prepared.matchAll(TOKEN), (match) => {
    if (match[1] !== undefined) return { kind: 'percent' as const, raw: match[1] };
    if (match[2] !== undefined) return { kind: 'word' as const, raw: repairLetters(match[2]) };
    return { kind: 'colon' as const };
  });

  const events: FiberEvent[] = [];
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i];
    if (token === undefined) break;
    if (token.kind === 'colon') {
      i += 1;
      continue;
    }
    if (token.kind === 'percent') {
      const percent = readPercent(token.raw);
      if (percent !== null) events.push({ kind: 'percent', ...percent });
      i += 1;
      continue;
    }
    const wordsAhead = tokens.slice(i).map((t) => (t.kind === 'word' ? t.raw.text : null));
    const material = matchSpelling(MATERIAL_SPELLINGS, wordsAhead);
    if (material !== null) {
      events.push({
        kind: 'material',
        material: material.canonical,
        approximate: material.approximate || token.raw.repaired,
      });
      i += material.length;
      continue;
    }
    const part = matchPartLabel(tokens.slice(i), wordsAhead);
    if (part !== null) {
      events.push({ kind: 'part', part: part.part });
      i += part.length;
      continue;
    }
    i += 1;
  }
  return events;
}

type Token =
  | { readonly kind: 'percent'; readonly raw: string }
  | { readonly kind: 'word'; readonly raw: { readonly text: string; readonly repaired: boolean } }
  | { readonly kind: 'colon' };

/**
 * A part word counts as a label only when it is followed by a colon or a percentage (after
 * any translated part words, as in "SHELL/EXTERIOR: 100% NYLON"), or when it ends the line.
 */
function matchPartLabel(
  tokens: readonly Token[],
  wordsAhead: readonly (string | null)[],
): { part: FiberPart; length: number } | null {
  const first = matchSpelling(FIBER_PART_SPELLINGS, wordsAhead, { fuzzy: false });
  if (first === null) return null;
  let length = first.length;
  for (;;) {
    const more = matchSpelling(FIBER_PART_SPELLINGS, wordsAhead.slice(length), { fuzzy: false });
    if (more === null) break;
    length += more.length;
  }
  const next = tokens[length];
  if (next === undefined || next.kind === 'colon' || next.kind === 'percent') {
    return { part: first.canonical, length };
  }
  return null;
}

function matchSpelling<T extends string>(
  spellings: readonly Spelling<T>[],
  wordsAhead: readonly (string | null)[],
  options: { fuzzy: boolean } = { fuzzy: true },
): { canonical: T; length: number; approximate: boolean } | null {
  for (const spelling of spellings) {
    const matches = spelling.words.every((word, offset) => wordsAhead[offset] === word);
    if (matches)
      return { canonical: spelling.canonical, length: spelling.words.length, approximate: false };
  }
  const word = wordsAhead[0];
  if (!options.fuzzy || word === null || word === undefined || word.length < FUZZY_MIN_LENGTH) {
    return null;
  }
  let best: { canonical: T; distance: number } | null = null;
  let tie = false;
  for (const spelling of spellings) {
    const [only] = spelling.words;
    if (spelling.words.length !== 1 || only === undefined || only.length < FUZZY_MIN_LENGTH) {
      continue;
    }
    const distance = editDistance(word, only, 1);
    if (distance > 1) continue;
    if (best === null || distance < best.distance) {
      best = { canonical: spelling.canonical, distance };
      tie = false;
    } else if (distance === best.distance && best.canonical !== spelling.canonical) {
      tie = true;
    }
  }
  if (best === null || tie) return null;
  return { canonical: best.canonical, length: 1, approximate: true };
}

const PERCENT_CONFUSIONS: Readonly<Record<string, string>> = {
  O: '0',
  Q: '0',
  D: '0',
  I: '1',
  L: '1',
  '|': '1',
};

function readPercent(raw: string): { value: number; repaired: boolean } | null {
  let digits = '';
  let real = 0;
  for (const char of raw) {
    if (char >= '0' && char <= '9') real += 1;
    digits += PERCENT_CONFUSIONS[char] ?? char;
  }
  if (real === 0) return null;
  const value = Number(digits.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0 || value > 100) return null;
  return { value, repaired: real !== raw.replace(/[.,]/g, '').length };
}

function componentKey(component: FiberComponent): string {
  return `${component.part ?? ''}:${component.material}:${String(component.percent)}`;
}

/** Collapses repeats (language lines, re-scans) to the first, most certain occurrence. */
function dedupe(candidates: readonly Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = componentKey(candidate.component);
    const existing = byKey.get(key);
    if (existing === undefined || (existing.uncertain && !candidate.uncertain)) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()];
}

/** A part whose percentages sum to 100 is complete and earns high confidence. */
function scoreCandidates(candidates: readonly Candidate[]): Parsed<FiberComponent>[] {
  const totals = new Map<FiberPart | null, number>();
  for (const { component } of candidates) {
    totals.set(component.part, (totals.get(component.part) ?? 0) + component.percent);
  }
  return candidates.map(({ component, uncertain, line }) => {
    const total = totals.get(component.part) ?? 0;
    const base = Math.abs(total - 100) < 0.01 ? CONFIDENCE.complete : CONFIDENCE.incomplete;
    const rule = uncertain ? base - CONFIDENCE.uncertainPenalty : base;
    return {
      value: component,
      confidence: lineConfidence(rule, [line]),
      source: ocrSource([line]),
    };
  });
}
