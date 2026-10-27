/**
 * The pages of the fake Depop site (fake-depop-site.ts), as Depop serves them and as the page
 * modules read them (`../pages/`, read on Depop's live site in 2026-10): the documents, and the
 * small scripts that draw what Depop's own scripts draw once the document is ready (the header's
 * user menu, the sell form and its pickers, a shop's product links, the seller's Delete listing
 * on a product page). Test and development only; nothing in them leaves this machine.
 */
import { escape } from '../../fake-site/http.ts';
import { mappedDepopCategories, type DepopSizeKind } from '../categories.ts';
import { DEPOP_CONDITION_LABELS } from '../conditions.ts';
import type { FakeDepopProduct } from './fake-depop-site.ts';

/** The brands Depop's brand search offers (a sample of its list). */
export const FAKE_DEPOP_BRANDS = [
  "Levi's",
  'Nike',
  'adidas',
  'Carhartt',
  'Dr. Martens',
  'Patagonia',
  'Ralph Lauren',
  'Stüssy',
  'The North Face',
  'Urban Outfitters',
  'Zara',
  'Converse',
  'Vans',
  'Free People',
] as const;

/** What the brand search offers for a brand it doesn't list; the form takes it like any brand. */
export const FAKE_DEPOP_OTHER_BRAND = 'Other';

/** The shipping choices of the form. */
export const FAKE_DEPOP_SHIPPING = {
  depop_shipping: 'Depop Shipping',
  ship_yourself: 'Ship it yourself',
} as const;

/** The size list of each size kind, as the form's size picker offers it. */
export const FAKE_DEPOP_SIZES: Readonly<Record<Exclude<DepopSizeKind, 'none'>, readonly string[]>> =
  {
    clothing: [
      'XXS',
      'XS',
      'S',
      'M',
      'L',
      'XL',
      'XXL',
      'XXXL',
      'One size',
      'US 00',
      ...Array.from({ length: 25 }, (_, index) => `US ${String(index)}`),
      ...Array.from({ length: 27 }, (_, index) => `W${String(24 + index)}`),
    ],
    shoes: Array.from({ length: 21 }, (_, index) => {
      const size = 5 + index / 2;
      return `US ${Number.isInteger(size) ? String(size) : `${String(Math.floor(size))}.5`}`;
    }),
  };

/** Listora's department names as the category picker heads its groups ("Men > Tops"). */
const FORM_DEPARTMENTS: Readonly<Record<string, string>> = {
  Menswear: 'Men',
  Womenswear: 'Women',
  Kidswear: 'Kids',
};

/**
 * What Depop fills in from a new listing's photos before the seller does (read on a real
 * session, 2026-10-26): a brand, a condition, and a category it suggests.
 */
const ITEM_INFO = {
  brand: 'Nike',
  condition: DEPOP_CONDITION_LABELS.used_good,
  category: 'Womenswear > Tops > T-shirts',
} as const;

/** How long Depop's own scripts take to draw a part of a page after its document is ready. */
const DRAW_MS = 250;
/** A blank image (a transparent pixel), for the avatar and the shop's pictures. */
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
/** The size of the chunks the product page's data is streamed in (rows span chunks). */
const FLIGHT_CHUNK = 400;
/** How many of the seller's other products a product page shows. */
const MORE_FROM_SELLER = 4;

const STYLE = `<style>
body { font-family: system-ui, sans-serif; margin: 0; }
header nav { display: flex; gap: 16px; align-items: center; padding: 8px 16px; border-bottom: 1px solid #ddd; }
main { padding: 16px; max-width: 720px; }
.menu { display: var(--display, none); list-style: none; margin: 4px 0; padding: 0; border: 1px solid #ccc; }
.menu p { margin: 0; padding: 6px 8px; font-weight: 600; }
.menu li { padding: 6px 8px; cursor: pointer; }
#userNavItem-menu button { display: block; }
aside[role="dialog"] { position: fixed; top: 30%; left: 10%; right: 10%; background: #fff; border: 1px solid #333; padding: 16px; }
</style>`;

