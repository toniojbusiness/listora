/**
 * What a run that stopped at a page Listora no longer understands (`element_missing`) logs about
 * that page: its structure, never its content (docs/features/automation.md, "When a page
 * changes"). The page modules are Listora's model of each marketplace's pages, and a logged-in
 * page can only be seen in a seller's own session, so this is how the one module that names the
 * missing part gets fixed against the real page.
 *
 * Everything is reduced before it leaves the page's host (the phone, or the browser runner):
 *
 * - paths keep only structural words (`/closet/<x>`), never a username or an id;
 * - titles and labels keep only common interface words (`Sell on Poshmark`, `<x>'s closet`);
 * - the page's own data (`window.__INITIAL_STATE__`, `__NEXT_DATA__`) is a skeleton of key
 *   paths and value types, with true or false spelled out, never a string or a number;
 * - test ids lose their digits, and nothing the run typed survives anywhere.
 */
import { z } from 'zod';

/** The page's structure, as a stopped run logs it. */
export interface PageEvidence {
  path: string;
  title: string;
  /** The page's distinct `data-testid` values. */
  testIds: string[];
  /** Links to the seller's own pages (closet, account, settings, sign out), with their ids. */
  links: string[];
  /** The page's own API calls on the marketplace's domains (`/v1/api?operationName=...`). */
  requests: string[];
  /** Data scripts the page keeps (`#__NEXT_DATA__ application/json`). */
  scripts: string[];
  /**
   * The page's form controls and buttons, by what names them (`input[file] #photos`,
   * `textarea data-vv-name:description`, `button testid:Submit`), never their values.
   */
  controls: string[];
  /**
   * The choices and labels a form offers (a category list, conditions, a field's label): the
   * site's own words. Any with a digit or an `@` are left out, so no address, price, or id is.
   */
  choices: string[];
  /** The page's own data: `__INITIAL_STATE__.auth.isUserLoggedIn: true`. */
  data: string[];
}

/** The page globals marketplaces keep their data in. */
export const DATA_GLOBALS = [
  '__INITIAL_STATE__',
  '__NEXT_DATA__',
  '__NUXT__',
  '__APOLLO_STATE__',
  '__PRELOADED_STATE__',
] as const;

/** The first path segment of a link to the seller's own pages. */
const ACCOUNT_LINK =
  /^(closet|mypage|my-page|my|account|accounts|settings|profile|user|users|u|me|seller|member|members|people|logout|log-out|signout|sign-out|login|log-in|signin|sign-in)$/i;

/**
 * What the page reads of itself: one evaluation in its isolated script world, bounded. It is
 * source text, so each host evaluates the same script.
 */
export const EVIDENCE_SCRIPT = `(() => {
  const accountLink = new RegExp(${JSON.stringify(ACCOUNT_LINK.source)}, 'i');
  const testIds = [...new Set([...document.querySelectorAll('[data-testid]')].map((element) => element.getAttribute('data-testid')))].slice(0, 120);
  const links = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    let url;
    try { url = new URL(anchor.getAttribute('href'), location.href); } catch { continue; }
    if (url.origin !== location.origin || !accountLink.test(url.pathname.split('/')[1] || '')) continue;
    const holder = anchor.closest('[data-testid]');
    links.push({
      path: url.pathname,
      et: anchor.getAttribute('data-et-name'),
      testId: holder ? holder.getAttribute('data-testid') : null,
      label: anchor.getAttribute('aria-label'),
    });
    if (links.length >= 40) break;
  }
  const requests = [...new Set(performance.getEntriesByType('resource')
    .filter((entry) => entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest')
    .map((entry) => entry.name))].slice(0, 120);
  const scripts = [...document.querySelectorAll('script[id], script[type]:not([src])')]
    .map((script) => ({ id: script.id || null, type: script.type || null }))
    .slice(0, 40);
  const named = ['data-testid', 'data-test', 'data-vv-name', 'data-et-name', 'name', 'id', 'role', 'aria-label', 'placeholder'];
  const controls = [...document.querySelectorAll('input, textarea, select, button, summary, [role="button"], [role="combobox"], [role="listbox"], [role="radio"], [role="checkbox"], [contenteditable="true"], [data-et-name]:not(a), [data-test]:not(a)')]
    .slice(0, 120)
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute('type'),
      names: named.flatMap((name) => { const value = element.getAttribute(name); return value ? [[name, value.slice(0, 60)]] : []; }),
      text: element.tagName === 'BUTTON' || element.tagName === 'SUMMARY' || element.getAttribute('role') === 'button' || (element.hasAttribute('data-et-name') && !/^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)) ? (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) : null,
    }));
  const choices = [...new Set([...document.querySelectorAll('option, [role="option"], [role="menuitem"], [role="radio"], label, legend')]
    .map((element) => (element.textContent || '').replace(/\\s+/g, ' ').trim())
    .filter((text) => text !== '' && text.length <= 40 && !/[0-9@]/.test(text)))].slice(0, 150);
  return { path: location.pathname, title: document.title, testIds, links, requests, scripts, controls, choices };
})()`;

