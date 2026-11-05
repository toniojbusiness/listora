/**
 * The fake Vinted site's listing pages (fake-vinted-site.ts): the upload form, its edit form,
 * and a listing's page as its seller sees it, as the Vinted page modules model them
 * (`pages/upload-form.ts`, `pages/item-page.ts`). Development and tests only; every category,
 * brand, and size here is invented or one the real form offered, never a seller's data.
 */

/** A category the fake's upload form offers, and the fields its form asks for. */
export interface FakeVintedCategory {
  path: readonly string[];
  /** The sizes its form lists, or none when it asks no size. */
  sizes: readonly string[];
  /** Whether its form asks a brand. */
  brand: boolean;
  /** Whether its form asks colours. */
  colors: boolean;
  /** The package size the form recommends, or none (the seller must pick). */
  packageSize: 'small' | 'medium' | 'large' | null;
}

/** The fake's categories: the conformance sample's, and one of each form shape the tests use. */
export const FAKE_VINTED_CATEGORIES: readonly FakeVintedCategory[] = [
  {
    path: ['Men', 'Clothing', 'Outerwear', 'Jackets', 'Denim jackets'],
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    brand: true,
    colors: true,
    packageSize: 'medium',
  },
  {
    path: ['Women', 'Clothing', 'Dresses', 'Mini-dresses'],
    sizes: ['XS / 0-2', 'S / 4-6', 'M / 8-10', 'L / 12-14'],
    brand: true,
    colors: true,
    packageSize: 'small',
  },
  {
    path: ['Women', 'Clothing', 'Skirts'],
    sizes: ['XS', 'S', 'M', 'L'],
    brand: true,
    colors: true,
    packageSize: null,
  },
  {
    path: ['Home', 'Decor', 'Vases'],
    sizes: [],
    brand: false,
    colors: false,
    packageSize: 'large',
  },
];

/** The brands the fake's brand search knows. */
export const FAKE_VINTED_BRANDS = ["Levi's", 'Nike', 'Zara', 'No brand'] as const;

/** Vinted's five conditions, as its form lists them. */
export const FAKE_VINTED_CONDITIONS = [
  'New with tags',
  'New without tags',
  'Very good',
  'Good',
  'Satisfactory',
] as const;

export const FAKE_VINTED_COLORS = [
  'Black',
  'Grey',
  'White',
  'Blue',
  'Navy',
  'Red',
  'Multi',
] as const;

/** What the upload form shows: empty for a new listing, or the listing's own on its edit page. */
export interface FormValues {
  title: string;
  description: string;
  category: readonly string[] | null;
  brand: string | null;
  size: string | null;
  condition: string | null;
  colors: readonly string[];
  packageSize: 'small' | 'medium' | 'large' | null;
  price: string;
}

export const EMPTY_FORM: FormValues = {
  title: '',
  description: '',
  category: null,
  brand: null,
  size: null,
  condition: null,
  colors: [],
  packageSize: null,
  price: '',
};

/**
 * The upload form (`action` is where Upload or Save posts), with Vinted's messages under the
 * fields it refused. Its lists are drawn by its script after a tap, as Vinted's are.
 */
