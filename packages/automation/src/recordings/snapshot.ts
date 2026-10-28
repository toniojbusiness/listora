/**
 * The page as a recording keeps it (recording.ts): a serialization of the live document that a
 * replay (replay.ts) loads back as the same elements, attributes, text, and form state, and
 * nothing that runs or reaches out.
 *
 * - The marketplace's own scripts are dropped; its data scripts stay, inert: JSON (`type`
 *   `application/json` and `application/ld+json`, such as Mercari's `script#__NEXT_DATA__` and
 *   schema.org prices) and Depop's App Router payload (`self.__next_f.push(...)`, kept with a
 *   non-script type so a replay never runs it). The scripts read both from the document.
 * - Stylesheets, `<style>`, `<link>`, `<meta>`, `<base>`, `<noscript>`, `<template>`, comments,
 *   SVG drawings (an `<svg>` keeps its attributes, not its shapes), frames' documents, and
 *   event-handler attributes are dropped. Without the site's CSS, what the page hid or made
 *   invisible is marked from its computed style instead (`data-replay-hidden`, `-invisible`,
 *   `-transparent`, and `-collapsed` for a form control or frame drawn with no size), and the
 *   replay's own style rule hides it the same way, so a waiting script, Playwright's checks, and
 *   the page inspection see what the seller's browser showed.
 * - Form state is written into attributes: a field's current value, a box's checked state, an
 *   option's selection.
 * - The text of the profile's private parts (a buyer's name, an address, messages) is returned
 *   beside the document, so redaction (redact.ts) replaces each wherever it appears: in the
 *   document and in what the script read from it alike.
 * - A frame keeps its address without the query.
 *
 * Every tag's closing `>` starts a new line (`<div id="a"\n>text</div\n>`): legal HTML that adds
 * no text to the document, so the replay's elements read exactly as the live ones, while a
 * recording diffs and patches line by line.
 */

/** Marks the replay's style rule hides elements by, as the seller's browser did. */
export const REPLAY_MARKS = {
  hidden: 'data-replay-hidden',
  invisible: 'data-replay-invisible',
  transparent: 'data-replay-transparent',
  collapsed: 'data-replay-collapsed',
} as const;

/** What the snapshot script returns. */
export interface Snapshot {
  /** The document, as one string. */
  html: string;
  /** The texts of the page's private parts, for redaction. */
  privateTexts: string[];
}

/**
 * The page script that serializes the document; `privateSelectors` are the profile's private
 * parts. It runs in the live page (`PageBackend.read`) and returns a `Snapshot`.
 */