// Documents -----------------------------------------------------------------------------------

/**
 * A page as depop.com serves it: responsive (the app's sign-in page shows it at phone size). A
 * CAPTCHA fault puts its widget right after `<body>`.
 */
function documentOf(title: string, head: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>${STYLE}${head}</head><body>${body}</body></html>`;
}

/** A page without data or scripts. */
export function plainPage(title: string, body: string): string {
  return documentOf(title, '', body);
}

/**
 * A page that still embeds its data as `script#__NEXT_DATA__` (`props.pageProps`), as the
 * selling hub's lists do in the page modules (page-data.ts).
 */
export function nextDataPage(
  title: string,
  body: string,
  pageProps: Record<string, unknown>,
): string {
  const data = scriptJson({ props: { pageProps }, page: '/', buildId: 'fake' });
  return documentOf(
    title,
    '',
    `${body}<script id="__NEXT_DATA__" type="application/json">${data}</script>`,
  );
}

/**
 * One of Depop's App Router pages, as the signed-in `viewer` sees it: a header its scripts draw
 * (the Sell link and the user menu), the page's own content and script, and the data the page
 * streams as `self.__next_f.push([1, "<rows>"])` scripts (flight-data.ts).
 */
function appPage(
  title: string,
  viewer: string,
  main: string,
  extra: { head?: string; script?: string; rows?: readonly string[] } = {},
): string {
  const script = extra.script === undefined ? '' : `<script>${extra.script}</script>`;
  const rows = extra.rows === undefined ? '' : flightScripts(extra.rows);
  return documentOf(
    title,
    extra.head ?? '',
    `<header id="header" data-testid="header"></header>${main}${headerScript(viewer)}${script}${rows}`,
  );
}

/** The payload's rows as the server streams them: chunks of any size, one inline script each. */
function flightScripts(rows: readonly string[]): string {
  const stream = rows.map((row) => `${row}\n`).join('');
  const chunks: string[] = [];
  for (let start = 0; start < stream.length; start += FLIGHT_CHUNK) {
    chunks.push(stream.slice(start, start + FLIGHT_CHUNK));
  }
  return (
    '<script>(self.__next_f=self.__next_f||[]).push([0])</script>' +
    chunks.map((chunk) => `<script>self.__next_f.push(${scriptJson([1, chunk])})</script>`).join('')
  );
}

/**
 * The header, drawn by the page's script: the Sell link, and the user menu (read on the
 * captain's session, 2026-10-26), whose items are buttons that are only there while it is open.
 * "Your profile" opens the viewer's shop with the page's own navigation: the address changes,
 * and no page loads.
 */
function headerScript(viewer: string): string {
  const header =
    '<nav><a href="/products/create/">Sell</a>' +
    '<div data-testid="userNavItem-wrapper"><button type="button" id="userNavItem-button" aria-haspopup="menu" aria-expanded="false">' +
    `<img data-testid="avatar" alt="" width="32" height="32" src="${PIXEL}"></button>` +
    '<div id="userNavItem-menu" role="menu"></div></div></nav>';
  const items =
    '<button type="button" role="menuitem" data-testid="actionMenu__nav-profileLinkButton">Your profile</button>' +
    '<button type="button" role="menuitem" data-action="hub">Your selling hub</button>' +
    '<button type="button" role="menuitem">Purchases</button>' +
    '<button type="button" role="menuitem">Settings</button>' +
    '<button type="button" role="menuitem">Resolution Center</button>' +
    '<button type="button" role="menuitem">Log out</button>';
  return `<script>(() => {
  const viewer = ${scriptJson(viewer)};
  setTimeout(() => {
    document.getElementById('header').innerHTML = ${scriptJson(header)};
    const button = document.getElementById('userNavItem-button');
    const menu = document.getElementById('userNavItem-menu');
    button.addEventListener('click', () => {
      const open = menu.childElementCount === 0;
      button.setAttribute('aria-expanded', String(open));
      if (!open) {
        menu.replaceChildren();
        return;
      }
      menu.innerHTML = ${scriptJson(items)};
      menu.querySelector('[data-testid="actionMenu__nav-profileLinkButton"]').addEventListener('click', () => {
        menu.replaceChildren();
        history.pushState(null, '', '/' + encodeURIComponent(viewer) + '/');
        document.title = viewer + ' | Depop';
      });
      menu.querySelector('[data-action="hub"]').addEventListener('click', () => {
        location.assign('/sellinghub/');
      });
    });
  }, ${String(DRAW_MS)});
})();</script>`;
}

// Pages ---------------------------------------------------------------------------------------

/**
 * The selling hub's home as Depop serves it (read 2026-10-26): no page data, and the header its
 * scripts draw, with the signed-in user's avatar on the user menu's button.
 */
export function hubPage(viewer: string): string {
  return appPage(
    'Selling Hub - Depop',
    viewer,
    `<main><h1>Selling hub</h1><p data-testid="sellerUsername">${escape(viewer)}</p></main>`,
  );
}

/**
 * A seller's shop (`/<username>/`): their products for sale, newest first, as links to their
 * pages (an image and a price for each), drawn by the page's script a moment after the document.
 */
export function shopPage(
  username: string,
  viewer: string,
  products: readonly FakeDepopProduct[],
): string {
  const items = products
    .map((product) => {
      const href = `/products/${escape(product.slug)}/`;
      return `<li><a href="${href}"><img alt="" width="160" height="160" src="${PIXEL}"></a><a href="${href}">${dollars(product.priceCents)}</a></li>`;
    })
    .join('');
  return appPage(
    `${username} | Depop`,
    viewer,
    `<main><h1>${escape(username)}</h1><ul id="shop-products"></ul></main>`,
    {
      script: `setTimeout(() => { document.getElementById('shop-products').innerHTML = ${scriptJson(items)}; }, ${String(DRAW_MS)});`,
    },
  );
}

export interface ProductPageView {
  product: FakeDepopProduct;
  /** Depop's numeric id for the product. */
  id: number;
  /** The seller's other products for sale, which the page shows under the product. */
  others: readonly FakeDepopProduct[];
  /** The signed-in seller's username. */
  viewer: string;
  /** The site's origin, for the product's address in its schema.org data. */
  origin: string;
}

/**
 * A product's page (`/products/<slug>/`), as Depop's App Router serves it (product-page.ts):
 * its schema.org data with the price, and the rows of its payload, which hold the product as its
 * first query loaded it (`["product_basic_by_slug", slug]`: `slug`, `status`, `description`).
 * The rows also hold the seller's other products and a part of the page with the slug only, so
 * a read finds the product by what it is, not by its place. The seller's own page passes the
 * query's data on as a JSON string, and draws Edit listing and Delete listing for a product on
 * sale; Delete listing asks to confirm in a dialog.
 */
export function productPage(view: ProductPageView): string {
  const { product } = view;
  const own = product.seller === view.viewer;
  const url = `${view.origin}/products/${product.slug}/`;
  const structured = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: firstLine(product.description),
    description: product.description,
    image: product.photos.map((photo) => `${view.origin}/photos/${photo}`),
    ...(product.brand === null ? {} : { brand: { '@type': 'Brand', name: product.brand } }),
    offers: {
      '@type': 'Offer',
      url,
      price: priceAmount(product.priceCents),
      priceCurrency: 'USD',
      availability: AVAILABILITY[product.status],
    },
  };
  const query = (key: readonly unknown[], data: unknown) => ({
    queryKey: key,
    queryHash: JSON.stringify(key),
    state: { data, dataUpdateCount: 1, error: null, fetchStatus: 'idle', status: 'success' },
  });
  const record = {
    id: view.id,
    slug: product.slug,
    status: `STATUS_${product.status}`,
    description: product.description,
    price: { priceAmount: priceAmount(product.priceCents), currencyName: 'USD' },
    brandName: product.brand,
    sizes: product.size === null ? [] : [product.size],
    condition: product.condition,
    pictures: product.photos.map((photo) => ({ url: `${view.origin}/photos/${photo}` })),
    seller: { username: product.seller },
  };
  const dehydrated = {
    mutations: [],
    queries: [
      query(['product_basic_by_slug', product.slug], own ? JSON.stringify(record) : record),
      query(['products_by_seller', product.seller], {
        products: view.others.slice(0, MORE_FROM_SELLER).map((other) => ({
          slug: other.slug,
          status: `STATUS_${other.status}`,
          price: { priceAmount: priceAmount(other.priceCents), currencyName: 'USD' },
        })),
      }),
    ],
  };
  const description = product.description;
  const rows = [
    '1:"$Sreact.fragment"',
    '2:I[48211,["static/chunks/9214-fake.js","static/chunks/app/products/page-fake.js"],"HydrationBoundary"]',
    // A text row: its text runs over several lines, none of them a row.
    `3:T${Buffer.byteLength(description, 'utf8').toString(16)},${description}`,
    `4:${JSON.stringify(['$', '$L2', null, { state: dehydrated, children: '$3' }])}`,
    `0:${JSON.stringify({ b: 'fake', c: ['', 'products', product.slug, ''], share: { slug: product.slug, url }, f: '$4' })}`,
  ];
  const badge =
    product.status === 'SOLD'
      ? '<p data-testid="product__sold">Sold</p>'
      : product.status === 'DELETED'
        ? '<p data-testid="product__deleted">This item is no longer available.</p>'
        : '';
  const main = `<main>
${badge}
<p data-testid="product__price">${dollars(product.priceCents)}</p>
<p data-testid="product__description" style="white-space:pre-wrap">${escape(description)}</p>
<dl><dt>Size</dt><dd>${escape(product.size ?? '')}</dd><dt>Brand</dt><dd>${escape(product.brand ?? '')}</dd>
<dt>Condition</dt><dd>${escape(conditionLabel(product.condition))}</dd></dl>
<p data-testid="sellerUsername">${escape(product.seller)}</p>
<div id="seller-controls"></div>
</main>`;
  return appPage(`${firstLine(description)} | Depop`, view.viewer, main, {
    head: `<script type="application/ld+json" data-testid="meta__jsonLd">${scriptJson(structured)}</script>`,
    rows,
    ...(own && product.status === 'ONSALE' ? { script: sellerControls(product.slug) } : {}),
  });
}

