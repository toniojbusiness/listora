/**
 * The fake eBay's Trading API: the calls Listora makes (AddFixedPriceItem,
 * VerifyAddFixedPriceItem, ReviseFixedPriceItem, EndFixedPriceItem, RelistFixedPriceItem,
 * GetItem, GetSellerList), with eBay's documented validation, error codes, and messages
 * (README.md lists the pages). Responses are Trading XML documents, `Ack` `Failure` with an
 * `Errors` container when eBay would refuse the call.
 */
import { TRADING_COMPATIBILITY_LEVEL, type TradingCallName } from '../trading.ts';
import { TRADING_ERRORS } from '../trading-errors.ts';
import {
  attribute,
  child,
  children,
  el,
  text,
  texts,
  toXml,
  TRADING_NAMESPACE,
  type XmlElement,
  type XmlNode,
} from '../xml.ts';
import type { FakeEbayListing, FakeItemSpecific, FakeSeller } from './state.ts';
import { fakeCategory, type FakeCategory } from './taxonomy.ts';

/** What the Trading handlers need from the fake. */
export interface TradingStore {
  now(): Date;
  listings: FakeEbayListing[];
  /** The listing before its latest change, for stale reads, and when that change was. */
  previous: Map<string, FakeEbayListing>;
  changedAt: Map<string, number>;
  /** How long after a change a stale read can still show the listing before it. */
  staleReadWindowMs: number;
  /** Listings eBay no longer has (GetItem answers 17). */
  removed: Set<string>;
  /** UUIDs that created or relisted a listing, with that listing's id. */
  uuids: Map<string, string>;
  nextItemId(): string;
  /** EPS URLs the fake's Media API issued. */
  epsUrls: Set<string>;
  /** Accept http picture URLs (local development serves photos over http). */
  allowHttpPictures: boolean;
  viewItemUrl(itemId: string): string;
}

export class TradingFailure extends Error {
  readonly code: string;
  readonly shortMessage: string;
  readonly classification: 'RequestError' | 'SystemError';
  readonly parameters: readonly string[];

  constructor(
    code: string,
    shortMessage: string,
    longMessage: string,
    options: { classification?: 'RequestError' | 'SystemError'; parameters?: string[] } = {},
  ) {
    super(longMessage);
    this.code = code;
    this.shortMessage = shortMessage;
    this.classification = options.classification ?? 'RequestError';
    this.parameters = options.parameters ?? [];
  }
}

const invalid = (tag: string): TradingFailure =>
  new TradingFailure(
    TRADING_ERRORS.invalidInput,
    'Input data is invalid.',
    `Input data for tag <${tag}> is invalid or missing. Please check API documentation.`,
    { parameters: [tag] },
  );

const notAccessible = (): TradingFailure =>
  new TradingFailure(
    TRADING_ERRORS.itemNotAccessible,
    'Item cannot be accessed.',
    'This item cannot be accessed because the listing has been deleted or you are not the seller.',
  );

/** A Trading response document for a call. */
export function tradingResponse(
  callName: TradingCallName,
  now: Date,
  fields: readonly (XmlElement | null | undefined)[],
  failure?: TradingFailure,
): string {
  const errors =
    failure === undefined
      ? []
      : [
          el('Errors', [
            el('ShortMessage', failure.shortMessage),
            el('LongMessage', failure.message),
            el('ErrorCode', failure.code),
            el('SeverityCode', 'Error'),
            ...failure.parameters.map((value, index) =>
              el('ErrorParameters', [el('Value', value)], { ParamID: String(index) }),
            ),
            el('ErrorClassification', failure.classification),
          ]),
        ];
  return toXml(
    el(
      `${callName}Response`,
      [
        el('Timestamp', now.toISOString()),
        el('Ack', failure === undefined ? 'Success' : 'Failure'),
        ...errors,
        el('Version', TRADING_COMPATIBILITY_LEVEL),
        el('Build', `E${TRADING_COMPATIBILITY_LEVEL}_FAKE`),
        ...(failure === undefined ? fields : []),
      ],
      { xmlns: TRADING_NAMESPACE },
    ),
  );
}