export function uploadForm(options: {
  action: string;
  values: FormValues;
  editing: boolean;
  errors: readonly { field: string; message: string }[];
}): string {
  const config = {
    action: options.action,
    editing: options.editing,
    values: options.values,
    errors: options.errors,
    categories: FAKE_VINTED_CATEGORIES,
    brands: FAKE_VINTED_BRANDS,
    conditions: FAKE_VINTED_CONDITIONS,
    colors: FAKE_VINTED_COLORS,
  };
  return `<main><h1>${options.editing ? 'Edit listing' : 'Sell an item'}</h1><div id="upload"></div></main>
<script>
(() => {
  const config = ${scriptJson(config)};
  const state = JSON.parse(JSON.stringify(config.values));
  const root = document.getElementById('upload');
  const make = (tag, attributes, text) => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const named = (path) => path.join(' > ');
  const category = () => config.categories.find((one) => state.category && named(one.path) === named(state.category));
  const children = (path) => [...new Set(config.categories
    .filter((one) => one.path.length > path.length && path.every((name, index) => one.path[index] === name))
    .map((one) => one.path[path.length]))];
  const errorFor = (field) => {
    const found = config.errors.find((error) => error.field === field);
    return found ? make('p', { 'data-testid': field + '--validation-text' }, found.message) : null;
  };
  // A dropdown field: its input, and its list of rows, opened by a tap on the input.
  const dropdown = (name, label, rows, pick, options = {}) => {
    const wrap = make('div', { class: 'field' });
    const input = make('input', { 'data-testid': name + '-select-dropdown-input', placeholder: label, autocomplete: 'off' });
    if (!options.search) input.setAttribute('readonly', '');
    input.value = options.shown ? options.shown() : '';
    let list = null;
    const close = () => { if (list) { list.remove(); list = null; } };
    const open = (filter) => {
      close();
      list = make('div', { 'data-testid': name + '-select-dropdown-content', role: 'listbox' });
      for (const row of rows(filter)) {
        const cell = make('div', { class: 'cell', 'data-testid': name + '-row' });
        cell.append(make('span', {}, row));
        cell.addEventListener('click', () => {
          // A pick keeps the list open (colours), opens its next level (a category), or closes it.
          const next = pick(row);
          input.value = options.shown ? options.shown() : row;
          if (next === 'reopen') open('');
          else if (next !== 'keep') close();
        });
        list.append(cell);
      }
      wrap.append(list);
    };
    input.addEventListener('click', () => { if (list && !options.search) close(); else open(''); });
    if (options.search) input.addEventListener('input', () => open(input.value));
    wrap.append(input);
    const error = errorFor(name);
    if (error) wrap.append(error);
    return wrap;
  };
  const draw = () => {
    root.replaceChildren();
    if (!config.editing) {
      const photos = make('input', { type: 'file', multiple: '', accept: 'image/jpeg', 'data-testid': 'add-photos-input' });
      const shown = make('div', { id: 'photos' });
      photos.addEventListener('change', () => {
        shown.replaceChildren(...[...photos.files].map((file) => make('img', { 'data-testid': 'item-photo', alt: file.name, width: '40', height: '40' })));
      });
      root.append(make('label', {}, 'Photos '), photos, shown);
      const error = errorFor('photos');
      if (error) root.append(error);
    }
    const title = make('input', { 'data-testid': 'title--input', placeholder: 'Title' });
    title.value = state.title;
    title.addEventListener('input', () => { state.title = title.value; });
    const description = make('textarea', { 'data-testid': 'description--input', placeholder: 'Describe your item' });
    description.value = state.description;
    description.addEventListener('input', () => { state.description = description.value; });
    root.append(title, description);
    for (const field of ['title', 'description']) {
      const error = errorFor(field);
      if (error) root.append(error);
    }
    // Category: a list a level at a time, from the top each time it opens; a category without
    // subcategories closes it and draws the fields it asks for.
    let level = [];
    const categoryField = dropdown('catalog', 'Select a category', () => children(level), (row) => {
      level = [...level, row];
      // The next level replaces the list's rows.
      if (children(level).length > 0) return 'reopen';
      state.category = level;
      level = [];
      state.size = null;
      // Vinted asks for the category's fields once it is picked.
      setTimeout(drawAttributes, 50);
      return 'close';
    }, { shown: () => (state.category ? named(state.category) : '') });
    if (config.editing) categoryField.querySelector('input').setAttribute('disabled', '');
    root.append(categoryField);
    const attributes = make('div', { id: 'attributes' });
    root.append(attributes);
    const drawAttributes = () => {
      attributes.replaceChildren();
      const chosen = category();
      if (!chosen) return;
      if (chosen.brand) {
        attributes.append(dropdown('brand', 'Brand', (typed) => config.brands.filter((name) =>
          typed.trim() !== '' && name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(typed.toLowerCase().replace(/[^a-z0-9]/g, ''))),
          (row) => { state.brand = row; }, { search: true, shown: () => state.brand || '' }));
      }
      if (chosen.sizes.length > 0) {
        attributes.append(dropdown('size', 'Size', () => chosen.sizes, (row) => { state.size = row; }, { shown: () => state.size || '' }));
      }
      attributes.append(dropdown('status', 'Condition', () => config.conditions, (row) => { state.condition = row; }, { shown: () => state.condition || '' }));
      if (chosen.colors) {
        attributes.append(dropdown('color', 'Colour', () => config.colors, (row) => {
          state.colors = state.colors.includes(row) ? state.colors.filter((one) => one !== row) : [...state.colors, row].slice(0, 2);
          return 'keep';
        }, { shown: () => state.colors.join(', ') }));
      }
      const sizes = make('fieldset', {});
      sizes.append(make('legend', {}, 'Package size'));
      if (state.packageSize === null && chosen.packageSize !== null) state.packageSize = chosen.packageSize;
      for (const size of ['small', 'medium', 'large']) {
        const radio = make('input', { type: 'radio', name: 'package_size', value: size, 'data-testid': 'package-size--' + size });
        radio.checked = state.packageSize === size;
        radio.addEventListener('change', () => { state.packageSize = size; });
        const label = make('label', {}, ' ' + size);
        label.prepend(radio);
        sizes.append(label);
      }
      attributes.append(sizes);
    };
    drawAttributes();
    const price = make('input', { 'data-testid': 'price-input--input', inputmode: 'decimal', placeholder: '$0.00' });
    price.value = state.price;
    price.addEventListener('input', () => { state.price = price.value; });
    root.append(price);
    const priceError = errorFor('price');
    if (priceError) root.append(priceError);
    const save = make('button', { type: 'button', 'data-testid': 'upload-form-save-button' }, config.editing ? 'Save' : 'Upload');
    save.addEventListener('click', () => {
      const form = make('form', { method: 'post', action: config.action, enctype: 'multipart/form-data', hidden: '' });
      const fields = {
        title: state.title,
        description: state.description,
        category: state.category ? named(state.category) : '',
        brand: state.brand || '',
        size: state.size || '',
        condition: state.condition || '',
        colors: state.colors.join(','),
        package_size: state.packageSize || '',
        price: state.price,
      };
      for (const [name, value] of Object.entries(fields)) {
        const input = make('input', { type: 'hidden', name });
        input.value = value;
        form.append(input);
      }
      const photos = root.querySelector('[data-testid="add-photos-input"]');
      if (photos) {
        photos.name = 'photos';
        form.append(photos);
      }
      document.body.append(form);
      form.submit();
    });
    root.append(save);
  };
  setTimeout(draw, 30);
})();
</script>`;
}

