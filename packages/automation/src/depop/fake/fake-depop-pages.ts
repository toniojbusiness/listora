/**
 * The pages of the fake Depop site (fake-depop-site.ts), as Depop serves them and as the page
 * modules read them (`../pages/`, read on Depop's live site in 2026-10): the documents, and the
 * small scripts that draw what Depop's own scripts draw once the document is ready (the header's
 * user menu, the sell form and its pickers, a shop's product links, the seller's Delete listing
 * on a product page). Test and development only; nothing in them leaves this machine.
 */
import { escape } from '../../fake-site/http.ts';
import { allDepopCategories } from '../categories.ts';
import { DEPOP_CONDITION_LABELS } from '../conditions.ts';
import { depopAttribute } from '../taxonomy/taxonomy.ts';
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

/** The colours and materials the form's pickers offer (Depop's own, from its taxonomy). */
const COLOURS = depopAttribute('colour')?.values.map((value) => value.name) ?? [];
const MATERIALS = depopAttribute('material')?.values.map((value) => value.name) ?? [];

/**
 * The category tree the form offers: every product type Depop has (its taxonomy), by the form's
 * names, with its size list and whether it offers a material.
 */
export function fakeDepopTree(): { path: string[]; sizes: string[]; material: boolean }[] {
  return allDepopCategories().map((entry) => ({
    path: [...entry.path],
    sizes: [...entry.sizes],
    material: entry.attributes.includes('material'),
  }));
}

/**
 * What the fake fills in from a new listing's photos before the seller does. On a real session
 * (2026-10-26) Depop filled in a brand, a condition, and a category it suggested; these values
 * are the fake's own.
 */
const ITEM_INFO = {
  brand: 'Nike',
  condition: DEPOP_CONDITION_LABELS.used_good,
  category: 'Women > Tops > T-shirts',
  colour: 'Blue',
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
  /** Whether "Boost your listing" starts on. */
  boosted?: boolean;
}

/**
 * The listing form: the sell page (`/products/create/`), drawn by its script once the document
 * is ready and its photo input a moment later, or a listing's edit page, which has it in the
 * document. Its pickers are comboboxes as Depop draws them (listing-form.ts): an input that
 * shows what is picked, a toggle button, and a menu that keeps its options while closed and
 * shows them through `--display: block`. The category is searched for by product type or
 * category, in groups headed by department and category (every product type in Depop's
 * taxonomy), with a clear button once one is picked; the size list follows the product type;
 * the brand search offers Depop's brands; the condition is a list; the colours and the material
 * take several values, each shown with its own "Remove <value>" button. Photos show as added a
 * moment after they are picked, and on the sell page Depop then fills in item info from them,
 * only where a field is still empty, and marks it. "Boost your listing" is a switch, off unless
 * `boosted`. A submit without what the form needs marks those fields as needing a fix and sends
 * nothing; one before the photos are added gets Depop's message; Depop's own checks answer the
 * submit with the form and its message.
 */