/** Runs one call for a seller; throws `TradingFailure` when eBay would refuse it. */
export function runTradingCall(
  store: TradingStore,
  seller: FakeSeller,
  callName: TradingCallName,
  request: XmlNode,
): (XmlElement | null)[] {
  switch (callName) {
    case 'AddFixedPriceItem':
      return addItem(store, seller, request);
    case 'VerifyAddFixedPriceItem':
      return verifyItem(store, seller, request);
    case 'ReviseFixedPriceItem':
      return reviseItem(store, seller, request);
    case 'EndFixedPriceItem':
      return endItem(store, seller, request);
    case 'RelistFixedPriceItem':
      return relistItem(store, seller, request);
    case 'GetItem':
      return getItem(store, seller, request, false);
    case 'GetSellerList':
      return getSellerList(store, seller, request);
  }
}

/** GetItem served from the listing as it was before its latest change (eventual consistency). */
export function runStaleGetItem(
  store: TradingStore,
  seller: FakeSeller,
  request: XmlNode,
): (XmlElement | null)[] {
  return getItem(store, seller, request, true);
}

// Add and Verify ---------------------------------------------------------------------------

interface ListingFields {
  title: string;
  description: string;
  categoryId: string;
  conditionId: number;
  conditionDescription: string | null;
  price: string;
  currency: string;
  quantity: number;
  pictureUrls: string[];
  itemSpecifics: FakeItemSpecific[];
  sku: string | null;
  trackedBySku: boolean;
  uuid: string | null;
  postalCode: string | null;
  dispatchTimeMax: number | null;
  sellerProfiles: FakeEbayListing['sellerProfiles'];
}

function addItem(store: TradingStore, seller: FakeSeller, request: XmlNode): (XmlElement | null)[] {
  const item = child(request, 'Item');
  const fields = newListingFields(store, seller, item);
  if (fields.uuid !== null) {
    const existing = store.uuids.get(fields.uuid);
    if (existing !== undefined) throw duplicateUuid(existing);
  }
  if (fields.trackedBySku && fields.sku !== null) {
    const active = store.listings.find(
      (listing) =>
        listing.sellerUserId === seller.userId &&
        listing.sku === fields.sku &&
        listing.status === 'Active',
    );
    if (active !== undefined) {
      throw new TradingFailure(
        TRADING_ERRORS.duplicateActiveSku,
        `Item with SKU number: ${fields.sku} is currently active on site.`,
        "You can't have two active items with the same SKU number at the same time. Please use a different SKU number.",
      );
    }
  }
  const listing = createListing(store, seller, fields);
  return [
    el('ItemID', listing.itemId),
    el('StartTime', listing.startTime),
    el('EndTime', listing.endTime),
    fees(),
    listing.sku === null ? null : el('SKU', listing.sku),
  ];
}

function verifyItem(
  store: TradingStore,
  seller: FakeSeller,
  request: XmlNode,
): (XmlElement | null)[] {
  const fields = newListingFields(store, seller, child(request, 'Item'));
  return [el('ItemID', '0'), fees(), fields.sku === null ? null : el('SKU', fields.sku)];
}