/**
 * A listing's page as its seller sees it: the listing, and its seller's controls (Hide, or
 * Unhide for a hidden one); none while Vinted reviews it, or once it sold.
 */
export function itemPage(options: {
  id: string;
  title: string;
  state: 'active' | 'hidden' | 'reserved' | 'sold' | 'draft';
  inReview: boolean;
  /** Draw the page without its seller's controls, as after a redesign. */
  redesigned: boolean;
}): string {
  const { id } = options;
  const control =
    options.redesigned || options.inReview || options.state === 'sold' || options.state === 'draft'
      ? ''
      : options.state === 'hidden'
        ? `<form method="post" action="/items/${id}/unhide"><button type="submit" data-testid="item-unhide-button">Unhide</button></form>`
        : `<form method="post" action="/items/${id}/hide"><button type="submit" data-testid="item-hide-button">Hide</button></form>`;
  const notice = options.inReview
    ? '<p data-testid="item-review-notice">We’re reviewing your item. It will be visible to members once it’s approved.</p>'
    : '';
  return `<main><h1>${escape(options.title)}</h1>${notice}${control}<a href="/items/${id}/edit" data-testid="item-edit-button">Edit listing</a></main>`;
}

/** JSON for an inline script: `<` escaped, so no value can close the script element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

export function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