export function listingFormPage(view: ListingFormView): string {
  const { product } = view;
  const create = product === null;
  const shipping = product?.shipping ?? view.shipping;
  const shippingLabel =
    shipping === null
      ? 'Set up how you ship in your selling hub'
      : (labelOf(FAKE_DEPOP_SHIPPING, shipping) ?? shipping);
  const action = create ? '/products/create/' : `/products/edit/${escape(product.slug)}/`;
  const picker = (name: string, label: string, field: string) =>
    `<div><label for="${name}-input">${label}</label>
<div class="select"><span class="picked" id="${name}-picked"></span><input id="${name}-input" role="combobox" aria-autocomplete="list" aria-controls="${name}-menu" autocomplete="off" value=""></div>
<span id="${name}-clear"></span>
<button type="button" id="${name}-toggle-button" aria-label="toggle menu">▾</button>
<ul id="${name}-menu" role="listbox" class="menu" style="--display: none"></ul>
<input type="hidden" name="${field}"></div>`;
  const form = `<form method="post" action="${action}" enctype="multipart/form-data" novalidate>
<section><h2>Photos</h2><div id="photos"></div><div id="previews"></div><div id="item-info"></div></section>
<label for="description">Description</label>
<textarea id="description" name="description" rows="6">${escape(product?.description ?? '')}</textarea>
${picker('group', 'Category', 'category')}
<div id="material-field" hidden>${picker('attributes.material', 'Material', 'material')}</div>
<div id="size-field" hidden>${picker('variants', 'Size', 'size')}</div>
${picker('brand', 'Brand', 'brand')}
${picker('condition', 'Condition', 'condition')}
${picker('colour', 'Color', 'colour')}
<label for="priceAmount__input">Item price</label> $<input id="priceAmount__input" name="price" inputmode="decimal" value="${product === null ? '' : priceAmount(product.priceCents)}">
<section><h2>Boost your listing</h2><label><input type="checkbox" data-testid="switch" name="boost"${view.boosted === true ? ' checked' : ''}> Promote your item in search to help it sell faster. Pay an extra 12% fee, only if you sell.</label></section>
<p data-testid="shipping">Shipping: ${escape(shippingLabel)}</p>
<input type="hidden" name="shipping" value="${escape(shipping ?? '')}">
${create ? '<label><input type="checkbox" id="post-another" name="postAnother"> Post and add another</label>' : ''}
<button type="submit">${create ? 'Post' : 'Save changes'}</button>
</form>`;
  const current = {
    category: product?.category.join(' > ') ?? '',
    size: product?.size ?? '',
    brand: product?.brand ?? '',
    condition: product === null ? '' : conditionLabel(product.condition),
    colours: product?.colours ?? [],
    materials: product?.materials ?? [],
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
  current: {
    category: string;
    size: string;
    brand: string;
    condition: string;
    colours: readonly string[];
    materials: readonly string[];
  },
): string {
  return `(() => {
  const create = ${String(create)};
  const tree = ${scriptJson(fakeDepopTree())};
  const brands = ${scriptJson(FAKE_DEPOP_BRANDS)};
  const other = ${scriptJson(FAKE_DEPOP_OTHER_BRAND)};
  const conditions = ${scriptJson(Object.entries(DEPOP_CONDITION_LABELS))};
  const colours = ${scriptJson(COLOURS)};
  const materials = ${scriptJson(MATERIALS)};
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
    const clearButton = (name, onClear) => {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.dataset.testid = name + 'Button__clear';
      clear.setAttribute('aria-label', 'clear the selected value');
      clear.textContent = '×';
      clear.addEventListener('click', onClear);
      return clear;
    };
    // A single-value picker: its input shows the pick.
    const single = (name, fieldName) => (label) => {
      field(fieldName).value = label;
      $(name + '-input').value = label;
      setOpen(name, false);
    };
    // A multi-value picker: each pick shows with its own Remove button, and its option takes no
    // more clicks.
    const multi = (name, fieldName, max, labels) => {
      const picked = [];
      const render = () => {
        field(fieldName).value = picked.join('|');
        $(name + '-picked').replaceChildren(...picked.map((label) => {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.setAttribute('aria-label', 'Remove ' + label);
          remove.textContent = label + ' ✕';
          remove.addEventListener('click', () => {
            picked.splice(picked.indexOf(label), 1);
            render();
          });
          return remove;
        }));
        $(name + '-menu').replaceChildren(...labels.map((label) => {
          const item = option(label, (text) => {
            if (picked.includes(text) || picked.length >= max) return;
            picked.push(text);
            render();
          });
          if (picked.includes(label)) {
            item.setAttribute('aria-disabled', 'true');
            item.style.display = 'none';
          }
          return item;
        }));
      };
      render();
      toggle(name, () => undefined);
      return { add: (label) => { if (!picked.includes(label)) { picked.push(label); render(); } }, picked, render };
    };

    // The size list and material of the picked product type.
    const leaf = () => tree.find((entry) => entry.path.join(' > ') === field('category').value);
    const pickSize = single('variants', 'size');
    const renderSizes = () => {
      const entry = leaf();
      const labels = entry ? entry.sizes : [];
      $('size-field').hidden = labels.length === 0;
      $('variants-menu').replaceChildren(...labels.map((label) => option(label, pickSize)));
    };
    toggle('variants', () => undefined);
    const material = multi('attributes.material', 'material', 4, materials);

    // The category: product types and categories searched for, in groups headed by department
    // and category.
    const setCategory = (entry) => {
      field('category').value = entry ? entry.path.join(' > ') : '';
      $('group-input').value = entry ? entry.path[2] : '';
      $('group-clear').replaceChildren(...(entry ? [clearButton('group', () => { setCategory(null); })] : []));
      setOpen('group', false);
      pickSize('');
      $('variants-input').value = '';
      renderSizes();
      $('material-field').hidden = !(entry && entry.material);
    };
    const renderGroups = () => {
      const typed = $('group-input').value.trim().toLowerCase();
      const groups = new Map();
      for (const entry of tree) {
        if (typed !== '' && !entry.path[2].toLowerCase().includes(typed) && !entry.path[1].toLowerCase().includes(typed)) continue;
        const heading = entry.path[0] + ' > ' + entry.path[1];
        groups.set(heading, [...(groups.get(heading) || []), entry]);
      }
      const shown = [...groups].map(([heading, entries]) => {
        const group = document.createElement('div');
        const head = document.createElement('div');
        const title = document.createElement('p');
        title.textContent = heading;
        head.append(title);
        group.append(head, ...entries.map((entry) => option(entry.path[2], () => { setCategory(entry); })));
        return group;
      });
      if (shown.length === 0) {
        const none = document.createElement('p');
        none.textContent = 'No option';
        shown.push(none);
      }
      $('group-menu').replaceChildren(...shown);
    };
    $('group-input').addEventListener('input', () => {
      if (field('category').value !== '') setCategory(null);
      renderGroups();
      setOpen('group', true);
    });
    toggle('group', renderGroups);

    // The brand: a search of Depop's brands; only a pick sets it.
    const setBrand = single('brand', 'brand');
    const pickBrand = (name) => {
      setBrand(name);
      $('brand-clear').replaceChildren(clearButton('brand', () => {
        field('brand').value = '';
        $('brand-input').value = '';
        $('brand-clear').replaceChildren();
      }));
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
      $('condition-input').value = found ? label : '';
      setOpen('condition', false);
    };
    $('condition-menu').replaceChildren(...conditions.map((entry) => option(entry[1], pickCondition)));
    toggle('condition', () => undefined);

    const colour = multi('colour', 'colour', 2, colours);

    // The photos: shown as added once Depop has them; on the sell page Depop then fills in item
    // info from them where a field is still empty, and says so.
    let added = !create;
    const drawPhotos = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'upload-input__input';
      input.name = 'photos';
      input.multiple = true;
      input.accept = 'image/jpeg';
      input.addEventListener('change', () => {
        if (!create || input.files.length === 0) return;
        added = false;
        setTimeout(() => {
          $('previews').replaceChildren(...[...input.files].map(() => {
            const preview = document.createElement('div');
            preview.setAttribute('role', 'button');
            const image = document.createElement('img');
            image.src = '/photos/preview.jpg';
            preview.append(image);
            return preview;
          }));
          added = true;
          if (field('brand').value === '') pickBrand(itemInfo.brand);
          if (field('condition').value === '') pickCondition(itemInfo.condition);
          if (colour.picked.length === 0) colour.add(itemInfo.colour);
          const suggested = tree.find((entry) => entry.path.join(' > ') === itemInfo.category);
          if (field('category').value === '' && suggested) setCategory(suggested);
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
      if (entry && entry.sizes.length > 0 && field('size').value === '') missing.push($('variants-input'));
      if (field('condition').value === '') missing.push($('condition-input'));
      if (field('price').value.trim() === '') missing.push($('priceAmount__input'));
      const photos = $('upload-input__input');
      if (create && (!photos || photos.files.length === 0)) missing.push(photos || $('photos'));
      for (const element of missing) element.setAttribute('aria-invalid', 'true');
      if (missing.length > 0) {
        event.preventDefault();
        return;
      }
      if (!added) {
        // Depop's own answer to a Post before its photos are in.
        event.preventDefault();
        const alert = document.createElement('p');
        alert.setAttribute('role', 'alert');
        alert.textContent = 'Please insert at least one image';
        form.prepend(alert);
      }
    });

    const picked = tree.find((entry) => entry.path.join(' > ') === current.category);
    if (picked) setCategory(picked);
    if (current.size) pickSize(current.size);
    if (current.brand) pickBrand(current.brand);
    if (current.condition) pickCondition(current.condition);
    for (const label of current.colours) colour.add(label);
    for (const label of current.materials) material.add(label);
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

/** One sale, as the seller's sold items list it. */
export interface FakeDepopSale {
  /** Depop's id for the purchase, which its receipt's address names. */
  purchaseId: number;
  soldAt: Date;
}

/** The note a seller without sales sees on their sold items page. */
export const FAKE_DEPOP_NO_SALES =
  "Once you've made a sale, you'll be able to see your receipt here.";

/**
 * The seller's sold items (`/sellinghub/sold-items/`), as Depop's App Router page draws them
 * after the document (read on the seller's own session, 2026-10-27, sold-items-page.ts): one row
 * per sale, newest first, a link to its receipt (`/sellinghub/sold-items/<purchase id>/`, no
 * product slug) with the buyer, where it ships, and when it sold; or, for a seller without
 * sales, a note.
 */
export function soldItemsPage(viewer: string, sales: readonly FakeDepopSale[]): string {
  const rows = sales
    .map(
      (sale) =>
        `<li><a href="/sellinghub/sold-items/${String(sale.purchaseId)}/"><span data-testid="buyerName">a buyer</span> <span data-testid="shippingAddress">1 Buyer Street</span> <time datetime="${sale.soldAt.toISOString()}">${escape(sale.soldAt.toDateString())}</time></a></li>`,
    )
    .join('');
  const list =
    sales.length === 0
      ? `<p>${escape(FAKE_DEPOP_NO_SALES)}</p>`
      : `<ul data-testid="soldList">${rows}</ul>`;
  return appPage(
    'Sold items - Depop',
    viewer,
    '<main><h1>Sold items</h1><div id="sold-items"></div></main>',
    {
      script: `setTimeout(() => { document.getElementById('sold-items').innerHTML = ${scriptJson(list)}; }, ${String(DRAW_MS)});`,
    },
  );
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
  return labelOf(DEPOP_CONDITION_LABELS, condition) ?? condition;
}

/** The label a table of choices has for `value`, if it has one. */
function labelOf(labels: Readonly<Record<string, string>>, value: string): string | undefined {
  return labels[value];
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.slice(0, 80) ?? '';
}

/** JSON for an inline script: `<` escaped, so no value can close the script element. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}
