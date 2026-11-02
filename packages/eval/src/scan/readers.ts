import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { photoSetHashOfImages, type AiClient } from '@listora/ai';
import {
  MAX_SCAN_IMAGES,
  researchScanItem,
  ScanFailedError,
  scanItem,
  ScanResearchFailedError,
  scanResearchSubject,
  type ScanResearch,
  type ThriftScan,
} from '@listora/analysis';
import { z } from 'zod';

import { scanImages, type ScanDataset, type ScanDatasetItem } from './dataset.ts';

/** One item's scan read, or why it failed; both with what the read cost and took. */
export type ScanRead =
  | { readonly ok: true; readonly scan: ThriftScan; costMicros: number; latencyMs: number }
  | { readonly ok: false; readonly message: string; costMicros: number; latencyMs: number };

/** Reads an item the way the scan does at the store. */
export interface ScanReader {
  readonly id: string;
  readonly description: string;
  read(dataset: ScanDataset, item: ScanDatasetItem): Promise<ScanRead>;
}

export interface AiScanReaderOptions {
  readonly id: string;
  readonly description: string;
  readonly client: AiClient;
  /** How many of the item's photos the scan sends: the shot, then a closer look. */
  readonly images: number;
  /** Wall clock, for each read's latency. */
  readonly now?: () => number;
}

/**
 * The production scan read (`scanItem` from @listora/analysis): the same prompt, schema,
 * retry, and metering as at the store, on the item's first photo (and its second with
 * `images: 2`). Latency is the wall time of the whole read, retries included.
 */
export class AiScanReader implements ScanReader {
  readonly id: string;
  readonly description: string;
  readonly #client: AiClient;
  readonly #images: number;
  readonly #now: () => number;

  constructor(options: AiScanReaderOptions) {
    if (!Number.isInteger(options.images) || options.images < 1) {
      throw new RangeError('a scan sends at least one image');
    }
    this.id = options.id;
    this.description = options.description;
    this.#client = options.client;
    this.#images = Math.min(options.images, MAX_SCAN_IMAGES);
    this.#now = options.now ?? (() => performance.now());
  }

  async read(dataset: ScanDataset, item: ScanDatasetItem): Promise<ScanRead> {
    const images = await scanImages(dataset, item, this.#images);
    const started = this.#now();
    try {
      const outcome = await scanItem(this.#client, {
        accountId: 'eval',
        userId: null,
        photoSetHash: photoSetHashOfImages(images),
        images,
      });
      const latencyMs = this.#now() - started;
      return { ok: true, scan: outcome.scan, costMicros: outcome.costMicros, latencyMs };
    } catch (error) {
      const latencyMs = this.#now() - started;
      if (error instanceof ScanFailedError) {
        return { ok: false, message: error.message, costMicros: error.costMicros, latencyMs };
      }
      throw error;
    }
  }
}

/** What an item's research is keyed by, for the fake provider's fixtures. */
export function researchKeyHash(item: ScanDatasetItem): string {
  return createHash('sha256').update(`scan-backtest-research|${item.id}`).digest('hex');
}

/** One item's web research, or why it failed; both with what it cost and took. */
export type ResearchRead =
  | {
      readonly ok: true;
      readonly research: ScanResearch;
      costMicros: number;
      latencyMs: number;
      searches: number;
    }
  | { readonly ok: false; readonly message: string; costMicros: number; latencyMs: number };

/** Looks an item up on the web the way the scan's research does, after its read. */
export interface ScanResearcher {
  readonly id: string;
  readonly description: string;
  /** Undefined when the read has no brand: the scan never looks such an item up. */
  research(item: ScanDatasetItem, scan: ThriftScan): Promise<ResearchRead | undefined>;
}

export interface AiScanResearcherOptions {
  readonly id: string;
  readonly description: string;
  readonly client: AiClient;
  readonly now?: () => number;
}

/**
 * The production web research (`researchScanItem` from @listora/analysis), asked about the
 * read exactly as the scan asks (`scanResearchSubject`): at most two searches, every number
 * held to the pages they returned.
 */
