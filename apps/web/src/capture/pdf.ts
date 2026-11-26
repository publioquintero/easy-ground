import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { isPrintedManifest, parseManifest, parsePrintedManifest, textItemsFromPdf, type ParseResult } from '@easy-ground/core';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Parse a GroundCloud manifest PDF entirely in the browser: either the printed list
 * (Manifest View 🖨️ → Save to Files) or a PDF of the Manifest View table.
 */
export async function parseManifestPdf(file: File): Promise<ParseResult> {
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  try {
    const items = await textItemsFromPdf(doc);
    return isPrintedManifest(items) ? parsePrintedManifest(items) : parseManifest(items);
  } finally {
    await doc.destroy();
  }
}
