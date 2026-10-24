/**
 * Test-only helpers for this package's tests (not exported from the package).
 */
import { z } from 'zod';

import type { AiImage, OutputSchema } from './types.ts';

/** A valid 1x1 red PNG. */
export const RED_PIXEL_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
    'base64',
  ),
);

export function image(bytes: string | Uint8Array, width = 1024, height = 768): AiImage {
  return {
    mediaType: 'image/jpeg',
    data: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes,
    width,
    height,
  };
}

export const colorSchema = z.object({
  color: z.string(),
  confidence: z.number(),
});

export const COLOR_OUTPUT: OutputSchema<z.infer<typeof colorSchema>> = {
  name: 'dominant_color',
  schema: colorSchema,
};