function newListingFields(
  store: TradingStore,
  seller: FakeSeller,
  item: XmlNode | undefined,
): ListingFields {
  if (item === undefined) throw invalid('Item');
  if (text(item, 'ListingType') !== 'FixedPriceItem') throw invalid('Item.ListingType');
  if (text(item, 'Country') !== 'US') throw invalid('Item.Country');
  if (text(item, 'Currency') !== 'USD') throw invalid('Item.Currency');
  const title = validTitle(text(item, 'Title'));
  const description = validDescription(text(item, 'Description'));
  const category = validCategory(text(child(item, 'PrimaryCategory'), 'CategoryID'));
  const conditionId = validCondition(category, text(item, 'ConditionID'));
  const { price, currency } = validPrice(child(item, 'StartPrice'));
  const pictureUrls = validPictures(store, child(item, 'PictureDetails'));
  const itemSpecifics = validItemSpecifics(category, child(item, 'ItemSpecifics'));
  const { sku, trackedBySku } = validSku(item);
  const uuid = validUuid(text(item, 'UUID'));
  const postalCode = text(item, 'PostalCode') ?? null;
  if (postalCode === null && text(item, 'Location') === undefined) throw invalid('Item.PostalCode');
  const sellerProfiles = validSellerProfiles(seller, child(item, 'SellerProfiles'));
  const dispatch = text(item, 'DispatchTimeMax');
  if (sellerProfiles === null) {
    if (child(item, 'ShippingDetails') === undefined) throw invalid('Item.ShippingDetails');
    if (child(item, 'ReturnPolicy') === undefined) throw invalid('Item.ReturnPolicy');
    if (dispatch === undefined) throw invalid('Item.DispatchTimeMax');
  }
  const quantity = Number(text(item, 'Quantity') ?? '1');
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw invalid('Item.Quantity');
  const conditionDescription = text(item, 'ConditionDescription') ?? null;
  if (conditionDescription !== null && conditionDescription.length > 1000) {
    throw invalid('Item.ConditionDescription');
  }
  return {
    title,
    description,
    categoryId: category.categoryId,
    conditionId,
    conditionDescription: conditionId >= 1500 ? conditionDescription : null,
    price,
    currency,
    quantity,
    pictureUrls,
    itemSpecifics,
    sku,
    trackedBySku,
    uuid,
    postalCode,
    dispatchTimeMax: dispatch === undefined ? null : Number(dispatch),
    sellerProfiles,
  };
}

function createListing(
  store: TradingStore,
  seller: FakeSeller,
  fields: ListingFields,
): FakeEbayListing {
  const now = store.now();
  const listing: FakeEbayListing = {
    itemId: store.nextItemId(),
    sellerUserId: seller.userId,
    sku: fields.sku,
    trackedBySku: fields.trackedBySku,
    uuid: fields.uuid,
    title: fields.title,
    description: fields.description,
    categoryId: fields.categoryId,
    conditionId: fields.conditionId,
    conditionDescription: fields.conditionDescription,
    price: fields.price,
    currency: fields.currency,
    quantity: fields.quantity,
    quantitySold: 0,
    pictureUrls: fields.pictureUrls,
    itemSpecifics: fields.itemSpecifics,
    postalCode: fields.postalCode,
    dispatchTimeMax: fields.dispatchTimeMax,
    sellerProfiles: fields.sellerProfiles,
    status: 'Active',
    startTime: now.toISOString(),
    // GTC listings show an end time one month ahead.
    endTime: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    endingReason: null,
    relistedItemId: null,
    revised: false,
  };
  store.listings.push(listing);
  if (fields.uuid !== null) store.uuids.set(fields.uuid, listing.itemId);
  return listing;
}

// Revise, End, Relist ----------------------------------------------------------------------

