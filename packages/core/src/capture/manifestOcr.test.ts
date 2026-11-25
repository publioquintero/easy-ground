import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createWorker, OEM } from 'tesseract.js';
import { parseManifest } from './manifestParser';
import { textItemsFromOcr, type OcrPage } from './ocrText';

/**
 * End-to-end OCR check on a sharp render of the synthetic manifest (page 1, 21 stops).
 * Downloads the English OCR model on first run (cached in node_modules/.cache).
 */
const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));
const cachePath = fileURLToPath(new URL('../../../../node_modules/.cache/tesseract', import.meta.url));

describe('parseManifest — OCR of a manifest image', () => {
  it('reads all stops of page 1 like the PDF text layer', async () => {
    await mkdir(cachePath, { recursive: true });
    const worker = await createWorker('eng', OEM.LSTM_ONLY, { cachePath });
    await worker.setParameters({ tessedit_pageseg_mode: '6' as never });
    const { data } = await worker.recognize(fixture('manifest_synthetic_01_p1.png'), {}, { blocks: true });
    await worker.terminate();

    const expected = JSON.parse(await readFile(fixture('manifest_synthetic_01.expected.json'), 'utf8'));
    const page1 = expected.stops.slice(0, 21);
    const { stops, issues } = parseManifest(textItemsFromOcr(data as unknown as OcrPage, 1));

    // OCR may drop the space in "# 114"; everything else must match exactly.
    const squash = (s: { addressLine2: string | null }) => ({ ...s, addressLine2: s.addressLine2?.replace(/\s+/g, '') ?? null });
    expect(stops.map(squash)).toEqual(page1.map(squash));
    expect(issues).toEqual([]);
  }, 60_000);
});
