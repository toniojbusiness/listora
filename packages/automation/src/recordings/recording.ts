/**
 * A recorded marketplace page (docs/features/recorded-pages.md): what one of a marketplace's
 * scripts did on the seller's real, signed-in pages, and what those pages were at each moment,
 * redacted (redact.ts), so tests run the same script against the same pages (replay.ts) instead
 * of against a hand-made fake.
 *
 * A recording is the script's page actions in order (`events`: each navigation, click, fill,
 * and keystroke run), the page as it was after each action (`states`: its address, its status,
 * its document as `snapshot.ts` serializes it, and the data globals the script read), the reads
 * the script made of the marketplace's own web API (`api`), and what the script returned. The
 * file is JSON in the marketplace's `recordings/` folder, one per plan entry (plans.ts). A
 * state whose document differs little from the one before it is kept as a patch of that one,
 * so a form filled field by field stays small.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { format } from 'prettier';
import { z } from 'zod';

/** The marketplaces with recorded pages: the ones automated in the seller's own browser. */
export const RECORDED_MARKETPLACES = ['depop', 'mercari', 'poshmark'] as const;
export type RecordedMarketplace = (typeof RECORDED_MARKETPLACES)[number];

/** The kinds of page a recording is of. */
export const RECORDED_PAGES = [
  'hub',
  'shop',
  'listing',
  'edit',
  'sell-form',
  'sold',
  'offers',
  /** A marketplace's public search, as a logged-out visitor sees it (comparisons). */
  'search',
] as const;
export type RecordedPage = (typeof RECORDED_PAGES)[number];

/**
 * Which host's page backend a recording was made through, and is replayed through: the phone
 * runtime's (the marketplaces that run on the seller's iPhone) or the browser runner's.
 */
export const RECORDING_HOSTS = ['phone', 'runner'] as const;
export type RecordingHost = (typeof RECORDING_HOSTS)[number];

/** Bumped when the format changes in a way older files cannot be read in. */
export const RECORDING_FORMAT = 1;

const eventSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('goto'), url: z.string(), state: z.number().int() }),
  z.object({ op: z.literal('click'), selector: z.string(), state: z.number().int() }),
  z.object({
    op: z.literal('focus'),
    selector: z.string(),
    /** The characters typed into the field after it was focused, one key at a time. */
    typed: z.string(),
    state: z.number().int(),
  }),
  z.object({
    op: z.literal('fill'),
    selector: z.string(),
    text: z.string(),
    state: z.number().int(),
  }),
  z.object({
    op: z.literal('select'),
    selector: z.string(),
    value: z.string(),
    state: z.number().int(),
  }),
  z.object({
    op: z.literal('check'),
    selector: z.string(),
    checked: z.boolean(),
    state: z.number().int(),
  }),
  z.object({
    op: z.literal('upload'),
    selector: z.string(),
    files: z.array(z.string()),
    state: z.number().int(),
  }),
]);
export type RecordedEvent = z.infer<typeof eventSchema>;

/**
 * A document as an earlier state's, edited: runs of that state's lines kept (`copy`: the first
 * line and how many), and lines of its own between them (`insert`), in order.
 */
const patchSchema = z.object({
  /** The state whose lines this one starts from (always an earlier one). */
  from: z.number().int(),
  edits: z.array(
    z.union([
      z.object({ copy: z.tuple([z.number().int(), z.number().int()]) }),
      z.object({ insert: z.array(z.string()) }),
    ]),
  ),
});
type Edit = z.infer<typeof patchSchema>['edits'][number];

const stateSchema = z.object({
  /** The main frame's address. */
  url: z.string(),
  /** The status of the navigation that loaded the page, `null` after an action without one. */
  status: z.number().int().nullable(),
  /**
   * The data globals the script read on this page (`PageDriver.pageData`), by name; left out
   * when they are the state before's (a page's data stays with it while it is open).
   */
  data: z.record(z.string(), z.unknown()).optional(),
  /** The document's lines (snapshot.ts), or a patch of an earlier state's. */
  html: z.union([z.array(z.string()), patchSchema]),
});
export type RecordedState = z.infer<typeof stateSchema>;