/** Words of paths, titles, and labels that say what a page is, never whose it is. */
const STRUCTURAL_WORDS = new Set(
  (
    'a about access account accounts active and api apps are auth back brand brands bundles buy ' +
    'category categories closet closets config create create-listing current dashboard denied ' +
    'depop drafts ebay edit edit-listing error experiments feature features feed flags for found ' +
    'graphql health home hub human identity in in_progress inactive inbox info item items just ' +
    'likes list listing listings log log-in log-out login logout marketplace me mercari messages ' +
    'moment my my-page mypage new news not notifications of offers on order orders page poshmark ' +
    'product products profile profiles purchases rest robot sales search sell seller selling ' +
    'session sessions settings shipping shop sign sign-in sign-out signin signout sold something ' +
    'status the to up us user users v1 v2 v3 v4 verify viewer vm-rest web welcome went with ' +
    'wrong www you your ' +
    // Pages and API paths of the sellers' own areas, so their shape shows in the evidence.
    'address addresses balance bff buyer buyers complete completed count counts details draft ' +
    'feeds followers following gateway inquiries insights internal mobile overview payout ' +
    'payouts pending preferences presentation private public purchase receipt receipts referrals ' +
    'reviews saved searches sellers sellinghub selling-hub shipped sold-items stats summary ' +
    'transaction transactions verification verifications ' +
    // The words of listing forms: their fields, pickers, and buttons.
    'add apply cancel choose color colour condition continue cover department description ' +
    'designer discard done enter next optional photo photos post price quantity required save ' +
    'select single size sizes style subcategory title type update upload'
  ).split(' '),
);

/** Keys whose children are keyed by a user, an id, or a name. */
const KEYED_BY_RECORD = /^(users|profiles|closets|accounts|byId|entities|people|members)$/i;
/** Subtrees of a page's data the skeleton follows down: who is signed in, and Next.js props. */
const FOLLOWED = /auth|user|session|account|identity|viewer|profile|login|^me$|self|current/i;
const FOLLOWED_CONTAINERS = /^(props|pageProps|initialState|initialProps|state)$/;
/** Keys whose string value is a route (`__NEXT_DATA__.page`), kept as a reduced path. */
const ROUTE_KEYS = new Set(['page', 'route', 'pathname']);

const MAX_ITEM_LENGTH = 160;
const MAX_DATA_LINES = 160;
const MAX_DEPTH = 4;

export interface EvidenceContext {
  /** The marketplace's cookie domains: requests elsewhere are only counted. */
  cookieDomains: readonly string[];
  /** What the run typed or uploaded, which nothing logged may repeat. */
  typed: Iterable<string>;
}

