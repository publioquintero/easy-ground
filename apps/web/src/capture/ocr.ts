import { createWorker, OEM, type Worker } from 'tesseract.js';
import { parseManifest, textItemsFromOcr, type OcrPage, type ParseResult, type TextItem } from '@easy-ground/core';

/**
 * Screenshot OCR, fully in the browser: images never leave the phone. Tesseract downloads
 * its English model once (~10 MB) and caches it in IndexedDB.
 */

/**
 * Thin UI fonts lose digits at low resolution, so small images are upscaled to ~2400 px.
 * Images that are already large (photos, retina screenshots) are left as they are:
 * resampling them only blurs the text.
 */
const TARGET_WIDTH = 2400;
const UPSCALE_BELOW = 1600;

let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  workerPromise ??= (async () => {
    const worker = await createWorker('eng', OEM.LSTM_ONLY);
    // PSM 6 (one uniform block) keeps tiny cells like "#", "D" and "1" that sparse modes drop.
    await worker.setParameters({ tessedit_pageseg_mode: '6' as never });
    return worker;
  })();
  return workerPromise;
}

async function toCanvas(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const scale = bitmap.width < UPSCALE_BELOW ? Math.min(3, TARGET_WIDTH / bitmap.width) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

/**
 * OCR several Manifest View screenshots and parse them together, so overlapping rows are
 * deduplicated and a screenshot without the header reuses the previous one's columns.
 */
export async function parseManifestImages(
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<ParseResult> {
  const worker = await getWorker();
  const items: TextItem[] = [];
  for (const [index, file] of files.entries()) {
    onProgress?.(index, files.length);
    const { data } = await worker.recognize(await toCanvas(file), {}, { blocks: true });
    items.push(...textItemsFromOcr(data as unknown as OcrPage, index + 1));
  }
  onProgress?.(files.length, files.length);
  return parseManifest(items);
}
