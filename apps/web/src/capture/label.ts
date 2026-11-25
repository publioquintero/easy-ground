import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import { createWorker, OEM, type Worker } from 'tesseract.js';
import {
  parseLabelBarcode,
  parseLabelText,
  trackingFromLinearBarcode,
  type LabelAddress,
} from '@easy-ground/core';

/**
 * Read a FedEx package label from a photo, fully in the browser (the photo never leaves the
 * phone): the 2D barcode first, OCR of the "TO" block if the barcode can't be read.
 */

// Serve the barcode engine from our own origin instead of the library's default CDN.
prepareZXingModule({
  overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
});

/** Phone photos are 12 MP; barcodes and the address read fine at this size, much faster. */
const MAX_SIDE = 2400;

async function toImageData(file: File): Promise<ImageData> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

let ocrWorker: Promise<Worker> | null = null;
function getOcrWorker(): Promise<Worker> {
  // Its own worker: a label is free-form text (PSM 3), unlike the manifest table (PSM 6).
  ocrWorker ??= createWorker('eng', OEM.LSTM_ONLY);
  return ocrWorker;
}

export interface LabelReadResult {
  label: LabelAddress | null;
  /** Tracking number even when the address couldn't be read. */
  trackingNumber: string | null;
}

export async function readLabelPhoto(file: File, onProgress?: (step: string) => void): Promise<LabelReadResult> {
  onProgress?.('Reading barcode…');
  const image = await toImageData(file);
  const barcodes = await readBarcodes(image, {
    formats: ['PDF417', 'MaxiCode', 'Code128'],
    tryHarder: true,
    textMode: 'Plain', // real GS/RS separators (the default prints them as ␝ ␞)
    tryRotate: true,
    maxNumberOfSymbols: 4,
  });

  let tracking: string | null = null;
  for (const b of barcodes) {
    if (b.format === 'Code128') tracking ??= trackingFromLinearBarcode(b.text);
  }
  for (const b of barcodes) {
    const label = b.format !== 'Code128' ? parseLabelBarcode(b.text) : null;
    if (label) return { label: { ...label, trackingNumber: label.trackingNumber ?? tracking }, trackingNumber: label.trackingNumber ?? tracking };
  }

  onProgress?.('Reading label text…');
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(file);
  const label = parseLabelText(data.text);
  tracking ??= label?.trackingNumber ?? null;
  return { label: label && { ...label, trackingNumber: label.trackingNumber ?? tracking }, trackingNumber: tracking };
}
