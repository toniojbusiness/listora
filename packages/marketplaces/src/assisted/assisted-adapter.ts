/**
 * The assisted adapter base (docs/architecture.md section 4): where Listora can't act on a
 * marketplace itself (Poshmark, Mercari, and Depop until the browser runner or Depop's partner
 * API takes over, and whenever automation has to stop), Listora prepares the work and the user
 * does the final step in the marketplace's own app.
 *
 * `execute` never talks to the marketplace. It returns `pendingUser` with a user task: a deep
 * link and a copy-assist payload (title, description, price, photos in posting order). The
 * engine records the task with the operation's `needs_user_action` status, and only the user's
 * confirmation can finish the operation: assisted capabilities establish success by
 * `user_confirm`, `readListing` always throws, and the engine never counts a read-back for an
 * assisted operation. Status labels then say "you confirmed", never "confirmed by" the
 * marketplace.
 */
import type { JsonObject, Marketplace, UserTaskKind } from '@listora/db';
import { assertNever, type CurrencyCode } from '@listora/shared';

import {
  MARKETPLACE_NAMES,
  type Health,
  type MarketplaceAdapter,
  type MarketplaceCapabilities,
  type OperationRequest,
  type Outcome,
  type RemoteListingState,
  type ValidationIssue,
  type WriteOperationKind,
} from '../adapter.ts';
import { CAPABILITY_FOR_KIND, operationMode, unsupportedMessage } from '../capabilities.ts';
import {
  isContentKind,
  photosInOrder,
  type ItemSnapshot,
  type ListingVariant,
} from '../content.ts';

/** What the user copies into the marketplace app for a new or changed listing. */
export interface AssistedListingPayload extends JsonObject {
  title: string;
  description: string;
  price: { amountCents: number; currency: CurrencyCode };
  /** In posting order, the cover first; the app saves them to the camera roll in this order. */
  photos: { photoId: string; url: string }[];
}

/** The flags an assisted marketplace may set; how success is established is not one of them. */
export type AssistedCapabilityOverrides = Partial<
  Omit<MarketplaceCapabilities, 'connect' | 'verifyRead' | 'readFreshness'>
>;

export interface AssistedAdapterOptions {
  marketplace: Marketplace;
  /**
   * The marketplace's site, where a task without a better place opens (a new listing, or a
   * listing whose page is unknown). A listing URL counts only on this site's domain.
   */
  siteUrl: string;
  /** Flags that differ from the assisted defaults; a write mode may not be `api` or `automation`. */
  capabilities?: AssistedCapabilityOverrides;
  /** The marketplace's own limits, checked before a task is created. */
  limits?: { titleMaxLength?: number; descriptionMaxLength?: number; maxPhotos?: number };
}

/** Every write is the user's; success is their confirmation. */
const ASSISTED_CAPABILITIES: MarketplaceCapabilities = {
  connect: 'none',
  create: 'assisted',
  updatePrice: 'assisted',
  updateDetails: 'assisted',
  delist: 'assisted',
  relist: 'assisted',
  markSold: 'not_needed',
  verifyRead: 'user_confirm',
  readFreshness: 'none',
  title: 'field',
  importListings: 'share_sheet',
  saleDetection: ['email', 'manual'],
  imageTransport: 'user_saves_photos',
  taxonomy: 'static_snapshot',
  pricingData: 'none',
  externalSkuReusable: true,
  limits: {},
};

const TASK_KIND = {
  create: 'list_manually',
  relist: 'list_manually',
  revise: 'edit_manually',
  price: 'edit_manually',
  end: 'delist_manually',
  mark_sold: 'delist_manually',
} as const satisfies Record<WriteOperationKind, UserTaskKind>;

export class AssistedAdapter implements MarketplaceAdapter<AssistedListingPayload> {
  readonly id: Marketplace;
  readonly #name: string;
  readonly #siteUrl: string;
  readonly #siteDomain: string;
  readonly #capabilities: MarketplaceCapabilities;
  readonly #limits: NonNullable<AssistedAdapterOptions['limits']>;

  constructor(options: AssistedAdapterOptions) {
    this.id = options.marketplace;
    this.#name = MARKETPLACE_NAMES[options.marketplace];
    const site = new URL(options.siteUrl);
    if (site.protocol !== 'https:') throw new Error('siteUrl must be an https:// URL');
    this.#siteUrl = site.href;
    this.#siteDomain = site.hostname.replace(/^www\./, '');
    this.#capabilities = { ...ASSISTED_CAPABILITIES, ...options.capabilities };
    for (const flag of Object.values(CAPABILITY_FOR_KIND)) {
      const mode = this.#capabilities[flag];
      if (mode === 'api' || mode === 'automation') {
        throw new Error(`an assisted adapter cannot have ${flag}: ${mode}`);
      }
    }
    this.#limits = options.limits ?? {};
  }

