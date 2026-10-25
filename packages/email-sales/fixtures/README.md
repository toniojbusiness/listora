# Sale email fixtures

Synthetic messages, written by hand to the shape Listora expects of each marketplace's sold
notice until real samples are checked (the open item in `docs/features/email-sales.md`). None is
a real email, and none holds real people's data. Each file is the message as the marketplace
sends it; tests add the receiving server's `Delivered-To` and `Authentication-Results` headers
(`deliver` in `src/test-support.ts`), as SES or a dropped file would carry them.

| File                        | What it is                                                     |
| --------------------------- | -------------------------------------------------------------- |
| `poshmark-sold.eml`         | Poshmark's sold notice: HTML and text, a listing link, a price |
| `mercari-sold.eml`          | Mercari's sold notice: text only, an item link, a price        |
| `depop-sold.eml`            | Depop's sold notice: HTML only, a product link, a price        |
| `poshmark-sold-no-link.eml` | A Poshmark sold notice that names the item only by its title   |
| `mercari-sold-sku.eml`      | A Mercari sold notice with Listora's SKU in the item's title   |
| `poshmark-offer.eml`        | A Poshmark offer notice: not a sale                            |
| `depop-sold-new-format.eml` | A Depop sold notice in a format the parser does not know       |
| `gmail-forwarding.eml`      | Gmail's forwarding confirmation, with its code and link        |