function reviseItem(
  store: TradingStore,
  seller: FakeSeller,
  request: XmlNode,
): (XmlElement | null)[] {
  const item = child(request, 'Item');
  if (item === undefined) throw invalid('Item');
  const listing = findForChange(store, seller, text(item, 'ItemID'), text(item, 'SKU'));
  if (listing.status !== 'Active') {
    throw new TradingFailure(
      TRADING_ERRORS.revisedEnded,
      'Auction ended.',
      'You are not allowed to revise ended listings.',
    );
  }
  if (listing.trackedBySku && text(item, 'InventoryTrackingMethod') !== 'SKU') {
    throw invalid('Item.InventoryTrackingMethod');
  }
  const changes: Partial<FakeEbayListing> = {};
  const title = text(item, 'Title');
  if (title !== undefined) changes.title = validTitle(title);
  const description = text(item, 'Description');
  if (description !== undefined) changes.description = validDescription(description);
  const categoryId = text(child(item, 'PrimaryCategory'), 'CategoryID');
  const category = validCategory(categoryId ?? listing.categoryId);
  if (categoryId !== undefined) changes.categoryId = category.categoryId;
  const conditionId = text(item, 'ConditionID');
  if (conditionId !== undefined) changes.conditionId = validCondition(category, conditionId);
  const conditionDescription = text(item, 'ConditionDescription');
  if (conditionDescription !== undefined) changes.conditionDescription = conditionDescription;
  const startPrice = child(item, 'StartPrice');
  if (startPrice !== undefined) Object.assign(changes, validPrice(startPrice));
  const pictures = child(item, 'PictureDetails');
  if (pictures !== undefined) changes.pictureUrls = validPictures(store, pictures);
  const specifics = child(item, 'ItemSpecifics');
  if (specifics !== undefined) changes.itemSpecifics = validItemSpecifics(category, specifics);
  change(store, listing, { ...changes, revised: true });
  return [
    el('ItemID', listing.itemId),
    el('StartTime', listing.startTime),
    el('EndTime', listing.endTime),
    fees(),
    listing.sku === null ? null : el('SKU', listing.sku),
  ];
}

function endItem(store: TradingStore, seller: FakeSeller, request: XmlNode): (XmlElement | null)[] {
  const reason = text(request, 'EndingReason');
  const allowed = ['Incorrect', 'LostOrBroken', 'NotAvailable', 'OtherListingError'];
  if (reason === undefined || !allowed.includes(reason)) throw invalid('EndingReason');
  const listing = findForChange(store, seller, text(request, 'ItemID'), text(request, 'SKU'));
  if (listing.status !== 'Active') {
    throw new TradingFailure(
      TRADING_ERRORS.alreadyClosed,
      'The auction has been closed.',
      'The auction has already been closed.',
    );
  }
  const endTime = store.now().toISOString();
  change(store, listing, { status: 'Ended', endTime, endingReason: reason });
  return [el('EndTime', endTime), listing.sku === null ? null : el('SKU', listing.sku)];
}

function relistItem(
  store: TradingStore,
  seller: FakeSeller,
  request: XmlNode,
): (XmlElement | null)[] {
  const item = child(request, 'Item');
  const itemId = text(item, 'ItemID');
  if (item === undefined || itemId === undefined) throw invalid('Item.ItemID');
  const uuid = validUuid(text(item, 'UUID'));
  if (uuid !== null) {
    const existing = store.uuids.get(uuid);
    if (existing !== undefined) throw duplicateUuid(existing);
  }
  const original = store.listings.find(
    (listing) => listing.itemId === itemId && listing.sellerUserId === seller.userId,
  );
  const ninetyDays = 90 * 24 * 60 * 60 * 1000;
  if (
    original === undefined ||
    original.status === 'Active' ||
    store.now().getTime() - Date.parse(original.endTime) > ninetyDays
  ) {
    throw new TradingFailure(
      TRADING_ERRORS.cannotRelist,
      'Item cannot be relisted.',
      'This item was not relisted because the listing does not exist or is still active.',
    );
  }
  const relisted = createListing(store, seller, {
    ...original,
    sku: original.sku,
    uuid,
  });
  change(store, original, { relistedItemId: relisted.itemId });
  return [
    el('ItemID', relisted.itemId),
    el('StartTime', relisted.startTime),
    el('EndTime', relisted.endTime),
    fees(),
    relisted.sku === null ? null : el('SKU', relisted.sku),
  ];
}