  capabilities(): MarketplaceCapabilities {
    return this.#capabilities;
  }

  buildPayload(item: ItemSnapshot, variant: ListingVariant): AssistedListingPayload {
    return {
      title: variant.title,
      description: variant.description,
      price: { amountCents: variant.price.amountCents, currency: variant.price.currency },
      photos: photosInOrder(item).map(({ photoId, url }) => ({ photoId, url })),
    };
  }

  validate(payload: AssistedListingPayload): ValidationIssue[] {
    const name = this.#name;
    const { titleMaxLength, descriptionMaxLength, maxPhotos } = this.#limits;
    const issues: ValidationIssue[] = [];
    if (titleMaxLength !== undefined && payload.title.length > titleMaxLength) {
      issues.push({
        field: 'variant.title',
        code: 'too_long',
        message: `${name} titles can be at most ${String(titleMaxLength)} characters.`,
      });
    }
    if (descriptionMaxLength !== undefined && payload.description.length > descriptionMaxLength) {
      issues.push({
        field: 'variant.description',
        code: 'too_long',
        message: `${name} descriptions can be at most ${String(descriptionMaxLength)} characters.`,
      });
    }
    if (payload.price.amountCents <= 0) {
      issues.push({
        field: 'variant.price',
        code: 'out_of_range',
        message: `${name} needs a price above $0.`,
      });
    }
    if (payload.photos.length === 0) {
      issues.push({
        field: 'item.photos',
        code: 'required',
        message: `${name} needs at least one photo.`,
      });
    } else if (maxPhotos !== undefined && payload.photos.length > maxPhotos) {
      issues.push({
        field: 'item.photos',
        code: 'too_many',
        message: `${name} takes at most ${String(maxPhotos)} photos.`,
      });
    }
    return issues;
  }

  /** Creates the user task; never contacts the marketplace and never throws. */
  execute(op: OperationRequest<AssistedListingPayload>): Promise<Outcome> {
    return Promise.resolve(this.#taskFor(op));
  }

  /** Listora never reads an assisted marketplace; only the user's confirmation counts. */
  readListing(): Promise<RemoteListingState> {
    return Promise.reject(
      new Error(`Listora doesn't read ${this.#name} listings; the user confirms each step.`),
    );
  }

  /** There is no connection to check. */
  healthCheck(): Promise<Health> {
    return Promise.resolve({ status: 'ok' });
  }

  #taskFor(op: OperationRequest<AssistedListingPayload>): Outcome {
    if (operationMode(this.#capabilities, op.kind) !== 'assisted') {
      return {
        type: 'rejected',
        code: 'not_supported',
        message: unsupportedMessage(op.kind, this.id),
      };
    }
    const payload: JsonObject = { action: op.kind };
    if (isContentKind(op.kind)) {
      if (op.payload === null) {
        return {
          type: 'rejected',
          code: 'missing_content',
          message: `This change has no listing details to copy into ${this.#name}.`,
        };
      }
      payload['copyAssist'] = copyAssist(op.payload);
    } else if (op.kind === 'price') {
      const { priceCents, currency } = op.desired;
      if (priceCents === undefined) {
        return {
          type: 'rejected',
          code: 'missing_price',
          message: `This change has no price to set on ${this.#name}.`,
        };
      }
      payload['copyAssist'] = { price: { amountCents: priceCents, currency: currency ?? 'USD' } };
    }
    return {
      type: 'pendingUser',
      task: { kind: TASK_KIND[op.kind], deepLink: this.#deepLink(op), payload },
    };
  }

  /** New listings start on the marketplace's site; changes open the listing's own page. */
  #deepLink(op: OperationRequest): string {
    switch (op.kind) {
      case 'create':
      case 'relist':
        return this.#siteUrl;
      case 'revise':
      case 'price':
      case 'end':
      case 'mark_sold':
        return this.#listingUrl(op.listing.externalUrl) ?? this.#siteUrl;
      default:
        return assertNever(op.kind, 'operation kind');
    }
  }

  /** The listing's page, only when it is an https page on this marketplace's domain. */
  #listingUrl(value: string | null): string | null {
    if (value === null || !URL.canParse(value)) return null;
    const url = new URL(value);
    const onSite =
      url.hostname === this.#siteDomain || url.hostname.endsWith(`.${this.#siteDomain}`);
    return url.protocol === 'https:' && onSite ? url.href : null;
  }
}

function copyAssist(payload: AssistedListingPayload): JsonObject {
  return {
    title: payload.title,
    description: payload.description,
    price: { amountCents: payload.price.amountCents, currency: payload.price.currency },
    photos: payload.photos.map(({ photoId, url }) => ({ photoId, url })),
  };
}
