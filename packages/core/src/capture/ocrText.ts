import type { TextItem } from './types';

/**
 * Minimal structural types for Tesseract.js output (`recognize(img, {}, { blocks: true })`),
 * so `core` doesn't depend on tesseract.js at runtime.
 */
interface OcrBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface OcrWord {
  text: string;
  confidence: number;
  bbox: OcrBbox;
}
export interface OcrPage {
  blocks: Array<{ paragraphs: Array<{ lines: Array<{ words: OcrWord[] }> }> }> | null;
}

/** Words below this confidence (0–100) are usually UI noise (icons, button art). */
export const MIN_WORD_CONFIDENCE = 30;

/** All words of a page, each with the index of the OCR line it belongs to. */
export function ocrWords(page: OcrPage): Array<OcrWord & { line: number }> {
  const lines = (page.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
  return lines.flatMap((l, line) => l.words.map((w) => ({ ...w, line })));
}

/**
 * Convert OCR words of one image to positioned text (y = vertical center of the word).
 * Keeps the OCR's line grouping, which follows tilted rows in photos of a screen.
 */
export function textItemsFromOcr(page: OcrPage, pageNumber: number): TextItem[] {
  return ocrWords(page)
    .filter((w) => w.text.trim() !== '' && w.confidence >= MIN_WORD_CONFIDENCE)
    .map((w) => ({
      line: w.line,
      text: w.text,
      x: w.bbox.x0,
      y: (w.bbox.y0 + w.bbox.y1) / 2,
      width: w.bbox.x1 - w.bbox.x0,
      height: w.bbox.y1 - w.bbox.y0,
      page: pageNumber,
    }));
}
