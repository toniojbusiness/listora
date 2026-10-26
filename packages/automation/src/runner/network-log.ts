/**
 * What one browser session's network did, by origin only (never a path or a query): the
 * requests the runner's network rules refused (safety/network.ts), the responses with an error
 * status, and the requests that failed on the way. A run that stops logs it, so a page that broke
 * because of Listora's own rules can be told apart from one the marketplace answered with errors
 * (on 2026-10-26 Poshmark's listing page said "Something went wrong" in the cloud runner).
 */
import { originForLog } from '../safety/redaction.ts';

/** Entries kept per kind; a page that fails everywhere still logs a bounded line. */
const MAX_ENTRIES = 20;

/** Chromium's error for a request the network rules aborted (`blockedbyclient`). */
const REFUSED_ERROR = 'net::ERR_BLOCKED_BY_CLIENT';

export interface NetworkSummary {
  /** Requests the network rules refused, by origin. */
  refused?: Record<string, number>;
  /** Responses with a 4xx or 5xx status, by `origin status`. */
  errors?: Record<string, number>;
  /** Requests that got no response, by `origin error`. */
  failed?: Record<string, number>;
}

export class NetworkLog {
  readonly #refused = new Map<string, number>();
  readonly #errors = new Map<string, number>();
  readonly #failed = new Map<string, number>();

  /** A request the network rules refused. */
  refused(url: string): void {
    count(this.#refused, originForLog(url));
  }

  response(url: string, status: number): void {
    if (status >= 400) count(this.#errors, `${originForLog(url)} ${String(status)}`);
  }

  /** A request that got no response; the rules' own refusals are already counted. */
  failed(url: string, error: string): void {
    if (error !== REFUSED_ERROR) count(this.#failed, `${originForLog(url)} ${error.slice(0, 60)}`);
  }

  /** Undefined when nothing was refused or went wrong. */
  summary(): NetworkSummary | undefined {
    const summary: NetworkSummary = {
      ...entries('refused', this.#refused),
      ...entries('errors', this.#errors),
      ...entries('failed', this.#failed),
    };
    return Object.keys(summary).length === 0 ? undefined : summary;
  }
}

function count(counts: Map<string, number>, key: string): void {
  if (counts.has(key) || counts.size < MAX_ENTRIES) counts.set(key, (counts.get(key) ?? 0) + 1);
}

function entries<K extends keyof NetworkSummary>(
  kind: K,
  counts: Map<string, number>,
): Partial<Record<K, Record<string, number>>> {
  return counts.size === 0
    ? {}
    : ({ [kind]: Object.fromEntries(counts) } as Partial<Record<K, Record<string, number>>>);
}