const rawSchema = z.object({
  path: z.string(),
  title: z.string(),
  testIds: z.array(z.string().nullable()),
  links: z.array(
    z.object({
      path: z.string(),
      et: z.string().nullable(),
      testId: z.string().nullable(),
      label: z.string().nullable(),
    }),
  ),
  requests: z.array(z.string()),
  scripts: z.array(z.object({ id: z.string().nullable(), type: z.string().nullable() })),
  controls: z
    .array(
      z.object({
        tag: z.string(),
        type: z.string().nullable(),
        names: z.array(z.tuple([z.string(), z.string()])),
        text: z.string().nullable(),
      }),
    )
    .default([]),
  choices: z.array(z.string()).default([]),
});

/** Attributes that name a control as the site's code does, kept as they are (digits reduced). */
const CODE_NAMES = new Set([
  'data-testid',
  'data-test',
  'data-vv-name',
  'data-et-name',
  'name',
  'id',
  'role',
]);

/**
 * The evidence of what `EVIDENCE_SCRIPT` read and of the page's data globals (`data`, by name),
 * reduced to structure; `null` when the page answered something else.
 */
export function redactEvidence(
  raw: unknown,
  data: Readonly<Record<string, unknown>>,
  context: EvidenceContext,
): PageEvidence | null {
  const parsed = rawSchema.safeParse(raw);
  if (!parsed.success) return null;
  const read = parsed.data;
  const typed = [...context.typed].filter((value) => value.length >= 3);
  const clean = (text: string): string => {
    let result = text;
    for (const value of typed) result = result.split(value).join('<x>');
    return result.slice(0, MAX_ITEM_LENGTH);
  };
  const links = read.links.map((link) =>
    clean(
      [
        reducedPath(link.path),
        link.et === null ? null : `et:${reducedId(link.et)}`,
        link.testId === null ? null : `testid:${reducedId(link.testId)}`,
        link.label === null ? null : `label:${reducedWords(link.label)}`,
      ]
        .filter((part) => part !== null)
        .join(' '),
    ),
  );
  let elsewhere = 0;
  const requests: string[] = [];
  for (const request of read.requests) {
    const reduced = reducedRequest(request, context.cookieDomains);
    if (reduced === null) elsewhere += 1;
    else requests.push(clean(reduced));
  }
  if (elsewhere > 0) requests.push(`+${String(elsewhere)} elsewhere`);
  return {
    path: clean(reducedPath(read.path)),
    title: clean(reducedWords(read.title)),
    testIds: distinct(
      read.testIds.flatMap((id) => (id === null || id === '' ? [] : [clean(reducedId(id))])),
    ),
    links: distinct(links),
    requests: distinct(requests),
    scripts: distinct(
      read.scripts.map((script) =>
        clean(
          [script.id === null ? null : `#${reducedId(script.id)}`, script.type]
            .filter((part) => part !== null)
            .join(' '),
        ),
      ),
    ),
    data: Object.entries(data)
      .flatMap(([name, value]) => dataSkeleton(name, value))
      .slice(0, MAX_DATA_LINES)
      .map(clean),
    controls: distinct(
      read.controls.map((control) =>
        clean(
          [
            control.type === null ? control.tag : `${control.tag}[${reducedId(control.type)}]`,
            ...control.names.map(([name, value]) =>
              CODE_NAMES.has(name)
                ? `${name}:${reducedId(value)}`
                : `${name}:${reducedWords(value)}`,
            ),
            control.text === null || control.text === ''
              ? null
              : `text:${reducedWords(control.text)}`,
          ]
            .filter((part) => part !== null)
            .join(' '),
        ),
      ),
    ),
    choices: distinct(read.choices.filter((text) => !/[0-9@]/.test(text)).map(clean)),
  };
}

/** `/closet/janedoe/edit` → `/closet/<x>/edit`: only structural words stay. */
export function reducedPath(path: string): string {
  const segments = path.split('/').map((segment) => {
    if (segment === '') return segment;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return '<x>';
    }
    return STRUCTURAL_WORDS.has(decoded.toLowerCase()) ? decoded : '<x>';
  });
  return segments.join('/') || '/';
}

