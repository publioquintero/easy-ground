import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { parseManifest, textItemsFromPdf, type ParseResult } from '@easy-ground/core';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Parse a Manifest View PDF (GroundCloud 🖨️ → Save to Files) entirely in the browser. */
export async function parseManifestPdf(file: File): Promise<ParseResult> {
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  try {
    return parseManifest(await textItemsFromPdf(doc));
  } finally {
    await doc.destroy();
  }
}
