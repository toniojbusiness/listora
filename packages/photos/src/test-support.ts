/**
 * Test-only helpers for this package's tests (not exported from the package): fixture photos
 * generated at test time, so no binary fixtures live in the repository and each test states
 * exactly what its image carries.
 */
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import exifReader from 'exif-reader';
import sharp from 'sharp';

/** A GPS position (Union Square, San Francisco) that must never survive processing. */
export const FIXTURE_GPS = {
  GPSLatitudeRef: 'N',
  GPSLatitude: '37/1 47/1 18/1',
  GPSLongitudeRef: 'W',
  GPSLongitude: '122/1 24/1 26/1',
  GPSAltitude: '16/1',
} as const;

export interface FixtureOptions {
  width: number;
  height: number;
  /** Changes the picture, so different seeds are visually different photos. */
  seed?: number;
  /** Adds camera EXIF with this GPS block, plus XMP and an ICC profile, as phones do. */
  gps?: boolean;
  /** EXIF orientation (6 = the camera was turned 90 degrees clockwise). */
  orientation?: number;
  quality?: number;
}

/**
 * A JPEG with structure (a gradient and blocks of varying brightness), not a flat color, so
 * its perceptual hash means something.
 */
export async function fixtureJpeg(options: FixtureOptions): Promise<Uint8Array> {
  const { width, height, seed = 1 } = options;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const block = (Math.floor((x * 8) / width) * 7 + Math.floor((y * 8) / height) * 13) * seed;
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * 255) / width;
      pixels[offset + 1] = (block * 37) % 256;
      pixels[offset + 2] = (y * 255) / height;
    }
  }
  let image = sharp(pixels, { raw: { width, height, channels: 3 } });
  if (options.gps === true) {
    image = image
      .withExif({
        IFD0: { Make: 'Apple', Model: 'iPhone 17 Pro', Software: '26.2' },
        IFD2: { DateTimeOriginal: '2026:10:24 09:41:00', BodySerialNumber: 'F2LXK0QPHG7F' },
        IFD3: FIXTURE_GPS,
      })
      .withXmp(
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
          '<rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="37,47.3N"/>' +
          '</rdf:RDF></x:xmpmeta>',
      );
  }
  if (options.orientation !== undefined || options.gps === true) {
    image = image.withMetadata({ orientation: options.orientation ?? 1 });
  }
  return new Uint8Array(await image.jpeg({ quality: options.quality ?? 90 }).toBuffer());
}

export interface ImageMetadataSummary {
  format: string | undefined;
  width: number | undefined;
  height: number | undefined;
  orientation: number | undefined;
  hasExif: boolean;
  hasGps: boolean;
  hasXmp: boolean;
  hasIptc: boolean;
  hasIcc: boolean;
}

/** What an image file carries besides its pixels, read back the way any viewer would. */
export async function readMetadata(bytes: Uint8Array): Promise<ImageMetadataSummary> {
  const metadata = await sharp(bytes).metadata();
  const exif = metadata.exif === undefined ? undefined : exifReader(metadata.exif);
  return {
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    orientation: metadata.orientation,
    hasExif: metadata.exif !== undefined,
    hasGps: exif?.GPSInfo !== undefined && Object.keys(exif.GPSInfo).length > 0,
    hasXmp: metadata.xmp !== undefined,
    hasIptc: metadata.iptc !== undefined,
    hasIcc: metadata.icc !== undefined,
  };
}

/** Every file under a directory, as storage keys (relative slash paths). */
export async function listKeys(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(rootDir, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .sort();
}