/** Interface words stay, every other word is `<x>`: `Jane's Closet | Poshmark` → `<x> Closet | Poshmark`. */
export function reducedWords(text: string): string {
  return text
    .split(/(\s+)/)
    .map((token) => {
      if (/^\s*$/.test(token) || !/[\p{L}\p{N}]/u.test(token)) return token;
      const word = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      return STRUCTURAL_WORDS.has(word.toLowerCase()) ? token : '<x>';
    })
    .join('')
    .trim();
}

/** A developer's id (a test id, an event name) without the digits a record's id brings. */
function reducedId(id: string): string {
  return id.includes('@') ? '<x>' : id.replace(/[0-9a-f]{16,}/gi, '<id>').replace(/\d+/g, '#');
}

/** A request on the marketplace's domains: its reduced path and its GraphQL operation. */
function reducedRequest(request: string, cookieDomains: readonly string[]): string | null {
  if (!URL.canParse(request)) return null;
  const url = new URL(request);
  const onSite = cookieDomains.some((domain) => {
    const bare = domain.replace(/^\./, '');
    return url.hostname === bare || url.hostname.endsWith(`.${bare}`);
  });
  if (!onSite) return null;
  const operation = url.searchParams.get('operationName');
  const named = operation !== null && /^[A-Za-z_]\w{0,80}$/.test(operation);
  return `${url.hostname}${reducedPath(url.pathname)}${named ? `?operationName=${operation}` : ''}`;
}

/**
 * The skeleton of a page's data: its top-level keys and, down the parts that say who is signed
 * in, every key path with its value's type (`true` and `false` as they are).
 */
export function dataSkeleton(name: string, value: unknown): string[] {
  const lines: string[] = [];
  const walk = (path: string, node: unknown, depth: number, follow: boolean): void => {
    if (lines.length >= MAX_DATA_LINES) return;
    const key = path.slice(path.lastIndexOf('.') + 1);
    lines.push(`${path}: ${describe(key, node)}`);
    if (node === null || typeof node !== 'object' || depth >= MAX_DEPTH) return;
    const entries = Array.isArray(node)
      ? node.slice(0, 1).map((item) => ['0', item] as const)
      : Object.entries(node);
    const keyedByRecord = KEYED_BY_RECORD.test(key);
    for (const [child, childValue] of entries.slice(0, 60)) {
      const shown = keyedByRecord ? '<key>' : reducedId(child);
      const followed = follow || FOLLOWED.test(child);
      if (depth === 0 || followed || FOLLOWED_CONTAINERS.test(child)) {
        walk(`${path}.${shown}`, childValue, depth + 1, followed);
      }
      if (keyedByRecord) break;
    }
  };
  walk(name, value, 0, false);
  return lines;
}

function describe(key: string, value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `array(${String(value.length)})`;
  if (typeof value === 'string' && ROUTE_KEYS.has(key)) return `"${reducedPath(value)}"`;
  return typeof value;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Evidence as an answer or a log carries it, bounded. */
export const pageEvidenceSchema = z.object({
  path: z.string().max(MAX_ITEM_LENGTH),
  title: z.string().max(MAX_ITEM_LENGTH),
  testIds: z.array(z.string().max(MAX_ITEM_LENGTH)).max(120),
  links: z.array(z.string().max(MAX_ITEM_LENGTH)).max(40),
  requests: z.array(z.string().max(MAX_ITEM_LENGTH)).max(121),
  scripts: z.array(z.string().max(MAX_ITEM_LENGTH)).max(40),
  data: z.array(z.string().max(MAX_ITEM_LENGTH)).max(MAX_DATA_LINES),
  controls: z.array(z.string().max(MAX_ITEM_LENGTH)).max(120).default([]),
  choices: z.array(z.string().max(MAX_ITEM_LENGTH)).max(150).default([]),
}) satisfies z.ZodType<PageEvidence>;
