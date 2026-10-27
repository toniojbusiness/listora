/**
 * The page functions the phone runtime evaluates in the marketplace's page (through the app's
 * `evaluate`), one per page action. They do in the page what Playwright does for the browser
 * runner: wait for an element to be there and usable, then act on it the way a person's tap or
 * paste would (focus, the field's own value setter, the input and change events), and read
 * text and attributes. They are source text, so they run unchanged in WebKit and, in tests, in
 * Chromium; each is self-contained.
 *
 * A wait that runs out of time rejects with `element_timeout: <what>`; the backend reports it as
 * the page missing what the script expects.
 */

/** Helpers every function starts with. */
const PRELUDE = `
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const usable = (element) =>
    visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  const waitUntil = async (find, what) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const found = find();
      if (found) return found;
      if (Date.now() >= end) throw new Error('element_timeout: ' + what);
      await sleep(50);
    }
  };
  // Playwright's selector chains: 'A >> B' is B inside A's matches, 'A >> nth=1' A's second.
  const resolveAll = (selector) => {
    let current = [document];
    for (const part of selector.split(' >> ')) {
      const nth = /^nth=(-?\\d+)$/.exec(part.trim());
      if (nth) {
        const picked = current.at(Number(nth[1]));
        current = picked === undefined ? [] : [picked];
        continue;
      }
      // Playwright's ':text-is("...")': the element's whole text, whitespace collapsed.
      const textIs = /:text-is\\("((?:[^"\\\\]|\\\\.)*)"\\)$/.exec(part);
      const css = textIs === null ? part : part.slice(0, textIs.index);
      const wanted = textIs === null ? null : JSON.parse('"' + textIs[1] + '"');
      const next = [];
      for (const root of current) {
        for (const element of root.querySelectorAll(css)) {
          const text = (element.textContent || '').replace(/\\s+/g, ' ').trim();
          if (wanted !== null && text !== wanted) continue;
          if (!next.includes(element)) next.push(element);
        }
      }
      current = next;
    }
    return current.filter((node) => node !== document);
  };
  const first = (selector) => resolveAll(selector)[0] ?? null;
  // An action needs exactly one match, as Playwright's strict locators do.
  const only = (selector) => {
    const matches = resolveAll(selector);
    if (matches.length > 1) {
      throw new Error('strict mode violation: ' + selector + ' matches ' + matches.length + ' elements');
    }
    return matches[0] ?? null;
  };
  const usableElement = (selector) =>
    waitUntil(() => {
      const element = only(selector);
      return element && usable(element) ? element : null;
    }, 'a usable ' + selector);
  const nativeSet = (element, value) => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
    setter.call(element, value);
  };
  const fire = (element, type, init) =>
    element.dispatchEvent(
      type === 'input'
        ? new InputEvent('input', { bubbles: true, composed: true, ...init })
        : new Event(type, { bubbles: true, composed: true }),
    );
`;

function pageFunction(body: string): string {
  return `${PRELUDE}\n${body}`;
}

/** Clicks the first match once it is visible and enabled, like a tap. Args: selector, timeoutMs. */
export const CLICK = pageFunction(`
  const element = await usableElement(selector);
  element.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = element.getBoundingClientRect();
  const point = { bubbles: true, cancelable: true, composed: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
  element.dispatchEvent(new PointerEvent('pointerdown', { ...point, pointerType: 'touch', isPrimary: true }));
  element.dispatchEvent(new MouseEvent('mousedown', point));
  if (typeof element.focus === 'function') element.focus();
  element.dispatchEvent(new PointerEvent('pointerup', { ...point, pointerType: 'touch', isPrimary: true }));
  element.dispatchEvent(new MouseEvent('mouseup', point));
  element.click();
  return true;
`);

/** Puts the whole text into a field at once, like a paste. Args: selector, text, timeoutMs. */
export const FILL = pageFunction(`
  const element = await usableElement(selector);
  element.focus();
  if (element.isContentEditable) {
    element.textContent = text;
    fire(element, 'input', { inputType: 'insertFromPaste', data: text });
    return true;
  }
  if (!('value' in element) || element.readOnly) throw new Error('the element is not a text field');
  nativeSet(element, text);
  fire(element, 'input', { inputType: 'insertFromPaste', data: text });
  fire(element, 'change');
  return true;
`);

