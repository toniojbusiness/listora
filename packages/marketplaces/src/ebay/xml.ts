/**
 * The little XML the eBay Trading API needs: building request documents and reading response
 * documents, shared by the adapter and the fake (fake/). Building is a tiny serializer, so the
 * bytes sent are exactly what the code says; reading goes through fast-xml-parser, with
 * accessors that treat one and many repeated elements alike (XML does not say which a name is).
 */
import { XMLParser } from 'fast-xml-parser';

/** The namespace of every Trading API request and response document. */
export const TRADING_NAMESPACE = 'urn:ebay:apis:eBLBaseComponents';

/** An element to serialize: text content, or child elements in order. */
export interface XmlElement {
  name: string;
  attributes?: Readonly<Record<string, string>>;
  content: string | readonly XmlElement[];
}

/** `<name attr="...">content</name>`; `null` and `undefined` children are left out. */
export function el(
  name: string,
  content: string | number | readonly (XmlElement | null | undefined)[],
  attributes?: Readonly<Record<string, string>>,
): XmlElement {
  const children =
    typeof content === 'string' || typeof content === 'number'
      ? String(content)
      : content.filter((child): child is XmlElement => child !== null && child !== undefined);
  return { name, content: children, ...(attributes === undefined ? {} : { attributes }) };
}

/** The document for a root element, with the XML declaration. */
export function toXml(root: XmlElement): string {
  return `<?xml version="1.0" encoding="utf-8"?>${serialize(root)}`;
}

function serialize(element: XmlElement): string {
  const attributes = Object.entries(element.attributes ?? {})
    .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
    .join('');
  const inner =
    typeof element.content === 'string'
      ? escapeXml(element.content)
      : element.content.map(serialize).join('');
  return `<${element.name}${attributes}>${inner}</${element.name}>`;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** A parsed element: child elements by name (one or many), attributes as `@_name`, text as `#text`. */
export interface XmlNode {
  readonly [key: string]: XmlValue;
}
export type XmlValue = string | XmlNode | readonly XmlValue[];

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlParseError';
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Values stay text: item ids such as 110012345678 and prices such as 45.00 must not become
  // numbers.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  removeNSPrefix: true,
  ignoreDeclaration: true,
});

/**
 * Parses a document and returns its root element's name and content. Throws `XmlParseError`
 * for anything without exactly one root element, and for any DOCTYPE (Trading documents never
 * have one, and refusing it rules out entity expansion attacks). The parser is lenient with a
 * truncated document, so callers check what they need is there (trading.ts requires a known
 * `Ack`).
 */
export function parseXml(text: string): { name: string; node: XmlNode } {
  if (/<!DOCTYPE/i.test(text)) throw new XmlParseError('a DOCTYPE is not allowed');
  let parsed: unknown;
  try {
    parsed = parser.parse(text);
  } catch (error) {
    throw new XmlParseError(error instanceof Error ? error.message : String(error));
  }
  if (typeof parsed !== 'object' || parsed === null) throw new XmlParseError('no root element');
  const entries = Object.entries(parsed as Record<string, unknown>);
  const [root] = entries;
  if (entries.length !== 1 || root === undefined) throw new XmlParseError('expected one root');
  const [name, value] = root;
  return { name, node: asNode(value) };
}

/** Every child element named `name`, in order (none, one, or many). */
export function children(node: XmlNode | undefined, name: string): XmlNode[] {
  const value = node?.[name];
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(asNode);
}

/** The first child element named `name`. */
export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return children(node, name)[0];
}

/** The text of the first child element named `name`, or `undefined` when there is none. */
export function text(node: XmlNode | undefined, name: string): string | undefined {
  const value = node?.[name];
  if (value === undefined) return undefined;
  const first = Array.isArray(value) ? (value as readonly XmlValue[])[0] : value;
  return first === undefined ? undefined : textOf(first);
}

/** The text of every child element named `name`. */
export function texts(node: XmlNode | undefined, name: string): string[] {
  const value = node?.[name];
  if (value === undefined) return [];
  return (Array.isArray(value) ? (value as readonly XmlValue[]) : [value]).map(textOf);
}

/** An attribute of an element. */
export function attribute(node: XmlNode | undefined, name: string): string | undefined {
  const value = node?.[`@_${name}`];
  return typeof value === 'string' ? value : undefined;
}

function textOf(value: XmlValue): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return '';
  const inner = (value as XmlNode)['#text'];
  return typeof inner === 'string' ? inner : '';
}

/** An element with only text parses as a string; this gives every element the same shape. */
function asNode(value: unknown): XmlNode {
  if (typeof value === 'string') return value === '' ? {} : { '#text': value };
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as XmlNode;
  }
  return {};
}