/** The seller's listing named by ItemID (or, for SKU-tracked listings, SKU). */
function findForChange(
  store: TradingStore,
  seller: FakeSeller,
  itemId: string | undefined,
  sku: string | undefined,
): FakeEbayListing {
  if (itemId !== undefined) {
    if (!/^\d+$/.test(itemId)) throw invalid('ItemID');
    const listing = store.listings.find(
      (candidate) => candidate.itemId === itemId && candidate.sellerUserId === seller.userId,
    );
    if (listing === undefined) throw notAccessible();
    return listing;
  }
  if (sku !== undefined) {
    const listing = latestBySku(store, seller, sku, true);
    if (listing === undefined) {
      throw new TradingFailure(
        TRADING_ERRORS.noActiveSku,
        'Could not find an active item for the given SKU number.',
        'Could not find an active item for the given SKU number.',
      );
    }
    return listing;
  }
  throw invalid('ItemID');
}

function change(store: TradingStore, listing: FakeEbayListing, changes: Partial<FakeEbayListing>) {
  store.previous.set(listing.itemId, { ...listing });
  store.changedAt.set(listing.itemId, store.now().getTime());
  Object.assign(listing, changes);
}

// GetItem and GetSellerList ------------------------------------------------------------------

function getItem(
  store: TradingStore,
  seller: FakeSeller,
  request: XmlNode,
  stale: boolean,
): (XmlElement | null)[] {
  const itemId = text(request, 'ItemID');
  const sku = text(request, 'SKU');
  let listing: FakeEbayListing | undefined;
  if (itemId !== undefined) {
    if (!/^\d+$/.test(itemId)) throw invalid('ItemID');
    listing = store.listings.find(
      (candidate) => candidate.itemId === itemId && candidate.sellerUserId === seller.userId,
    );
  } else if (sku !== undefined) {
    listing = latestBySku(store, seller, sku, false);
  } else {
    throw invalid('ItemID');
  }
  if (listing === undefined) throw notAccessible();
  // Eventual consistency: for a while after a change, a read may still show the listing as it
  // was before it.
  const changedAt = store.changedAt.get(listing.itemId) ?? Number.NEGATIVE_INFINITY;
  const recent = store.now().getTime() - changedAt < store.staleReadWindowMs;
  const served = stale && recent ? (store.previous.get(listing.itemId) ?? listing) : listing;
  const detail = text(request, 'DetailLevel');
  const withDescription = detail === 'ReturnAll' || detail === 'ItemReturnDescription';
  const withSpecifics = text(request, 'IncludeItemSpecifics') === 'true';
  return [itemElement(store, served, { withDescription, withSpecifics })];
}

/** A SKU-tracked listing for a SKU: the active one, else the newest. */
function latestBySku(
  store: TradingStore,
  seller: FakeSeller,
  sku: string,
  activeOnly: boolean,
): FakeEbayListing | undefined {
  const matching = store.listings.filter(
    (listing) =>
      listing.sellerUserId === seller.userId && listing.trackedBySku && listing.sku === sku,
  );
  const active = matching.find((listing) => listing.status === 'Active');
  if (active !== undefined || activeOnly) return active;
  return matching.at(-1);
}

