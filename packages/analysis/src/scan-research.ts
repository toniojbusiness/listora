/**
 * The thrift scan's web research (docs/features/thrift-scan.md, "Web info"): after the scan's
 * read, what the web says about the identified brand and item, the way a seller would ask a
 * chatbot that searches: its original retail price, from the brand's or a retailer's site or
 * another reputable source, and how such items resell. Every number keeps the page it came
 * from, and only pages the search really returned count, so nothing is shown without its
 * source. It is web info, never sold prices.
 */
import { AiCallError, type AiClient, type OutputSchema, type WebSource } from '@listora/ai';
import { z } from 'zod';

/** `ai_usage_event.purpose` of every research call. */
export const SCAN_RESEARCH_PURPOSE = 'thrift_scan_research';

/** The output schema's name; the fake provider's fixtures key their answer by it. */
export const SCAN_RESEARCH_OUTPUT_NAME = 'thrift_scan_research';

/** Shown with everything the research found. */
export const WEB_INFO_LABEL = 'Web info - not sold listings';

/** Searches one research may make; each costs $0.01 (`webSearchMicros`). */
export const MAX_RESEARCH_SEARCHES = 2;

/** Provider calls one research makes at most: an answer that breaks the schema is sent once more. */
export const MAX_RESEARCH_ATTEMPTS = 2;

const cents = z.int().min(0).max(100_000_000);
const url = z.string().trim().max(500);

/**
 * What the card shows at most: a model name, the models and pages per number, and the summary.
 * The answer's schema allows more (`ANSWER_SLACK`) and `verifiedResearch` cuts it to these,
 * because a research that breaks a length is sent again with its searches, so a model name a
 * few characters long would cost a second lookup and then fail.
 */
const MAX_MODEL_LENGTH = 60;
const MAX_MODELS = 6;
const MAX_SOURCES = 4;
const MAX_SUMMARY_LENGTH = 240;
const ANSWER_SLACK = 4;

const researchAnswerSchema = z
  .object({
    retail: z
      .object({
        lowCents: cents.describe(
          'The original retail price in US cents, low end across the models considered; 0 when not found',
        ),
        highCents: cents.describe('The high end; the same as lowCents for one exact model'),
        sourceUrls: z
          .array(url)
          .max(MAX_SOURCES * ANSWER_SLACK)
          .describe(`The exact URLs of the pages that state them, at most ${String(MAX_SOURCES)}`),
        models: z
          .array(
            z
              .string()
              .trim()
              .max(MAX_MODEL_LENGTH * ANSWER_SLACK),
          )
          .max(MAX_MODELS * ANSWER_SLACK)
          .describe(
            `The models the price is for: the exact one, or each likely one when the model is not known; at most ${String(MAX_MODELS)}, each a short name under ${String(MAX_MODEL_LENGTH)} characters`,
          ),
      })
      .strict(),
    resale: z
      .object({
        lowCents: cents.describe(
          'What such items typically resell for, low end, US cents; 0 when not found',
        ),
        highCents: cents,
        sourceUrls: z
          .array(url)
          .max(MAX_SOURCES * ANSWER_SLACK)
          .describe(`The exact URLs of the pages it comes from, at most ${String(MAX_SOURCES)}`),
      })
      .strict(),
    reputation: z
      .enum(['strong', 'average', 'weak', 'unknown'])
      .describe('How well the brand resells, by what the pages say'),
    summary: z
      .string()
      .trim()
      .max(MAX_SUMMARY_LENGTH * ANSWER_SLACK)
      .describe(
        `One sentence of what the pages said, naming them, under ${String(MAX_SUMMARY_LENGTH)} characters; "" when nothing was found`,
      ),
  })
  .strict()
  .superRefine((answer, ctx) => {
    const { lowCents, highCents } = answer.resale;
    if (lowCents > highCents) {
      ctx.addIssue({
        code: 'custom',
        path: ['resale'],
        message: 'lowCents must not exceed highCents',
      });
    }
  });
export type ScanResearchAnswer = z.infer<typeof researchAnswerSchema>;

/**
 * The schema travels in the prompt (`enforcement: 'prompt'`): the answer comes after the
 * searches, as text, which the provider parses and validates like any other.
 */
export const SCAN_RESEARCH_OUTPUT: OutputSchema<ScanResearchAnswer> = {
  name: SCAN_RESEARCH_OUTPUT_NAME,
  schema: researchAnswerSchema,
  enforcement: 'prompt',
};

