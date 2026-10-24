import type { CountryCode } from './countries.ts';
import type { FiberPart, Material } from './materials.ts';

/** Every fact a tag parser can extract. Each field holds a list because a tag can repeat it. */
export const TAG_FIELDS = ['rn', 'ca', 'gtin', 'size', 'fiber', 'origin', 'style'] as const;
export type TagField = (typeof TAG_FIELDS)[number];

/** One line of on-device OCR output (Vision `RecognizeTextRequest`), in reading order. */
export interface OcrLine {
  readonly text: string;
  /** Recognizer confidence in [0, 1]. Scales the confidence of values found on this line. */
  readonly confidence?: number;
  /** The tag photo the line came from, when the caller knows it. */
  readonly photoId?: string;
}

/** One barcode payload from on-device detection (Vision `DetectBarcodesRequest`). */
export interface BarcodeRead {
  readonly payload: string;
  /** Detector symbology name, for example `EAN-13` or `VNBarcodeSymbologyUPCE`. */
  readonly symbology?: string;
  readonly photoId?: string;
}

export interface TagTextInput {
  readonly lines: readonly OcrLine[];
  readonly barcodes?: readonly BarcodeRead[];
}

/** Where a parsed value came from, so the review screen can show the evidence. */
export type ValueSource =
  | {
      readonly kind: 'ocr';
      /** Index of the line in `TagTextInput.lines`; two entries when a value wraps a line. */
      readonly lineIndexes: readonly number[];
      /** The original (un-normalized) text of those lines. */
      readonly text: string;
      readonly photoId?: string;
    }
  | {
      readonly kind: 'barcode';
      readonly barcodeIndex: number;
      readonly payload: string;
      readonly symbology?: string;
      readonly photoId?: string;
    };

export interface Parsed<T> {
  readonly value: T;
  /** Rule confidence in [0, 1], scaled by the OCR line confidence when one was given. */
  readonly confidence: number;
  readonly source: ValueSource;
}

/** UPC-A codes keep 12 digits; an EAN-13 with a leading 0 is reported as the UPC-A it encodes. */
export type GtinFormat = 'upc_a' | 'ean_13';
export interface Gtin {
  readonly format: GtinFormat;
  readonly digits: string;
}

/**
 * `letter` (XS..XXXL), `numeric` (a bare or "SIZE 8" number), `waist_inseam` (`32x30`),
 * `us`/`uk`/`eu` (explicitly labeled systems), and `one_size` (value `OS`).
 */
export type SizeSystem = 'letter' | 'numeric' | 'waist_inseam' | 'us' | 'uk' | 'eu' | 'one_size';
export interface Size {
  readonly system: SizeSystem;
  readonly value: string;
}

export interface FiberComponent {
  /** The garment part the percentage applies to; null when the tag does not name one. */
  readonly part: FiberPart | null;
  readonly material: Material;
  readonly percent: number;
}

export interface TagValueTypes {
  rn: string;
  ca: string;
  gtin: Gtin;
  size: Size;
  fiber: FiberComponent;
  origin: CountryCode;
  style: string;
}

/** Plain values per field (ground truth, or parser output without confidence and source). */
export type TagValues = { readonly [F in TagField]: readonly TagValueTypes[F][] };

/** Parser output: every value with its confidence and source, highest confidence first. */
export type TagFacts = { readonly [F in TagField]: readonly Parsed<TagValueTypes[F]>[] };
