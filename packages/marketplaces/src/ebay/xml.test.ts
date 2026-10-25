import { describe, expect, it } from 'vitest';

import {
  attribute,
  child,
  children,
  el,
  parseXml,
  text,
  texts,
  toXml,
  XmlParseError,
} from './xml.ts';

describe('Trading XML', () => {
  it('serializes elements in order, escaping text and attributes', () => {
    const xml = toXml(
      el('AddFixedPriceItemRequest', [
        el('Title', 'Levi\'s <jacket> & "more"'),
        el('StartPrice', '45.00', { currencyID: 'U"SD' }),
        null,
        el('PictureDetails', [el('PictureURL', 'https://a/1'), el('PictureURL', 'https://a/2')]),
      ]),
    );
    expect(xml).toBe(
      '<?xml version="1.0" encoding="utf-8"?><AddFixedPriceItemRequest>' +
        '<Title>Levi&apos;s &lt;jacket&gt; &amp; &quot;more&quot;</Title>' +
        '<StartPrice currencyID="U&quot;SD">45.00</StartPrice>' +
        '<PictureDetails><PictureURL>https://a/1</PictureURL><PictureURL>https://a/2</PictureURL></PictureDetails>' +
        '</AddFixedPriceItemRequest>',
    );
  });

  it('reads one and many repeated elements alike, keeping values as text', () => {
    const { name, node } = parseXml(
      '<?xml version="1.0"?><GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">' +
        '<Ack>Success</Ack><Item><ItemID>110012345678</ItemID>' +
        '<SellingStatus><CurrentPrice currencyID="USD">45.0</CurrentPrice></SellingStatus>' +
        '<PictureDetails><PictureURL>https://a/1</PictureURL></PictureDetails>' +
        '<Description>&lt;b&gt;Hi&lt;/b&gt;</Description></Item></GetItemResponse>',
    );
    expect(name).toBe('GetItemResponse');
    const item = child(node, 'Item');
    expect(text(item, 'ItemID')).toBe('110012345678');
    const price = child(child(item, 'SellingStatus'), 'CurrentPrice');
    expect(text(price, '#text')).toBe('45.0');
    expect(attribute(price, 'currencyID')).toBe('USD');
    expect(texts(child(item, 'PictureDetails'), 'PictureURL')).toEqual(['https://a/1']);
    expect(children(item, 'Missing')).toEqual([]);
    expect(text(item, 'Description')).toBe('<b>Hi</b>');
  });

  it('refuses a DOCTYPE and anything without one root', () => {
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>')).toThrow(XmlParseError);
    expect(() => parseXml('')).toThrow(XmlParseError);
    expect(() => parseXml('<a/><b/>')).toThrow(XmlParseError);
  });
});