export function snapshotScript(privateSelectors: readonly string[]): string {
  return `(() => {
    const marks = ${JSON.stringify(REPLAY_MARKS)};
    const privateTexts = [];
    const privateSelectors = ${JSON.stringify(privateSelectors)};
    const dropped = new Set(['style', 'link', 'meta', 'base', 'noscript', 'template', 'object', 'embed']);
    const empty = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
    const rawText = new Set(['script', 'textarea', 'title']);
    const controls = new Set(['input', 'textarea', 'select', 'button', 'iframe']);
    const privateParts = new Set();
    for (const selector of privateSelectors) {
      try {
        for (const element of document.querySelectorAll(selector)) privateParts.add(element);
      } catch {}
    }
    const escapeText = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escapeAttribute = (text) =>
      text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const dataScript = (element) => {
      if (element.src) return null;
      const type = (element.getAttribute('type') || '').toLowerCase();
      if (type === 'application/json' || type === 'application/ld+json') return type;
      if (/^\\s*self\\.__next_f\\.push\\(/.test(element.textContent || '')) return 'text/x-replay-flight';
      return null;
    };
    const marksOf = (element, tag) => {
      const found = [];
      let style;
      try {
        style = getComputedStyle(element);
      } catch {
        return found;
      }
      if (style.display === 'none') found.push(marks.hidden);
      if (style.visibility === 'hidden' || style.visibility === 'collapse') found.push(marks.invisible);
      if (Number(style.opacity) === 0) found.push(marks.transparent);
      if (controls.has(tag) && style.display !== 'none') {
        const rect = element.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) found.push(marks.collapsed);
      }
      return found;
    };
    const attributesOf = (element, tag) => {
      const pairs = [];
      for (const attribute of element.attributes) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith('on') || name.startsWith('data-replay-')) continue;
        if (tag === 'input' && (name === 'value' || name === 'checked')) continue;
        if (tag === 'option' && name === 'selected') continue;
        let value = attribute.value;
        if (name === 'href' && /^\\s*javascript:/i.test(value)) value = '#';
        if (tag === 'iframe' && name === 'src') {
          try {
            const url = new URL(value, location.href);
            value = url.origin + url.pathname;
          } catch {
            value = '';
          }
        }
        pairs.push([attribute.name, value]);
      }
      if (tag === 'input') {
        const type = (element.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox' || type === 'radio') {
          if (element.value !== 'on' || element.hasAttribute('value')) pairs.push(['value', element.value]);
          if (element.checked) pairs.push(['checked', '']);
        } else if (type !== 'file' && type !== 'password') {
          pairs.push(['value', element.value]);
        }
      }
      if (tag === 'option' && element.selected) pairs.push(['selected', '']);
      for (const mark of marksOf(element, tag)) pairs.push([mark, '']);
      return pairs
        .map(([name, value]) => (value === '' && name !== 'value' ? ' ' + name : ' ' + name + '="' + escapeAttribute(value) + '"'))
        .join('');
    };
    const out = [];
    const walk = (node, isPrivate) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || '';
        if (isPrivate && text.trim() !== '') privateTexts.push(text.trim());
        out.push(escapeText(text));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node;
      const tag = element.localName;
      if (dropped.has(tag)) return;
      let scriptType = null;
      if (tag === 'script') {
        scriptType = dataScript(element);
        if (scriptType === null) return;
      }
      const inPrivate = isPrivate || privateParts.has(element);
      let attributes = attributesOf(element, tag);
      if (scriptType !== null) {
        attributes = attributes.replace(/ type="[^"]*"/, '') + ' type="' + scriptType + '"';
      }
      out.push('<' + tag + attributes + '\\n>');
      if (empty.has(tag)) return;
      if (tag === 'script') {
        out.push((element.textContent || '').replace(/<\\/(script)/gi, '<\\\\/$1'));
      } else if (tag === 'textarea') {
        if (inPrivate && element.value.trim() !== '') privateTexts.push(element.value.trim());
        out.push(escapeText(element.value));
      } else if (tag === 'title') {
        out.push(escapeText(element.textContent || ''));
      } else if (tag !== 'svg' && tag !== 'iframe') {
        for (const child of element.childNodes) walk(child, inPrivate);
      }
      out.push('</' + tag + '\\n>');
    };
    walk(document.documentElement, false);
    return { html: out.join(''), privateTexts };
  })()`;
}

/** The replay's style rule: what the seller's browser hid stays hidden. */
const REPLAY_STYLE = [
  `[${REPLAY_MARKS.hidden}]{display:none!important}`,
  `[${REPLAY_MARKS.invisible}]{visibility:hidden!important}`,
  `[${REPLAY_MARKS.transparent}]{opacity:0!important}`,
  `[${REPLAY_MARKS.collapsed}]{width:0!important;height:0!important;min-width:0!important;min-height:0!important;padding:0!important;border:0!important;overflow:hidden!important}`,
].join('');

/**
 * The document a replay serves for a state: its recorded lines, the replay's style rule, and a
 * script of the replay's own that sets the data globals the script read on the page.
 */
export function replayDocument(lines: readonly string[], data: Record<string, unknown>): string {
  const globals = Object.entries(data)
    .map(
      ([name, value]) =>
        `window[${JSON.stringify(name)}]=${JSON.stringify(value).replaceAll('<', '\\u003c')};`,
    )
    .join('');
  const head =
    `<meta charset="utf-8"><style>${REPLAY_STYLE}</style>` +
    (globals === '' ? '' : `<script>${globals}</script>`);
  const html = lines.join('\n');
  // Right after the head's opening tag, so the globals are set before the body is parsed.
  const opened = /<head\b[^>]*>/.exec(html);
  const document =
    opened === null
      ? `${head}${html}`
      : `${html.slice(0, opened.index + opened[0].length)}${head}${html.slice(opened.index + opened[0].length)}`;
  return `<!DOCTYPE html>${document}`;
}