/** Focuses a field once it is usable. Args: selector, timeoutMs. */
export const FOCUS = pageFunction(`
  const element = await usableElement(selector);
  element.focus();
  return true;
`);

/** Types one character into the focused field. Args: character, timeoutMs. */
export const PRESS = pageFunction(`
  const element = document.activeElement;
  if (!element || element === document.body) throw new Error('no field has the focus');
  const key = { key: character, bubbles: true, cancelable: true, composed: true };
  element.dispatchEvent(new KeyboardEvent('keydown', key));
  element.dispatchEvent(new KeyboardEvent('keypress', key));
  if (element.isContentEditable) {
    element.textContent = (element.textContent || '') + character;
  } else {
    nativeSet(element, element.value + character);
  }
  fire(element, 'input', { inputType: 'insertText', data: character });
  element.dispatchEvent(new KeyboardEvent('keyup', key));
  return true;
`);

/** Chooses the option whose value (or label) is `value`. Args: selector, value, timeoutMs. */
export const SELECT = pageFunction(`
  const element = await usableElement(selector);
  if (!(element instanceof HTMLSelectElement)) throw new Error('the element is not a select');
  const option = await waitUntil(
    () => [...element.options].find((candidate) => candidate.value === value || candidate.label === value),
    'the option ' + value + ' in ' + selector,
  );
  nativeSet(element, option.value);
  fire(element, 'input', {});
  fire(element, 'change');
  return true;
`);

/** Sets a checkbox or radio. Args: selector, checked, timeoutMs. */
export const CHECK = pageFunction(`
  const element = await usableElement(selector);
  if (element.checked !== checked) element.click();
  if (element.checked !== checked) throw new Error('the checkbox did not change');
  return true;
`);

/**
 * Gives a file input its files (base64 bytes), as picking them would. The input may be hidden,
 * as sell forms' photo inputs usually are. Args: selector, files, timeoutMs.
 */
export const UPLOAD = pageFunction(`
  const element = await waitUntil(() => only(selector), 'the file input ' + selector);
  if (!(element instanceof HTMLInputElement) || element.type !== 'file') {
    throw new Error('the element is not a file input');
  }
  const transfer = new DataTransfer();
  for (const file of files) {
    const binary = atob(file.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    transfer.items.add(new File([bytes], file.name, { type: file.mimeType }));
  }
  element.files = transfer.files;
  fire(element, 'input', {});
  fire(element, 'change');
  return true;
`);

/** Waits for the first match to be attached, detached, visible, or hidden. Args: selector, state, timeoutMs. */
export const WAIT_FOR = pageFunction(`
  await waitUntil(() => {
    const element = first(selector);
    switch (state) {
      case 'attached': return element !== null;
      case 'detached': return element === null;
      case 'visible': return element !== null && visible(element);
      case 'hidden': return element === null || !visible(element);
      default: throw new Error('unknown state ' + state);
    }
  }, selector + ' to be ' + state);
  return true;
`);

/**
 * What a read asks for: `count`, `text` (first match), `texts`, `attribute`, `attributes`, and
 * `value` (the first match's current value, which a page's scripts may set without an attribute).
 */
export const QUERY = pageFunction(`
  const elements = resolveAll(selector);
  switch (what) {
    case 'count': return elements.length;
    case 'text': return elements.length === 0 ? null : (elements[0].textContent || '').trim();
    case 'texts': return elements.map((element) => (element.textContent || '').trim());
    case 'attribute': return elements.length === 0 ? null : elements[0].getAttribute(name);
    case 'attributes': return elements.map((element) => element.getAttribute(name));
    case 'value': return elements.length === 0 || typeof elements[0].value !== 'string' ? null : elements[0].value;
    default: throw new Error('unknown query ' + what);
  }
`);
