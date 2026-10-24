import type { BarcodeRead, OcrLine, TagValues } from '@listora/tag-parse';

export const TAG_KINDS = [
  'care_label',
  'hang_tag',
  'neck_label',
  'denim_label',
  'shoe_label',
  'edge_case',
] as const;
export type TagKind = (typeof TAG_KINDS)[number];

/** One block of the printed tag, top to bottom: a line of text or a UPC-A/EAN-13 barcode. */
export type PrintedBlock = { readonly text: string } | { readonly barcode: string };

/** A corpus case before rendering: what is printed, what OCR returns, and the ground truth. */
export interface CaseSpec {
  readonly id: string;
  readonly kind: TagKind;
  /** Why a hand-written edge case exists; absent on generated cases. */
  readonly description?: string;
  /** Exactly what the rendered image shows. */
  readonly printed: readonly PrintedBlock[];
  /**
   * Simulated on-device reads of the printed tag: OCR lines after the deterministic noise model,
   * and barcode payloads in the form Vision reports them (UPC-A as a 13-digit EAN-13).
   */
  readonly ocr: { readonly lines: readonly OcrLine[]; readonly barcodes: readonly BarcodeRead[] };
  /** The facts printed on the tag, which a perfect parser returns. */
  readonly truth: TagValues;
}

export interface CorpusImage {
  /** File name inside the corpus `tags/` directory. */
  readonly file: string;
  readonly mediaType: 'image/png';
  readonly width: number;
  readonly height: number;
  /** sha256 of the decoded image (see `pixelSha256`), independent of PNG compression. */
  readonly pixelSha256: string;
}

export interface CorpusCase extends CaseSpec {
  readonly image: CorpusImage;
}

export interface CorpusManifest {
  readonly name: 'listora-synthetic-tags';
  /** Bumped whenever the generator, noise model, font, or renderer changes output. */
  readonly generatorVersion: number;
  readonly seed: number;
  readonly regenerate: string;
  readonly cases: readonly string[];
}
