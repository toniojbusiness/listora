import { photoSetHashOfImages, type AiClient } from '@listora/ai';
import { MAX_SCAN_IMAGES, ScanFailedError, scanItem, type ThriftScan } from '@listora/analysis';

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

/**
 * Replays the reads of an earlier run's report (`--json`), at no cost, so a change after the
 * read (the web research, the call) is measured on the very same reads. A report from before a
 * read field existed reads it as unknown (null); an item the report lacks fails to read.
 */
export class ReplayScanReader implements ScanReader {
  readonly id = 'replay';
  readonly description: string;
  readonly #reads: ReadonlyMap<string, ScanRead>;

  constructor(report: unknown, from: string) {
    const items = (report as { items?: unknown }).items;
    if (!Array.isArray(items)) throw new TypeError(`${from} is not a scan backtest report`);
    const reads = new Map<string, ScanRead>();
    for (const entry of items as { id?: unknown; read?: unknown }[]) {
      if (typeof entry.id !== 'string' || typeof entry.read !== 'object' || entry.read === null) {
        continue;
      }
      const read = entry.read as ScanRead;
      reads.set(
        entry.id,
        read.ok ? { ...read, scan: { ...REPLAYED_DEFAULTS, ...read.scan }, costMicros: 0 } : read,
      );
    }
    this.#reads = reads;
    this.description = `the reads replayed from ${from} (no cost)`;
  }

  read(_dataset: ScanDataset, item: ScanDatasetItem): Promise<ScanRead> {
    return Promise.resolve(
      this.#reads.get(item.id) ?? {
        ok: false,
        message: 'not in the replayed report',
        costMicros: 0,
        latencyMs: 0,
      },
    );
  }
}

const REPLAYED_DEFAULTS: Pick<
  ThriftScan,
  'line' | 'styleNumber' | 'era' | 'material' | 'retailPriceCents' | 'style'
> = {
  line: null,
  styleNumber: null,
  era: null,
  material: null,
  retailPriceCents: null,
  style: null,
};