/** The seller's own Edit listing and Delete listing, and Delete listing's dialog. */
function sellerControls(slug: string): string {
  const controls = `<a href="/products/edit/${escape(slug)}/">Edit listing</a> <button type="button">Delete listing</button>`;
  const dialog =
    '<p>Are you sure you want to delete this listing? You will lose all the likes.</p>' +
    '<button type="button" data-action="cancel">Cancel</button>' +
    `<form method="post" action="/products/edit/${escape(slug)}/delete"><button type="submit">Delete listing</button></form>`;
  return `setTimeout(() => {
  const controls = document.getElementById('seller-controls');
  controls.innerHTML = ${scriptJson(controls)};
  controls.querySelector('button').addEventListener('click', () => {
    if (document.querySelector('aside[role="dialog"]')) return;
    const dialog = document.createElement('aside');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = ${scriptJson(dialog)};
    dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => { dialog.remove(); });
    document.body.append(dialog);
  });
}, ${String(DRAW_MS)});`;
}

/** The page a deleted product answers with, status 410 (seen on Depop, 2026-10-27). */
export function gonePage(): string {
  return plainPage(
    'Depop',
    '<main data-testid="productGone"><h1>Sorry, this item is no longer available.</h1></main>',
  );
}

export function notFoundPage(): string {
  return plainPage(
    'Page not found | Depop',
    '<main data-testid="notFound"><h1>Sorry, we couldn’t find that page.</h1></main>',
  );
}