export class AiScanResearcher implements ScanResearcher {
  readonly id: string;
  readonly description: string;
  readonly #client: AiClient;
  readonly #now: () => number;

  constructor(options: AiScanResearcherOptions) {
    this.id = options.id;
    this.description = options.description;
    this.#client = options.client;
    this.#now = options.now ?? (() => performance.now());
  }

  async research(item: ScanDatasetItem, scan: ThriftScan): Promise<ResearchRead | undefined> {
    const subject = scanResearchSubject(scan);
    if (subject === undefined) return undefined;
    const started = this.#now();
    try {
      const outcome = await researchScanItem(this.#client, {
        accountId: 'eval',
        userId: null,
        keyHash: researchKeyHash(item),
        ...subject,
      });
      return {
        ok: true,
        research: outcome.research,
        costMicros: outcome.costMicros,
        latencyMs: this.#now() - started,
        searches: outcome.searches,
      };
    } catch (error) {
      const latencyMs = this.#now() - started;
      if (error instanceof ScanResearchFailedError) {
        return { ok: false, message: error.message, costMicros: error.costMicros, latencyMs };
      }
      throw error;
    }
  }
}

/** A stored run's reads and research, by item id: a `--json` report of an earlier run. */
export interface RecordedRun {
  readonly reader: { readonly id: string; readonly description: string } | null;
  readonly researcher: { readonly id: string; readonly description: string } | null;
  readonly items: ReadonlyMap<
    string,
    { readonly read?: ScanRead | undefined; readonly research?: ResearchRead | undefined }
  >;
}

const recordedRunSchema = z.object({
  reader: z.object({ id: z.string(), description: z.string() }).nullable(),
  researcher: z.object({ id: z.string(), description: z.string() }).nullable().optional(),
  items: z.array(
    z.object({
      id: z.string(),
      read: z.object({ ok: z.boolean() }).loose().optional(),
      research: z.object({ ok: z.boolean() }).loose().optional(),
    }),
  ),
});

/**
 * Reads a stored run (a `--json` report) to answer from again, so a change to the call or the
 * calibration is measured on the same model answers without paying for them twice. The answers
 * are the report's own, written by this backtest; only their outline is checked.
 */
export async function loadRecordedRun(file: string): Promise<RecordedRun> {
  const parsed = recordedRunSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
  if (!parsed.success) {
    throw new Error(`${file} is not a scan backtest's --json report: ${parsed.error.message}`);
  }
  return {
    reader: parsed.data.reader,
    researcher: parsed.data.researcher ?? null,
    items: new Map(
      parsed.data.items.map((entry) => [
        entry.id,
        {
          read: entry.read as ScanRead | undefined,
          research: entry.research as ResearchRead | undefined,
        },
      ]),
    ),
  };
}

/** Answers each item's read from a stored run; an item it never read fails, at no cost. */
export class RecordedScanReader implements ScanReader {
  readonly id: string;
  readonly description: string;
  readonly #run: RecordedRun;

  constructor(run: RecordedRun, file: string) {
    if (run.reader === null) throw new Error(`${file} has no AI reads to answer from`);
    this.id = run.reader.id;
    this.description = `${run.reader.description} (stored answers from ${basename(file)})`;
    this.#run = run;
  }

  read(_dataset: ScanDataset, item: ScanDatasetItem): Promise<ScanRead> {
    const read = this.#run.items.get(item.id)?.read;
    return Promise.resolve(
      read ?? { ok: false, message: 'not in the stored run', costMicros: 0, latencyMs: 0 },
    );
  }
}

/** Answers each item's research from a stored run; an item it never looked up has none. */
export class RecordedScanResearcher implements ScanResearcher {
  readonly id: string;
  readonly description: string;
  readonly #run: RecordedRun;

  constructor(run: RecordedRun, file: string) {
    if (run.researcher === null) throw new Error(`${file} has no web research to answer from`);
    this.id = run.researcher.id;
    this.description = `${run.researcher.description} (stored answers from ${basename(file)})`;
    this.#run = run;
  }

  research(item: ScanDatasetItem): Promise<ResearchRead | undefined> {
    return Promise.resolve(this.#run.items.get(item.id)?.research);
  }
}