function getSellerList(
  store: TradingStore,
  seller: FakeSeller,
  request: XmlNode,
): (XmlElement | null)[] {
  const range = (from: string, to: string): [number, number] | undefined => {
    const start = text(request, from);
    const end = text(request, to);
    if (start === undefined && end === undefined) return undefined;
    const startMs = Date.parse(start ?? '');
    const endMs = Date.parse(end ?? '');
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw invalid(to);
    }
    if (endMs - startMs >= 120 * 24 * 60 * 60 * 1000) throw invalid(to);
    return [startMs, endMs];
  };
  const startRange = range('StartTimeFrom', 'StartTimeTo');
  const endRange = range('EndTimeFrom', 'EndTimeTo');
  if (startRange === undefined && endRange === undefined) throw invalid('EndTimeFrom');
  const pagination = child(request, 'Pagination');
  const perPage = Number(text(pagination, 'EntriesPerPage') ?? '');
  if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > 200) {
    throw invalid('Pagination.EntriesPerPage');
  }
  const page = Number(text(pagination, 'PageNumber') ?? '1');
  if (!Number.isSafeInteger(page) || page < 1) throw invalid('Pagination.PageNumber');
  const skus = texts(child(request, 'SKUArray'), 'SKU');
  const within = (time: string, bounds: [number, number] | undefined): boolean => {
    if (bounds === undefined) return true;
    const ms = Date.parse(time);
    return ms >= bounds[0] && ms <= bounds[1];
  };
  const matching = store.listings.filter(
    (listing) =>
      listing.sellerUserId === seller.userId &&
      within(listing.startTime, startRange) &&
      within(listing.endTime, endRange) &&
      (skus.length === 0 || (listing.sku !== null && skus.includes(listing.sku))),
  );
  const pages = Math.ceil(matching.length / perPage);
  const slice = matching.slice((page - 1) * perPage, page * perPage);
  const detail = text(request, 'DetailLevel') === 'ReturnAll';
  return [
    el('PaginationResult', [
      el('TotalNumberOfPages', pages),
      el('TotalNumberOfEntries', matching.length),
    ]),
    el('HasMoreItems', page < pages ? 'true' : 'false'),
    el(
      'ItemArray',
      slice.map((listing) =>
        itemElement(store, listing, { withDescription: detail, withSpecifics: false }),
      ),
    ),
    el('ItemsPerPage', perPage),
    el('PageNumber', page),
    el('ReturnedItemCountActual', slice.length),
  ];
}

function itemElement(
  store: TradingStore,
  listing: FakeEbayListing,
  options: { withDescription: boolean; withSpecifics: boolean },
): XmlElement {
  const category = fakeCategory(listing.categoryId);
  return el('Item', [
    el('Country', 'US'),
    el('Currency', listing.currency),
    options.withDescription ? el('Description', listing.description) : null,
    el('ItemID', listing.itemId),
    el('ListingDetails', [
      el('StartTime', listing.startTime),
      el('EndTime', listing.endTime),
      el('ViewItemURL', store.viewItemUrl(listing.itemId)),
      listing.relistedItemId === null ? null : el('RelistedItemID', listing.relistedItemId),
      listing.endingReason === null ? null : el('EndingReason', listing.endingReason),
    ]),
    el('ListingDuration', 'GTC'),
    el('ListingType', 'FixedPriceItem'),
    el('PrimaryCategory', [
      el('CategoryID', listing.categoryId),
      el(
        'CategoryName',
        [...(category?.ancestors ?? []).toReversed(), category?.categoryName ?? ''].join(':'),
      ),
    ]),
    el('Quantity', listing.quantity),
    el('ReviseStatus', [el('ItemRevised', listing.revised ? 'true' : 'false')]),
    el('SellingStatus', [
      el('CurrentPrice', listing.price, { currencyID: listing.currency }),
      el('QuantitySold', listing.quantitySold),
      el('ListingStatus', listing.status),
    ]),
    el('Title', listing.title),
    listing.sku === null ? null : el('SKU', listing.sku),
    listing.trackedBySku ? el('InventoryTrackingMethod', 'SKU') : null,
    el(
      'PictureDetails',
      listing.pictureUrls.map((url) => el('PictureURL', url)),
    ),
    el('ConditionID', listing.conditionId),
    listing.conditionDescription === null
      ? null
      : el('ConditionDescription', listing.conditionDescription),
    options.withSpecifics
      ? el(
          'ItemSpecifics',
          listing.itemSpecifics.map((specific) =>
            el('NameValueList', [
              el('Name', specific.name),
              ...specific.values.map((value) => el('Value', value)),
            ]),
          ),
        )
      : null,
  ]);
}

// Field rules --------------------------------------------------------------------------------

function validTitle(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new TradingFailure('69', 'Empty Title.', 'You must enter a title for your item.');
  }
  if (value.length > 80) {
    throw new TradingFailure(
      TRADING_ERRORS.titleTooLong,
      'Title too long.',
      'Listing titles are limited to 80 characters.',
      { parameters: ['80'] },
    );
  }
  return value;
}