/** Depop's Done page after a Post (read 2026-10-26): it doesn't name the new listing. */
export function donePage(viewer: string): string {
  return appPage(
    'Done - Depop',
    viewer,
    '<main data-testid="listingDone"><h1>Your item is listed</h1><a href="/products/create/">List another item</a></main>',
  );
}

export interface ListingFormView {
  /** The product an edit page edits; `null` for the sell page. */
  product: FakeDepopProduct | null;
  /** The shipping choice a new listing starts with (the seller's own); `null` for none. */
  shipping: string | null;
  /** Depop's message after a submit it refused. */
  message: string | null;
  viewer: string;
}

/**
 * The listing form: the sell page (`/products/create/`), drawn by its script once the document
 * is ready and its photo input a moment later, or a listing's edit page, which has it in the
 * document. Its pickers are comboboxes (listing-form.ts): an input or a toggle button, and a
 * menu that keeps its options while closed and shows them through `--display: block`. The
 * category is searched for by product type, in groups headed by department and category; the
 * size list follows the product type; the brand search offers Depop's brands, with a clear
 * button once one is picked; the condition is a list. On the sell page, Depop fills in item info
 * from the photos and marks it. A submit without what the form needs marks those fields as
 * needing a fix and sends nothing; Depop's own checks answer the submit with the form and its
 * message.
 */