const apiSchema = z.object({
  url: z.string(),
  status: z.number().int(),
  retryAfter: z.string().nullable(),
  /** The body, parsed when it is JSON. */
  json: z.unknown().optional(),
  /** The body when it is not JSON (`null` when the page sent none). */
  text: z.string().nullable().optional(),
});
export type RecordedApiAnswer = z.infer<typeof apiSchema>;

const resultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({
    ok: z.literal(false),
    /** How the script stopped (its failure, without screenshot keys or evidence). */
    failure: z.record(z.string(), z.unknown()),
  }),
]);
export type RecordedResult = z.infer<typeof resultSchema>;

const recordingSchema = z.object({
  format: z.literal(RECORDING_FORMAT),
  marketplace: z.enum(RECORDED_MARKETPLACES),
  /** The plan entry it records (plans.ts). */
  name: z.string(),
  page: z.enum(RECORDED_PAGES),
  host: z.enum(RECORDING_HOSTS),
  /** The day it was recorded, `YYYY-MM-DD`. */
  recordedOn: z.string(),
  /** What the plan entry was given (a listing's id, read by an earlier entry), or `null`. */
  input: z.unknown(),
  /** What the script returned on the real pages. */
  result: resultSchema,
  /** The names of the steps it ran. */
  steps: z.array(z.string()),
  events: z.array(eventSchema),
  states: z.array(stateSchema),
  api: z.array(apiSchema),
});
export type Recording = z.infer<typeof recordingSchema>;

/** A state with its document as lines: what a recording session captures, before compaction. */
export interface CapturedState {
  url: string;
  status: number | null;
  data: Record<string, unknown>;
  lines: string[];
}

/** A recording whose states hold their whole documents. */
export type ExpandedRecording = Omit<Recording, 'states'> & { states: CapturedState[] };

/** The folder of a marketplace's recordings. */
export function recordingsDir(marketplace: RecordedMarketplace): string {
  return fileURLToPath(new URL(`../${marketplace}/recordings/`, import.meta.url));
}

export function recordingPath(marketplace: RecordedMarketplace, name: string): string {
  return `${recordingsDir(marketplace)}${name}.json`;
}

export function parseRecording(value: unknown): Recording {
  return recordingSchema.parse(value);
}

/** Every recording of a marketplace, by name. */
export async function loadRecordings(
  marketplace: RecordedMarketplace,
): Promise<Map<string, Recording>> {
  const dir = recordingsDir(marketplace);
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter((file) => file.endsWith('.json'))
    .sort();
  const recordings = new Map<string, Recording>();
  for (const file of names) {
    const recording = parseRecording(JSON.parse(await readFile(`${dir}${file}`, 'utf8')));
    recordings.set(recording.name, recording);
  }
  return recordings;
}

/** Writes a recording as formatted JSON, its states compacted. */
export async function saveRecording(recording: ExpandedRecording): Promise<string> {
  const path = recordingPath(recording.marketplace, recording.name);
  const compacted: Recording = { ...recording, states: compactStates(recording.states) };
  const text = await format(JSON.stringify(parseRecording(compacted)), {
    parser: 'json',
    printWidth: 100,
  });
  await mkdir(recordingsDir(recording.marketplace), { recursive: true });
  await writeFile(path, text);
  return path;
}

/** The recording with every state's whole document. */
export function expandRecording(recording: Recording): ExpandedRecording {
  const lines: string[][] = [];
  let data: Record<string, unknown> = {};
  const states = recording.states.map((state, index): CapturedState => {
    const html = state.html;
    let own: string[];
    if (Array.isArray(html)) {
      own = html;
    } else {
      const base = html.from < index ? lines[html.from] : undefined;
      if (base === undefined) throw new Error(`state ${String(index)} patches a later state`);
      own = html.edits.flatMap((edit) =>
        'copy' in edit ? base.slice(edit.copy[0], edit.copy[0] + edit.copy[1]) : edit.insert,
      );
    }
    lines.push(own);
    data = state.data ?? data;
    return { url: state.url, status: state.status, data, lines: own };
  });
  return { ...recording, states };
}

/**
 * The states as stored: a state that shares most of its lines with the one before it is a
 * patch of that one (its own lines between runs of the other's), any other whole.
 */