function validDescription(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new TradingFailure('106', 'Description is missing.', 'A description is required.');
  }
  if (value.length > 500_000) {
    throw new TradingFailure(
      '10073',
      'The length of the description has exceeded the maximum limit.',
      'The length of the description has exceeded the maximum limit.',
    );
  }
  return value;
}

function validCategory(categoryId: string | undefined): FakeCategory {
  const category = categoryId === undefined ? undefined : fakeCategory(categoryId);
  if (category === undefined) {
    throw new TradingFailure(
      TRADING_ERRORS.invalidCategory,
      'Category is not valid.',
      'The category is not valid, select another category.',
    );
  }
  return category;
}

function validCondition(category: FakeCategory, value: string | undefined): number {
  if (value === undefined) {
    throw new TradingFailure(
      TRADING_ERRORS.conditionRequired,
      'Item condition required',
      'Item condition is required for this category. Please provide a supported condition value.',
    );
  }
  const conditionId = Number(value);
  if (!category.conditionIds.includes(conditionId)) {
    throw new TradingFailure(
      '21916883',
      'Invalid condition id',
      'The provided condition id is invalid for the selected primary category id.',
    );
  }
  return conditionId;
}

function validPrice(node: XmlNode | undefined): { price: string; currency: string } {
  const value = text(node, '#text') ?? (typeof node === 'object' ? undefined : undefined);
  const amount = Number(value);
  if (
    node === undefined ||
    value === undefined ||
    !/^\d+(\.\d{1,2})?$/.test(value) ||
    amount <= 0
  ) {
    throw invalid('Item.StartPrice');
  }
  const currency = attribute(node, 'currencyID') ?? 'USD';
  if (currency !== 'USD') throw invalid('Item.StartPrice.currencyID');
  // eBay echoes amounts as doubles: 45.00 comes back as 45.0.
  return { price: String(amount).includes('.') ? String(amount) : `${String(amount)}.0`, currency };
}

function validPictures(store: TradingStore, node: XmlNode | undefined): string[] {
  const urls = texts(node, 'PictureURL');
  if (urls.length === 0) {
    throw new TradingFailure(
      TRADING_ERRORS.photoRequired,
      'Add at least 1 photo.',
      'Add at least 1 photo.',
    );
  }
  if (urls.length > 24) throw invalid('Item.PictureDetails.PictureURL');
  const scheme = store.allowHttpPictures ? /^https?:\/\/\S+$/ : /^https:\/\/\S+$/;
  if (urls.some((url) => !scheme.test(url) || url.length > 500)) {
    throw invalid('Item.PictureDetails.PictureURL');
  }
  if (urls.join('').length > 3975) throw invalid('Item.PictureDetails.PictureURL');
  const eps = urls.filter((url) => store.epsUrls.has(url)).length;
  // "these URLs cannot be mixed between self-hosted and EPS-hosted"
  if (eps !== 0 && eps !== urls.length) throw invalid('Item.PictureDetails.PictureURL');
  return urls;
}