export function listingFormPage(view: ListingFormView): string {
  const { product } = view;
  const create = product === null;
  const shipping = product?.shipping ?? view.shipping;
  const shippingLabel =
    shipping === null
      ? 'Set up how you ship in your selling hub'
      : (FAKE_DEPOP_SHIPPING[shipping as keyof typeof FAKE_DEPOP_SHIPPING] as string | undefined) ??
        shipping;
  const action = create ? '/products/create/' : `/products/edit/${escape(product.slug)}/`;
  const form = `<form method="post" action="${action}" enctype="multipart/form-data" novalidate>
<section><h2>Photos</h2><div id="photos"></div><div id="item-info"></div></section>
<label for="description">Description</label>
<textarea id="description" name="description" rows="6">${escape(product?.description ?? '')}</textarea>
<div><label for="group-input">Category</label> <span id="group-value"></span>
<input id="group-input" role="combobox" aria-autocomplete="list" aria-controls="group-menu" autocomplete="off" placeholder="Search for a category">
<button type="button" id="group-toggle-button" aria-label="Categories">▾</button>
<ul id="group-menu" role="listbox" class="menu" style="--display: none"></ul>
<input type="hidden" name="category"></div>
<div><span id="variants-label">Size</span>
<button type="button" id="variants-toggle-button" aria-labelledby="variants-label">Size</button>
<ul id="variants-menu" role="listbox" class="menu" style="--display: none"></ul>
<input type="hidden" name="size"></div>
<div><label for="brand-input">Brand</label>
<input id="brand-input" role="combobox" aria-autocomplete="list" aria-controls="brand-menu" autocomplete="off" placeholder="Search for a brand">
<span id="brand-clear"></span>
<button type="button" id="brand-toggle-button" aria-label="Brands">▾</button>
<ul id="brand-menu" role="listbox" class="menu" style="--display: none"></ul>
<input type="hidden" name="brand"></div>
<div><span id="condition-label">Condition</span>
<button type="button" id="condition-toggle-button" aria-labelledby="condition-label">Condition</button>
<ul id="condition-menu" role="listbox" class="menu" style="--display: none"></ul>
<input type="hidden" name="condition"></div>
<label for="priceAmount__input">Price</label> $<input id="priceAmount__input" name="price" inputmode="decimal" value="${product === null ? '' : priceAmount(product.priceCents)}">
<p data-testid="shipping">Shipping: ${escape(shippingLabel)}</p>
<input type="hidden" name="shipping" value="${escape(shipping ?? '')}">
${create ? '<label><input type="checkbox" id="post-another" name="postAnother"> Post and add another</label>' : ''}
<button type="submit">${create ? 'Post' : 'Save'}</button>
</form>`;
  const current = {
    category: product?.category.join(' > ') ?? '',
    size: product?.size ?? '',
    brand: product?.brand ?? '',
    condition: product === null ? '' : conditionLabel(product.condition),
  };
  const message =
    view.message === null
      ? ''
      : `<p role="alert" data-testid="listingForm__error">${escape(view.message)}</p>`;
  return appPage(
    create ? 'Sell | Depop' : 'Edit listing | Depop',
    view.viewer,
    `<main><h1>${create ? 'Sell an item' : 'Edit listing'}</h1>${message}<div id="listing-form">${create ? '' : form}</div></main>`,
    { script: formScript(create, form, current) },
  );
}