/** Stable instructions of every research call: no per-request values, so they cache. */
export const SCAN_RESEARCH_SYSTEM = `You help a reseller at a thrift store. The request names an item they are holding (brand, item, category, and when known its exact model or line, style number, era, material, and style). A brand makes many different items: research this one, not the brand in general, except for how well the brand resells. Search the web, at most ${String(MAX_RESEARCH_SEARCHES)} times, for:
1. Its original retail price: from the brand's own site, a retailer's site, or another reputable source (a press or review page). The price new, in US dollars; a resale or used price does not count. One brand makes many models in every category (a Levi's 501 is not a 505 or a 550, and vintage is not current): when the request names the exact model (line or styleNumber), find that model's price; when it does not, give the range across the likely models and list each model you considered.
2. How such items resell: what the brand's or item's used listings typically ask on the resale marketplaces themselves (Depop, Poshmark, Mercari, eBay, Grailed, ThredUp, The RealReal, Vestiaire Collective), and how well the brand resells. Price-estimator or "resale value calculator" sites are not sources: cite only the marketplaces' own pages.

Rules:
- Use only what the search results say. Never guess a price or a URL. A URL must be one of the pages your searches returned, copied exactly.
- Use 0 and "" for anything you did not find; [] when no page supports a resale range.
- These are web info, not sales: never call a price "sold" or a "comp". Say "listed", "asks", or "resells for".
- retail.models: the exact model, or every likely model the range covers.
- summary: one plain sentence naming the sites, for example "Patagonia's site lists the Synchilla at $139; used ones ask $40-$70 on Poshmark and eBay."

Answer last, after your searches, with the JSON object only.`;

export interface ScanResearchInput {
  readonly accountId: string;
  readonly userId: string | null;
  /** The research key's SHA-256, as the fake provider's fixtures key their answers. */
  readonly keyHash: string;
  readonly brand: string;
  readonly item: string;
  readonly category?: string | undefined;
  /** The line or model, the material, and the style: what tells this item from the brand's others. */
  readonly line?: string | undefined;
  readonly styleNumber?: string | undefined;
  readonly era?: string | undefined;
  readonly material?: string | undefined;
  readonly style?: string | undefined;
  readonly signal?: AbortSignal;
}

/** A page the research rests on, by its address and the site's name. */
export interface ResearchSource {
  readonly url: string;
  /** The site, "patagonia.com". */
  readonly site: string;
}

/** What the research found, every number with the pages it came from. */
export interface ScanResearch {
  /** The retail price: one model's (low equal to high), or a range across the likely models. */
  readonly retail: {
    readonly lowCents: number;
    readonly highCents: number;
    readonly sources: readonly ResearchSource[];
    readonly models: readonly string[];
  } | null;
  readonly resale: {
    readonly lowCents: number;
    readonly highCents: number;
    readonly sources: readonly ResearchSource[];
  } | null;
  readonly reputation: 'strong' | 'average' | 'weak' | 'unknown';
  /** What the pages said, in a sentence; null when nothing was found or it claimed sales. */
  readonly summary: string | null;
}

export interface ScanResearchOutcome {
  readonly research: ScanResearch;
  readonly model: string;
  readonly attempts: number;
  readonly costMicros: number;
  readonly searches: number;
}

/** A research that got no usable answer; it carries what the attempts cost. */
export class ScanResearchFailedError extends Error {
  readonly attempts: number;
  readonly costMicros: number;

  constructor(spent: { attempts: number; costMicros: number }, options: ErrorOptions) {
    const cause = options.cause instanceof Error ? options.cause.message : String(options.cause);
    super(`the scan research failed: ${cause}`, options);
    this.name = 'ScanResearchFailedError';
    this.attempts = spent.attempts;
    this.costMicros = spent.costMicros;
  }
}

/**
 * Researches one brand and item with a standard-tier call and web search through `AiClient`,
 * so the kill switch, account blocks, daily budget, and metering apply (searches included). An
 * answer that breaks the schema is sent once more; any other failure throws
 * `ScanResearchFailedError` with the cost of every attempt.
 */
