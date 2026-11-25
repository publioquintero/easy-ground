import type { TextItem } from './types';

/**
 * Minimal structural types for a pdf.js document, so `core` doesn't depend on pdfjs-dist
 * at runtime: the web app (and tests) load pdf.js themselves and pass the document in.
 */
interface PdfJsTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}
interface PdfJsPage {
  getViewport(params: { scale: number }): { height: number };
  getTextContent(): Promise<{ items: unknown[] }>;
}
export interface PdfJsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPage>;
}

const isTextItem = (item: unknown): item is PdfJsTextItem =>
  typeof item === 'object' && item !== null && 'str' in item && 'transform' in item;

/** Read the text layer of a PDF as positioned items (top-down y, baseline reference). */
export async function textItemsFromPdf(doc: PdfJsDocument): Promise<TextItem[]> {
  const items: TextItem[] = [];
  for (let page = 1; page <= doc.numPages; page++) {
    const pdfPage = await doc.getPage(page);
    const { height: pageHeight } = pdfPage.getViewport({ scale: 1 });
    const content = await pdfPage.getTextContent();
    for (const raw of content.items) {
      if (!isTextItem(raw) || raw.str.trim() === '') continue;
      const [, , , scaleY, x, baseline] = raw.transform;
      items.push({
        text: raw.str,
        x,
        y: pageHeight - baseline,
        width: raw.width,
        height: raw.height || Math.abs(scaleY),
        page,
      });
    }
  }
  return items;
}