/** The listing form's own script: it draws the sell form, and makes the pickers work. */
function formScript(
  create: boolean,
  form: string,
  current: { category: string; size: string; brand: string; condition: string },
): string {
  const tree = mappedDepopCategories().map((entry) => ({ path: entry.path, size: entry.size }));
  return `(() => {
  const create = ${String(create)};
  const tree = ${scriptJson(tree)};
  const sizes = ${scriptJson(FAKE_DEPOP_SIZES)};
  const brands = ${scriptJson(FAKE_DEPOP_BRANDS)};
  const other = ${scriptJson(FAKE_DEPOP_OTHER_BRAND)};
  const conditions = ${scriptJson(Object.entries(DEPOP_CONDITION_LABELS))};
  const departments = ${scriptJson(FORM_DEPARTMENTS)};
  const itemInfo = ${scriptJson(ITEM_INFO)};
  const current = ${scriptJson(current)};
  const wire = () => {
    const $ = (id) => document.getElementById(id);
    const form = document.querySelector('#listing-form form');
    const field = (name) => form.querySelector('[name="' + name + '"]');
    const setOpen = (name, open) => {
      $(name + '-menu').setAttribute('style', '--display: ' + (open ? 'block' : 'none'));
    };
    const isOpen = (name) => $(name + '-menu').getAttribute('style') === '--display: block';
    const option = (text, pick) => {
      const item = document.createElement('li');
      item.setAttribute('role', 'option');
      item.textContent = text;
      item.addEventListener('click', () => { pick(text); });
      return item;
    };
    const toggle = (name, render) => {
      $(name + '-toggle-button').addEventListener('click', () => {
        render();
        setOpen(name, !isOpen(name));
      });
    };

    // The size list of the picked product type.
    const leaf = () => tree.find((entry) => entry.path.join(' > ') === field('category').value);
    const pickSize = (label) => {
      field('size').value = label;
      $('variants-toggle-button').textContent = label || 'Size';
      setOpen('variants', false);
    };
    const renderSizes = () => {
      const entry = leaf();
      const labels = entry && entry.size !== 'none' ? sizes[entry.size] : [];
      $('variants-menu').replaceChildren(...labels.map((label) => option(label, pickSize)));
    };
    toggle('variants', () => undefined);

    // The category: product types searched for, in groups headed by department and category.
    const pickCategory = (entry) => {
      field('category').value = entry.path.join(' > ');
      $('group-value').textContent = entry.path.join(' > ');
      $('group-input').value = '';
      setOpen('group', false);
      pickSize('');
      renderSizes();
    };
    const renderGroups = () => {
      const typed = $('group-input').value.trim().toLowerCase();
      const groups = new Map();
      for (const entry of tree) {
        if (typed !== '' && !entry.path[2].toLowerCase().includes(typed)) continue;
        const heading = (departments[entry.path[0]] || entry.path[0]) + ' > ' + entry.path[1];
        groups.set(heading, [...(groups.get(heading) || []), entry]);
      }
      const shown = [...groups].map(([heading, entries]) => {
        const group = document.createElement('div');
        const head = document.createElement('div');
        const title = document.createElement('p');
        title.textContent = heading;
        head.append(title);
        group.append(head, ...entries.map((entry) => option(entry.path[2], () => { pickCategory(entry); })));
        return group;
      });
      if (shown.length === 0) {
        const none = document.createElement('li');
        none.textContent = 'No results';
        shown.push(none);
      }
      $('group-menu').replaceChildren(...shown);
    };
    $('group-input').addEventListener('input', () => {
      renderGroups();
      setOpen('group', true);
    });
    toggle('group', renderGroups);

    // The brand: a search of Depop's brands; only a pick sets it.
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.dataset.testid = 'brandButton__clear';
    clear.setAttribute('aria-label', 'Clear brand');
    clear.textContent = '×';
    clear.addEventListener('click', () => {
      field('brand').value = '';
      $('brand-input').value = '';
      $('brand-clear').replaceChildren();
    });
    const pickBrand = (name) => {
      field('brand').value = name;
      $('brand-input').value = name;
      $('brand-clear').replaceChildren(clear);
      setOpen('brand', false);
    };
    const renderBrands = () => {
      const typed = $('brand-input').value.trim().toLowerCase();
      const found = brands.filter((name) => name.toLowerCase().includes(typed));
      $('brand-menu').replaceChildren(...(found.length > 0 ? found : [other]).map((name) => option(name, pickBrand)));
    };
    $('brand-input').addEventListener('input', () => {
      if (field('brand').value !== '') {
        field('brand').value = '';
        $('brand-clear').replaceChildren();
      }
      renderBrands();
      setOpen('brand', $('brand-input').value.trim() !== '');
    });
    toggle('brand', renderBrands);

    // The condition.
    const pickCondition = (label) => {
      const found = conditions.find((entry) => entry[1] === label);
      field('condition').value = found ? found[0] : '';
      $('condition-toggle-button').textContent = label || 'Condition';
      setOpen('condition', false);
    };
    $('condition-menu').replaceChildren(...conditions.map((entry) => option(entry[1], pickCondition)));
    toggle('condition', () => undefined);

    // The photos; on the sell page Depop fills in item info from them, and says so.
    const drawPhotos = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'upload-input__input';
      input.name = 'photos';
      input.multiple = true;
      input.accept = 'image/jpeg';
      input.addEventListener('change', () => {
        if (!create || input.files.length === 0) return;
        setTimeout(() => {
          if (field('brand').value === '') pickBrand(itemInfo.brand);
          if (field('condition').value === '') pickCondition(itemInfo.condition);
          const suggested = tree.find((entry) => entry.path.join(' > ') === itemInfo.category);
          if (field('category').value === '' && suggested) pickCategory(suggested);
          const mark = document.createElement('p');
          mark.dataset.testid = 'Item info added';
          mark.textContent = 'Item info added';
          $('item-info').replaceChildren(mark);
        }, ${String(DRAW_MS)});
      });
      $('photos').append(input);
    };
    if (create) setTimeout(drawPhotos, ${String(DRAW_MS)});
    else drawPhotos();

    // What the form needs before it sends anything.
    form.addEventListener('submit', (event) => {
      const missing = [];
      if (field('description').value.trim() === '') missing.push($('description'));
      if (field('category').value === '') missing.push($('group-input'));
      const entry = leaf();
      if (entry && entry.size !== 'none' && field('size').value === '') missing.push($('variants-toggle-button'));
      if (field('condition').value === '') missing.push($('condition-toggle-button'));
      if (field('price').value.trim() === '') missing.push($('priceAmount__input'));
      const photos = $('upload-input__input');
      if (create && (!photos || photos.files.length === 0)) missing.push(photos || $('photos'));
      for (const element of missing) element.setAttribute('aria-invalid', 'true');
      if (missing.length > 0) event.preventDefault();
    });

    const picked = tree.find((entry) => entry.path.join(' > ') === current.category);
    if (picked) pickCategory(picked);
    renderSizes();
    if (current.size) pickSize(current.size);
    if (current.brand) pickBrand(current.brand);
    if (current.condition) pickCondition(current.condition);
  };
  if (create) {
    setTimeout(() => {
      document.getElementById('listing-form').innerHTML = ${scriptJson(form)};
      wire();
    }, ${String(DRAW_MS)});
  } else {
    wire();
  }
})();`;
}