export function compactStates(states: readonly CapturedState[]): RecordedState[] {
  return states.map((state, index) => {
    const previous = index > 0 ? states[index - 1] : undefined;
    const sameData =
      previous !== undefined && JSON.stringify(previous.data) === JSON.stringify(state.data);
    const whole: RecordedState = {
      url: state.url,
      status: state.status,
      ...(sameData ? {} : { data: state.data }),
      html: state.lines,
    };
    if (previous === undefined) return whole;
    const edits = lineEdits(previous.lines, state.lines);
    const size = edits.reduce(
      (sum, edit) =>
        sum + ('copy' in edit ? 16 : edit.insert.reduce((n, line) => n + line.length + 3, 0)),
      0,
    );
    const own = state.lines.reduce((sum, line) => sum + line.length + 3, 0);
    return size * 2 < own ? { ...whole, html: { from: index - 1, edits } } : whole;
  });
}

/**
 * The edits that make `lines` from `base`: a patience diff (lines that occur once in each,
 * matched in order, anchor the runs kept; the parts between them are diffed the same way).
 */
export function lineEdits(base: readonly string[], lines: readonly string[]): Edit[] {
  const edits: Edit[] = [];
  const copy = (start: number, count: number): void => {
    if (count === 0) return;
    const last = edits.at(-1);
    if (last !== undefined && 'copy' in last && last.copy[0] + last.copy[1] === start) {
      last.copy[1] += count;
    } else edits.push({ copy: [start, count] });
  };
  const insert = (from: number, to: number): void => {
    if (from === to) return;
    const last = edits.at(-1);
    if (last !== undefined && 'insert' in last) last.insert.push(...lines.slice(from, to));
    else edits.push({ insert: lines.slice(from, to) });
  };
  const diff = (aLo: number, aHi: number, bLo: number, bHi: number): void => {
    let head = 0;
    while (aLo + head < aHi && bLo + head < bHi && base[aLo + head] === lines[bLo + head])
      head += 1;
    let tail = 0;
    while (
      aHi - tail > aLo + head &&
      bHi - tail > bLo + head &&
      base[aHi - 1 - tail] === lines[bHi - 1 - tail]
    ) {
      tail += 1;
    }
    copy(aLo, head);
    const anchors = uniqueMatches(aLo + head, aHi - tail, bLo + head, bHi - tail);
    if (anchors.length === 0) {
      insert(bLo + head, bHi - tail);
    } else {
      let a = aLo + head;
      let b = bLo + head;
      for (const [aAt, bAt] of anchors) {
        diff(a, aAt, b, bAt);
        copy(aAt, 1);
        a = aAt + 1;
        b = bAt + 1;
      }
      diff(a, aHi - tail, b, bHi - tail);
    }
    copy(aHi - tail, tail);
  };
  /** Lines once in each range, matched, in the longest run of increasing order. */
  const uniqueMatches = (
    aLo: number,
    aHi: number,
    bLo: number,
    bHi: number,
  ): [number, number][] => {
    const once = (from: readonly string[], lo: number, hi: number) => {
      const seen = new Map<string, number>();
      for (let at = lo; at < hi; at += 1) {
        const line = from[at] ?? '';
        seen.set(line, seen.has(line) ? -1 : at);
      }
      return seen;
    };
    const inA = once(base, aLo, aHi);
    const inB = once(lines, bLo, bHi);
    const pairs: [number, number][] = [];
    for (const [line, bAt] of inB) {
      const aAt = inA.get(line);
      if (bAt >= 0 && aAt !== undefined && aAt >= 0) pairs.push([aAt, bAt]);
    }
    pairs.sort((x, y) => x[1] - y[1]);
    // The longest increasing run of `a` positions (patience sorting).
    const tops: number[] = [];
    const back: number[] = [];
    for (const [index, [aAt]] of pairs.entries()) {
      let lo = 0;
      let hi = tops.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((pairs[tops[mid] ?? 0]?.[0] ?? 0) < aAt) lo = mid + 1;
        else hi = mid;
      }
      back[index] = lo > 0 ? (tops[lo - 1] ?? -1) : -1;
      tops[lo] = index;
    }
    const run: [number, number][] = [];
    for (let at = tops.at(-1) ?? -1; at >= 0; at = back[at] ?? -1) {
      const pair = pairs[at];
      if (pair !== undefined) run.unshift(pair);
    }
    return run;
  };
  diff(0, base.length, 0, lines.length);
  return edits;
}
