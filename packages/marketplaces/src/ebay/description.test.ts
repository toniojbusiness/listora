import { describe, expect, it } from 'vitest';

import { descriptionHtml, descriptionText } from './description.ts';

describe('eBay descriptions', () => {
  it('reads back exactly the text it sent, whatever the text holds', () => {
    const texts = [
      'Plain.',
      'Two\nlines',
      'Blank\n\nline between',
      'Symbols & <tags> "quotes" \'apostrophes\' > arrows',
      'Literal <br> stays text',
      'Entities stay literal: &amp; &#39; &lt;',
      'Unicode: café, 😀, ½',
    ];
    for (const text of texts) expect(descriptionText(descriptionHtml(text)), text).toBe(text);
  });

  it('sends line breaks as <br> and escapes HTML', () => {
    expect(descriptionHtml('A & B\n<i>C</i>')).toBe('A &amp; B<br>&lt;i&gt;C&lt;/i&gt;');
  });

  it('reads HTML eBay holds as text', () => {
    expect(descriptionText('<p>Soft <b>cotton</b></p>Line<br/>two&nbsp;&#169;&#x263A;')).toBe(
      'Soft cottonLine\ntwo\u00a0©☺',
    );
  });
});