export function sellingPage(rows: readonly FakeDepopProduct[]): string {
  const items = rows
    .map(
      (product) =>
        `<li><a href="/products/${escape(product.slug)}/">${escape(product.description.slice(0, 40))}</a> ${dollars(product.priceCents)}</li>`,
    )
    .join('');
  return `<main><h1>Selling</h1><ul data-testid="sellingList">${items}</ul></main>`;
}

export function soldItemsPage(rows: readonly FakeDepopProduct[]): string {
  const items = rows
    .map(
      (product) =>
        `<li><a href="/products/${escape(product.slug)}/">${escape(product.description.slice(0, 40))}</a> ${dollars(product.priceCents)} <span data-testid="buyerName">a buyer</span> <span data-testid="shippingAddress">1 Buyer Street</span></li>`,
    )
    .join('');
  return `<main><h1>Sold items</h1><ul data-testid="soldList">${items}</ul></main>`;
}

// Sign-in and checks --------------------------------------------------------------------------

/**
 * The sign-in page. Its email field is a text field: an `email` input keeps the app's sign-in web
 * view from going idle in the simulator while it has focus, which stretches every UI test step to
 * the framework's two-minute idle timeout (it made PhoneExecutionUITests time out on CI). Listora
 * never reads this form.
 */
export function loginPage(): string {
  return plainPage(
    'Log in | Depop',
    `<main><h1>Log in to Depop</h1><form method="post" action="/login/"><input name="username"><input name="password" type="password"><button type="submit">Log in</button></form><form method="post" action="/login/email-link/"><input name="email" placeholder="Email"><button type="submit">Email me a sign-in link</button></form></main>`,
  );
}

