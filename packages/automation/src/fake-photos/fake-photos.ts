/**
 * The listing photos the fake marketplaces show on their own image CDN (`/media/<name>.jpg`),
 * which an import fetches into the item (docs/features/imports.md): a real JPEG for each name,
 * different for every name, so an imported photo decodes, is processed like any upload, and two
 * listings with different photos never look alike to the photo match.
 *
 * Development and tests only. `sharp` is loaded when the first photo is asked for, so loading a
 * fake never needs it.
 */
import { createHash } from 'node:crypto';

/** The path a fake serves a listing's photo at; `name` is the photo's file name without `.jpg`. */
export const FAKE_MEDIA_PATH = /^\/media\/([\w.-]+)\.jpg$/;

const cache = new Map<string, Promise<Buffer>>();

/** The photo shown for `name`: a 256 px JPEG of a pattern only that name draws. */
export function fakeMediaPhoto(name: string): Promise<Buffer> {
  let photo = cache.get(name);
  if (photo === undefined) {
    photo = draw(name);
    cache.set(name, photo);
  }
  return photo;
}

/** The file name a fake gives a listing's photo on its CDN, from the name it was uploaded as. */
export function fakeMediaName(name: string): string {
  return name.replace(/\.jpe?g$/i, '').replace(/[^\w.-]+/g, '_') || 'photo';
}

async function draw(name: string): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const seed = createHash('sha256').update(name).digest();
  const size = 16;
  // A 16 x 16 grid of grey levels from the name's hash, scaled up: coarse enough that its
  // perceptual hash differs from every other name's.
  const pixels = Buffer.alloc(size * size);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = (seed[index % seed.length] ?? 0) ^ (index * 37);
  }
  return sharp(pixels, { raw: { width: size, height: size, channels: 1 } })
    .resize(256, 256, { kernel: 'nearest' })
    .jpeg({ quality: 80 })
    .toBuffer();
}
