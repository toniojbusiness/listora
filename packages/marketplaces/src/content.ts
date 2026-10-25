/**
 * Listing content: the item snapshot and the marketplace variant that a create, revise, or
 * relist publishes, in Listora's own terms (docs/features/marketplaces.md). The operation
 * stores it (`marketplace_operation.content`), each attempt builds the marketplace payload from
 * it with the adapter's pure `buildPayload`, and the desired state a read-back checks comes from
 * it too, so the payload sent and the state verified can never drift apart.
 *
 * The shapes mirror the API contract's `ItemDetails` and `ListingVariant`; absent values are
 * `null` (or an empty list) so every snapshot has the same keys.
 */
import { z } from 'zod';

import { PHOTO_ROLES, type JsonObject, type PhotoRole } from '@listora/db';
import { assertNever, type Money } from '@listora/shared';

import type { DesiredListingState } from './adapter.ts';

/** Canonical item conditions (the contract's `ItemCondition`); adapters map them. */
export const ITEM_CONDITIONS = [
  'new_with_tags',
  'new_without_tags',
  'new_with_defects',
  'pre_owned_excellent',
  'pre_owned_good',
  'pre_owned_fair',
] as const;
export type ItemCondition = (typeof ITEM_CONDITIONS)[number];

/** A photo as marketplaces and users get it: the fetchable listing-size image. */
export interface ListingPhoto {
  photoId: string;
  /** Posting order; the lowest is the cover. */
  position: number;
  role: PhotoRole;
  /** Unguessable public URL of the 1600 px listing derivative. */
  url: string;
}

export interface Measurement {
  /** Canonical name, for example `pit_to_pit` or `inseam`. */
  name: string;
  value: number;
  unit: 'in' | 'cm';
}

/** The item's canonical attributes when the operation was created. */
export interface ItemSnapshot {
  itemId: string;
  /** Listora's SKU, for example `AJ-000184`. */
  sku: string;
  brand: string | null;
  productName: string | null;
  styleNumber: string | null;
  upc: string | null;
  department: string | null;
  /** Canonical taxonomy path, for example `clothing/tops/t_shirts`. */
  category: string | null;
  sizeLabel: string | null;
  sizeSystem: string | null;
  colors: string[];
  pattern: string | null;
  materials: string[];
  condition: ItemCondition | null;
  conditionNotes: string | null;
  flaws: string[];
  measurements: Measurement[];
  photos: ListingPhoto[];
}

export interface ListingAspect {
  name: string;
  values: string[];
}

/** The marketplace-specific version of the item (`marketplace_listing` variant columns). */
export interface ListingVariant {
  title: string;
  description: string;
  price: Money;
  /** The marketplace's category id. */
  categoryRef: string | null;
  /** Overrides the item's condition for this marketplace. */
  condition: ItemCondition | null;
  aspects: ListingAspect[];
  hashtags: string[];
}

export interface ListingContent {
  item: ItemSnapshot;
  variant: ListingVariant;
}

/** Operation kinds that publish listing content and therefore carry it. */
export const CONTENT_KINDS = ['create', 'revise', 'relist'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export function isContentKind(kind: string): kind is ContentKind {
  return (CONTENT_KINDS as readonly string[]).includes(kind);
}

export class InvalidListingContentError extends Error {
  constructor(message: string) {
    super(`Invalid listing content: ${message}`);
    this.name = 'InvalidListingContentError';
  }
}

const text = (max: number) => z.string().max(max);
const optionalText = (max: number) => text(max).nullable();
const httpUrl = z.url({ protocol: /^https?$/ }).max(2048);

const photoSchema = z.strictObject({
  photoId: z.string().min(1).max(64),
  position: z.int().min(0).max(1000),
  role: z.enum(PHOTO_ROLES),
  url: httpUrl,
});

const itemSchema = z.strictObject({
  itemId: z.string().min(1).max(64),
  sku: z.string().min(1).max(64),
  brand: optionalText(120),
  productName: optionalText(200),
  styleNumber: optionalText(64),
  upc: optionalText(14),
  department: optionalText(64),
  category: optionalText(200),
  sizeLabel: optionalText(32),
  sizeSystem: optionalText(16),
  colors: z.array(text(32)).max(10),
  pattern: optionalText(64),
  materials: z.array(text(64)).max(10),
  condition: z.enum(ITEM_CONDITIONS).nullable(),
  conditionNotes: optionalText(2000),
  flaws: z.array(text(200)).max(20),
  measurements: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(64),
        value: z.number().min(0).max(10_000),
        unit: z.enum(['in', 'cm']),
      }),
    )
    .max(20),
  photos: z
    .array(photoSchema)
    .max(50)
    .refine(
      (photos) =>
        new Set(photos.map((photo) => photo.position)).size === photos.length &&
        new Set(photos.map((photo) => photo.photoId)).size === photos.length,
      { message: 'photo ids and positions must be unique' },
    ),
});