export function emailLinkSentPage(): string {
  return plainPage(
    'Check your email | Depop',
    `<main><h1>Check your email</h1><p>We emailed you a link to log in.</p></main>`,
  );
}

export function expiredLinkPage(): string {
  return plainPage(
    'Link expired | Depop',
    `<main><h1>This link has expired</h1><p>Ask for a new link to log in.</p></main>`,
  );
}

export function verifyPage(): string {
  return plainPage(
    'Check your email | Depop',
    `<main><h1>Check your email</h1><p>Enter the code we sent to your email.</p><input name="code" inputmode="numeric"><button type="submit">Continue</button></main>`,
  );
}

/** A bot-check block page (no frame or script: nothing leaves this machine). */
export function botCheckPage(): string {
  return plainPage(
    'depop.com',
    '<main><h1>Please verify you are a human</h1><p>Access to this page has been denied because we believe you are using automation tools.</p></main>',
  );
}

export function captchaWidget(): string {
  return `<div class="h-captcha" data-sitekey="fake-site-key" style="width:304px;height:78px;border:1px solid #ccc">I am human</div>`;
}

// Values --------------------------------------------------------------------------------------

/** schema.org's availability for each of Depop's product statuses. */
const AVAILABILITY: Readonly<Record<FakeDepopProduct['status'], string>> = {
  ONSALE: 'https://schema.org/InStock',
  SOLD: 'https://schema.org/SoldOut',
  DELETED: 'https://schema.org/Discontinued',
};

/** A price in dollars and cents, as Depop's data has it (`"45.00"`). */
export function priceAmount(cents: number): string {
  return `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function conditionLabel(condition: string): string {
  return (
    (DEPOP_CONDITION_LABELS[condition as keyof typeof DEPOP_CONDITION_LABELS] as
      | string
      | undefined) ?? condition
  );
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.slice(0, 80) ?? '';
}

/** JSON for an inline script: `<` escaped, so no value can close the script element. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}