function validItemSpecifics(category: FakeCategory, node: XmlNode | undefined): FakeItemSpecific[] {
  const lists = children(node, 'NameValueList');
  if (lists.length > 45) throw invalid('Item.ItemSpecifics');
  const specifics = lists.map((list) => ({
    name: text(list, 'Name') ?? '',
    values: texts(list, 'Value'),
  }));
  for (const specific of specifics) {
    if (specific.name === '' || specific.values.length === 0) throw invalid('Item.ItemSpecifics');
    if (specific.name.length > 65) {
      throw new TradingFailure(
        TRADING_ERRORS.itemSpecificTooLong,
        `The value ${specific.name} for Name is too long.`,
        `The value ${specific.name} for Name is too long. Enter a value with a maximum of 65 characters.`,
      );
    }
    if (specific.values.length > 30) {
      throw new TradingFailure(
        '21919305',
        `${specific.name} has too many values.`,
        `${specific.name} has too many values.`,
      );
    }
    for (const value of specific.values) {
      if (value.length > 65) {
        throw new TradingFailure(
          TRADING_ERRORS.itemSpecificTooLong,
          `The value ${value} for ${specific.name} is too long.`,
          `The value ${value} for ${specific.name} is too long. Enter a value with a maximum of 65 characters.`,
        );
      }
    }
  }
  for (const aspect of category.aspects) {
    const given = specifics.find(
      (specific) => specific.name.toLowerCase() === aspect.name.toLowerCase(),
    );
    if (given === undefined) {
      if (!aspect.required) continue;
      throw new TradingFailure(
        TRADING_ERRORS.itemSpecificMissing,
        `The item specific ${aspect.name} is missing.`,
        `The item specific ${aspect.name} is missing. Add ${aspect.name} to this listing, enter a valid value, and then try again.`,
      );
    }
    if (aspect.mode !== 'SELECTION_ONLY') continue;
    const bad = given.values.find((value) => !aspect.values.includes(value));
    if (bad !== undefined) {
      throw new TradingFailure(
        '21916520',
        `Invalid value for Item Specifics. "${aspect.name}"`,
        `The value "${bad}" provided for Item Specific "${aspect.name}" is not valid.`,
      );
    }
  }
  return specifics;
}

function validSku(item: XmlNode): { sku: string | null; trackedBySku: boolean } {
  const sku = text(item, 'SKU') ?? null;
  if (sku !== null && sku.length > 50) {
    throw new TradingFailure('21671', 'SKU too long.', 'SKU is limited to 50 characters.');
  }
  const method = text(item, 'InventoryTrackingMethod');
  if (method !== undefined && method !== 'SKU' && method !== 'ItemID') {
    throw invalid('Item.InventoryTrackingMethod');
  }
  const trackedBySku = method === 'SKU';
  if (trackedBySku && sku === null) throw invalid('Item.SKU');
  return { sku, trackedBySku };
}

function validUuid(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!/^[0-9A-Fa-f]{32}$/.test(value)) {
    throw new TradingFailure(
      TRADING_ERRORS.invalidUuid,
      'Invalid UUID length or content.',
      'The UUID can only contain Numbers and Letters from A to F and must be 32 characters long.',
    );
  }
  return value.toUpperCase();
}

function duplicateUuid(itemId: string): TradingFailure {
  return new TradingFailure(
    TRADING_ERRORS.duplicateUuid,
    'Duplicate UUID used.',
    `The specified UUID has already been used; isFromSameApplication=true, item ID=${itemId}.`,
    { parameters: ['true', itemId] },
  );
}

function validSellerProfiles(
  seller: FakeSeller,
  node: XmlNode | undefined,
): FakeEbayListing['sellerProfiles'] {
  if (node === undefined) return null;
  const shipping = text(child(node, 'SellerShippingProfile'), 'ShippingProfileID');
  const payment = text(child(node, 'SellerPaymentProfile'), 'PaymentProfileID');
  const returns = text(child(node, 'SellerReturnProfile'), 'ReturnProfileID');
  if (shipping !== seller.policies.shipping) {
    throw new TradingFailure(
      '21917327',
      'Invalid shipping policy.',
      "You've provided an invalid shipping policy.",
    );
  }
  if (payment !== seller.policies.payment) {
    throw new TradingFailure(
      '21917328',
      'Invalid payment policy.',
      "You've provided an invalid payment policy.",
    );
  }
  if (returns !== seller.policies.return) {
    throw new TradingFailure(
      '21917329',
      'Invalid return policy.',
      "You've provided an invalid return policy.",
    );
  }
  return { shipping, payment, return: returns };
}

function fees(): XmlElement {
  return el('Fees', [
    el('Fee', [el('Name', 'InsertionFee'), el('Fee', '0.0', { currencyID: 'USD' })]),
    el('Fee', [el('Name', 'ListingFee'), el('Fee', '0.0', { currencyID: 'USD' })]),
  ]);
}