const variantSchema = z.strictObject({
  title: text(200).refine((title) => title.trim() !== '', { message: 'title must not be blank' }),
  description: text(10_000),
  price: z.strictObject({
    amountCents: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    currency: z.literal('USD'),
  }),
  categoryRef: optionalText(64),
  condition: z.enum(ITEM_CONDITIONS).nullable(),
  aspects: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(120),
        values: z.array(text(200)).min(1).max(30),
      }),
    )
    .max(60),
  hashtags: z.array(text(64)).max(10),
});

const contentSchema: z.ZodType<ListingContent> = z.strictObject({
  item: itemSchema,
  variant: variantSchema,
});

/**
 * Validates listing content read from JSON (`marketplace_operation.content`). Unknown fields are
 * an error, so a typo can never silently drop part of a listing.
 */
export function parseListingContent(value: unknown): ListingContent {
  const result = contentSchema.safeParse(value);
  if (!result.success) {
    const [issue] = result.error.issues;
    const path = issue === undefined ? '' : issue.path.map(String).join('.');
    throw new InvalidListingContentError(
      issue === undefined ? 'unreadable' : `${path === '' ? 'content' : path}: ${issue.message}`,
    );
  }
  return result.data;
}

/**
 * The JSON stored in `marketplace_operation.content`, in one canonical key order (jsonb does not
 * keep key order, so equal contents compare equal only through this).
 */
export function listingContentToJson(content: ListingContent): JsonObject {
  const { item, variant } = parseListingContent(content);
  return {
    item: {
      itemId: item.itemId,
      sku: item.sku,
      brand: item.brand,
      productName: item.productName,
      styleNumber: item.styleNumber,
      upc: item.upc,
      department: item.department,
      category: item.category,
      sizeLabel: item.sizeLabel,
      sizeSystem: item.sizeSystem,
      colors: [...item.colors],
      pattern: item.pattern,
      materials: [...item.materials],
      condition: item.condition,
      conditionNotes: item.conditionNotes,
      flaws: [...item.flaws],
      measurements: item.measurements.map(({ name, value, unit }) => ({ name, value, unit })),
      photos: item.photos.map(({ photoId, position, role, url }) => ({
        photoId,
        position,
        role,
        url,
      })),
    },
    variant: {
      title: variant.title,
      description: variant.description,
      price: { amountCents: variant.price.amountCents, currency: variant.price.currency },
      categoryRef: variant.categoryRef,
      condition: variant.condition,
      aspects: variant.aspects.map(({ name, values }) => ({ name, values: [...values] })),
      hashtags: [...variant.hashtags],
    },
  };
}

/**
 * The state a read-back must show after an operation publishes this content: a create shows
 * the variant live, a revise shows the new variant, and a relist shows the listing live again
 * (a relist on a marketplace that keeps the listing does not change its content).
 */
export function desiredStateForContent(
  kind: ContentKind,
  content: ListingContent,
): DesiredListingState {
  const { title, description, price } = content.variant;
  const fields = { title, description, priceCents: price.amountCents, currency: price.currency };
  switch (kind) {
    case 'create':
      return { status: 'active', ...fields };
    case 'revise':
      return fields;
    case 'relist':
      return { status: 'active' };
    default:
      return assertNever(kind, 'content operation kind');
  }
}

/** The item's photos in posting order (cover first); builders never trust the input order. */
export function photosInOrder(item: ItemSnapshot): ListingPhoto[] {
  return [...item.photos].sort((a, b) => a.position - b.position);
}