export async function researchScanItem(
  client: AiClient,
  input: ScanResearchInput,
): Promise<ScanResearchOutcome> {
  let attempts = 0;
  let costMicros = 0;
  let searches = 0;
  for (;;) {
    attempts += 1;
    try {
      const answer = await client.generate({
        context: {
          accountId: input.accountId,
          userId: input.userId,
          purpose: SCAN_RESEARCH_PURPOSE,
        },
        tier: 'standard',
        system: SCAN_RESEARCH_SYSTEM,
        prompt: JSON.stringify({
          brand: input.brand,
          item: input.item,
          ...(input.category === undefined ? {} : { category: input.category }),
          ...(input.line === undefined ? {} : { line: input.line }),
          ...(input.styleNumber === undefined ? {} : { styleNumber: input.styleNumber }),
          ...(input.era === undefined ? {} : { era: input.era }),
          ...(input.material === undefined ? {} : { material: input.material }),
          ...(input.style === undefined ? {} : { style: input.style }),
        }),
        photoSetHash: input.keyHash,
        images: [],
        output: SCAN_RESEARCH_OUTPUT,
        webSearch: { maxUses: MAX_RESEARCH_SEARCHES },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      costMicros += answer.costMicros;
      searches += answer.usage.webSearches;
      return {
        research: verifiedResearch(answer.output, answer.webSources),
        model: answer.model,
        attempts,
        costMicros,
        searches,
      };
    } catch (error) {
      if (error instanceof AiCallError) {
        costMicros += error.costMicros;
        if (error.code === 'invalid_output' && attempts < MAX_RESEARCH_ATTEMPTS) continue;
      }
      throw new ScanResearchFailedError({ attempts, costMicros }, { cause: error });
    }
  }
}

const SOLD_WORDS = /\b(sold|comps?|comparables?)\b/i;

/**
 * Where a resale range may come from: the resale marketplaces' own listings and the established
 * resale shops. Price-estimator sites that guess resale values are not sources of what items
 * resell for, so a range resting only on them is dropped.
 */
export const RESALE_SITES: ReadonlySet<string> = new Set([
  'depop.com',
  'poshmark.com',
  'mercari.com',
  'ebay.com',
  'grailed.com',
  'thredup.com',
  'therealreal.com',
  'vestiairecollective.com',
  'vinted.com',
  'fashionphile.com',
  'rebag.com',
  'stockx.com',
  'goat.com',
]);

function isResaleSite(site: string): boolean {
  return [...RESALE_SITES].some((resale) => site === resale || site.endsWith(`.${resale}`));
}

/**
 * The answer, holding only to the pages the searches returned: a price whose page was not
 * among them is dropped, a resale range keeps only its returned pages and goes without any, and
 * a summary that calls anything sold is dropped (it is web info, not sales).
 */
export function verifiedResearch(
  answer: ScanResearchAnswer,
  found: readonly WebSource[],
): ScanResearch {
  const returned = new Set(found.map((source) => normalizeUrl(source.url)));
  const source = (address: string): ResearchSource | undefined => {
    const normalized = normalizeUrl(address);
    if (normalized === '' || !returned.has(normalized)) return undefined;
    const site = siteOf(address);
    return site === undefined ? undefined : { url: address, site };
  };
  const retailSources =
    answer.retail.highCents > 0 ? verified(answer.retail.sourceUrls).slice(0, MAX_SOURCES) : [];
  function verified(addresses: readonly string[]): ResearchSource[] {
    return dedupeSites(
      addresses.flatMap((address) => {
        const found = source(address);
        return found === undefined ? [] : [found];
      }),
    );
  }
  const resaleSources = verified(answer.resale.sourceUrls)
    .filter((source) => isResaleSite(source.site))
    .slice(0, MAX_SOURCES);
  const hasResale = answer.resale.highCents > 0 && resaleSources.length > 0;
  const hasRetail = retailSources.length > 0;
  const anything = hasRetail || hasResale;
  const summary = answer.summary.trim();
  return {
    retail: hasRetail
      ? {
          lowCents: Math.max(1, answer.retail.lowCents),
          highCents: answer.retail.highCents,
          sources: retailSources,
          models: answer.retail.models
            .map((model) => clipped(model, MAX_MODEL_LENGTH))
            .filter((model) => model !== '')
            .slice(0, MAX_MODELS),
        }
      : null,
    resale: hasResale
      ? {
          lowCents: Math.max(1, answer.resale.lowCents),
          highCents: answer.resale.highCents,
          sources: resaleSources,
        }
      : null,
    reputation: anything ? answer.reputation : 'unknown',
    summary:
      anything && summary !== '' && !SOLD_WORDS.test(summary)
        ? clipped(summary, MAX_SUMMARY_LENGTH)
        : null,
  };
}

/** The text cut to at most `max` characters, at a word, with an ellipsis when cut. */
function clipped(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const room = trimmed.slice(0, max - 1);
  const atWord = room.lastIndexOf(' ');
  return `${(atWord > max / 2 ? room.slice(0, atWord) : room).trimEnd()}…`;
}

function normalizeUrl(address: string): string {
  try {
    const parsed = new URL(address.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    parsed.hash = '';
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`;
  } catch {
    return '';
  }
}

function siteOf(address: string): string | undefined {
  try {
    return new URL(address).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function dedupeSites(sources: readonly ResearchSource[]): ResearchSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.site)) return false;
    seen.add(source.site);
    return true;
  });
}
