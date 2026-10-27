/**
 * The shape of `taxonomy.json` (taxonomy.ts reads it; refresh.ts writes it).
 */
import { z } from 'zod';

const valueSchema = z.object({ id: z.string(), name: z.string() });

export const attributeSchema = z.object({
  name: z.string(),
  /** How many values the form lets the seller pick. */
  max: z.number().int().positive(),
  values: z.array(valueSchema.extend({ departments: z.array(z.string()).optional() })),
});

export const productTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The US size list's id (`sizeSets`), or `null` for a product type without sizes. */
  sizeSet: z.number().int().nullable(),
  /** The item specifics the form offers (`attributes`). */
  attributes: z.array(z.string()),
});

export const groupSchema = z.object({
  id: z.string(),
  name: z.string(),
  productTypes: z.array(productTypeSchema),
});

export const departmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Whether the form asks who the item is for (Kids: Boys, Girls, or Unisex). */
  asksGender: z.boolean(),
  groups: z.array(groupSchema),
});

export const taxonomySchema = z.object({
  source: z.string(),
  /** The day the data was read from Depop (`YYYY-MM-DD`). */
  fetchedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departments: z.array(departmentSchema),
  sizeSets: z.record(z.string(), z.object({ name: z.string(), sizes: z.array(z.string()) })),
  /** The form's own fields (`colour`, `style`, `age`, `source`) and every item specific. */
  attributes: z.record(z.string(), attributeSchema),
  bannedHashtags: z.array(z.string()),
});

export type DepopTaxonomy = z.infer<typeof taxonomySchema>;
export type DepopDepartmentData = z.infer<typeof departmentSchema>;
export type DepopGroupData = z.infer<typeof groupSchema>;
export type DepopProductTypeData = z.infer<typeof productTypeSchema>;
export type DepopAttributeData = z.infer<typeof attributeSchema>;
