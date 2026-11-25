import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseManifest } from './manifestParser';
import { textItemsFromPdf } from './pdfText';
import type { TextItem } from './types';

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

describe.each([
  ['manifest_synthetic_01', []],
  // The demo route keeps one GroundCloud-truncated address on purpose.
  ['manifest_eagle_mountain', ['truncated_address']],
])('parseManifest — PDF fixture %s', (name, expectedIssues) => {
  it('reproduces the expected stops exactly', async () => {
    const data = new Uint8Array(await readFile(fixture(`${name}.pdf`)));
    const doc = await getDocument({ data, useSystemFonts: true }).promise;
    const items = await textItemsFromPdf(doc);
    const expected = JSON.parse(await readFile(fixture(`${name}.expected.json`), 'utf8'));

    const result = parseManifest(items);

    expect(result.issues.map((i) => i.kind)).toEqual(expectedIssues);
    expect(result.stops).toEqual(expected.stops);
  });
});

/**
 * OCR-shaped input modelled on the real Manifest View screenshot (invented data):
 * header "# ↓", "Address" and "2" as separate words, no "Status" header, status text and
 * DELIVER/ATTEMPT buttons in an unlabeled column, a truncated address, overlapping rows.
 */
function ocrRow(page: number, y: number, cells: Array<[number, string]>): TextItem[] {
  return cells.flatMap(([x, text]) =>
    text.split(' ').map((word, i) => ({ text: word, x: x + i * 40, y, width: 30, height: 20, page })),
  );
}

const COLS = { num: 20, dp: 70, sid: 115, pkgs: 172, name: 217, addr: 397, addr2: 587, status: 733 };

const header = (page: number) =>
  ocrRow(page, 60, [
    [COLS.num, '# ↓'],
    [COLS.dp, 'D/P'],
    [COLS.sid, 'SID'],
    [COLS.pkgs, 'Pkgs'],
    [COLS.name, 'Name'],
    [COLS.addr, 'Address'],
    [COLS.addr2, 'Address 2'],
  ]);

describe('parseManifest — screenshot-like OCR input', () => {
  const page1: TextItem[] = [
    ...ocrRow(1, 20, [[300, 'Verify Stops'], [500, 'Reorder Stops'], [850, 'FILTER']]),
    ...header(1),
    ...ocrRow(1, 100, [[COLS.num, '1'], [COLS.dp, 'D'], [COLS.sid, '6077'], [COLS.pkgs, '1'],
      [COLS.name, 'NORTHWIND SUPPLY'], [COLS.addr, '1100 HOLLY LN N'], [COLS.status, 'Delivered 02/10 @ 23:32']]),
    ...ocrRow(1, 140, [[COLS.num, '2'], [COLS.dp, 'D'], [COLS.sid, '6000'], [COLS.pkgs, '3'],
      [COLS.name, 'ANA ALDEN'], [COLS.addr, '9800 80TH AVE N'], [COLS.addr2, 'APT 219'],
      [COLS.status, 'DELIVER'], [COLS.status + 90, 'ATTEMPT']]),
    ...ocrRow(1, 180, [[COLS.num, '3'], [COLS.dp, 'D'], [COLS.sid, '6000'], [COLS.pkgs, '2'],
      [COLS.name, 'LEO BRANDT'], [COLS.addr, '11700 CENTRAL PARK…'], [COLS.addr2, 'APT 1425'],
      [COLS.status, 'DELIVER'], [COLS.status + 90, 'ATTEMPT']]),
  ];
  const page2: TextItem[] = [
    ...header(2),
    // Row 3 again (overlap between screenshots), then a pickup.
    ...ocrRow(2, 100, [[COLS.num, '3'], [COLS.dp, 'D'], [COLS.sid, '6000'], [COLS.pkgs, '2'],
      [COLS.name, 'LEO BRANDT'], [COLS.addr, '11700 CENTRAL PARK…'], [COLS.addr2, 'APT 1425']]),
    ...ocrRow(2, 140, [[COLS.num, '4'], [COLS.dp, 'P'], [COLS.sid, '6093'], [COLS.pkgs, '1'],
      [COLS.name, 'ROSA KESTREL'], [COLS.addr, '8100 MAIN ST N'], [COLS.status, 'Attempted 02/10 @ 23:34']]),
  ];

  const result = parseManifest([...page1, ...page2]);

  it('reads every stop once, in order', () => {
    expect(result.stops.map((s) => s.stopNumber)).toEqual([1, 2, 3, 4]);
  });

  it('keeps status text and buttons out of Address 2', () => {
    expect(result.stops[0]).toMatchObject({ addressLine2: null, completed: true });
    expect(result.stops[1]).toMatchObject({ addressLine2: 'APT 219', completed: false, packageCount: 3 });
  });

  it('treats SID as a shared shelf id and detects pickups', () => {
    expect(result.stops[1].shelfId).toBe('6000');
    expect(result.stops[2].shelfId).toBe('6000');
    expect(result.stops[3]).toMatchObject({ stopType: 'pickup', completed: true });
  });

  it('reports truncated addresses and duplicate rows', () => {
    expect(result.stops[2].addressRaw).toBe('11700 CENTRAL PARK…');
    expect(result.issues).toEqual([
      expect.objectContaining({ kind: 'truncated_address', stopNumber: 3, page: 1 }),
      expect.objectContaining({ kind: 'truncated_address', stopNumber: 3, page: 2 }),
      expect.objectContaining({ kind: 'duplicate_stop', stopNumber: 3, page: 2 }),
    ]);
  });

  it('reports a missing header instead of guessing', () => {
    const noHeader = parseManifest(ocrRow(1, 100, [[COLS.num, '1'], [COLS.addr, '1 MAIN ST']]));
    expect(noHeader.stops).toEqual([]);
    expect(noHeader.issues[0].kind).toBe('header_not_found');
  });
});

describe('parseManifest — OCR digit loss and review flags', () => {
  const rows = (numbers: string[], addresses?: string[]) => [
    ...header(1),
    ...numbers.flatMap((n, i) =>
      ocrRow(1, 100 + i * 40, [[COLS.num, n], [COLS.dp, 'D'], [COLS.sid, '6000'], [COLS.pkgs, '1'],
        [COLS.name, 'ANA ALDEN'], [COLS.addr, addresses?.[i] ?? `${8100 + i} MAIN ST N`]]),
    ),
  ];

  it('restores stop numbers whose leading digit OCR lost', () => {
    const { stops, issues } = parseManifest(rows(['10', 'Mm', '2', '13', '%', '15', '6']));
    expect(stops.map((s) => s.stopNumber)).toEqual([10, 11, 12, 13, 14, 15, 16]);
    expect(issues.filter((i) => i.kind === 'inferred_stop_number').map((i) => i.stopNumber)).toEqual([11, 12, 14, 16]);
  });

  it('keeps numbering right when OCR drops whole rows', () => {
    // Rows 11 and 12 are missing entirely; row 14 lost its "1".
    const items = rows(['10', '11', '12', '13', '4', '15']).filter(
      (i) => !(i.y === 140 || i.y === 180),
    );
    const { stops } = parseManifest(items);
    expect(stops.map((s) => s.stopNumber)).toEqual([10, 13, 14, 15]);
    expect(stops.find((s) => s.stopNumber === 14)?.addressRaw).toBe('8104 MAIN ST N');
  });

  it('does not renumber a filtered list without a consistent sequence', () => {
    const { stops, issues } = parseManifest(rows(['3', '17', '8', '25']));
    expect(stops.map((s) => s.stopNumber)).toEqual([3, 8, 17, 25]);
    expect(issues).toEqual([]);
  });

  it('flags house numbers and addresses OCR likely garbled', () => {
    const { issues } = parseManifest(rows(['1', '2', '3', '4'], ['10M HOLLY LN N', '8142', 'N EAGLE LAKE B.', '9 OAK ST']));
    expect(issues.map((i) => [i.kind, i.stopNumber])).toEqual([
      ['suspect_house_number', 1],
      ['suspect_house_number', 2],
      ['truncated_address', 3],
      ['suspect_house_number', 3],
    ]);
  });

  it('separates stop #, D/P and SID when OCR missed those headers', () => {
    const header = ocrRow(1, 60, [[COLS.pkgs, 'Pkgs'], [COLS.name, 'Name'], [COLS.addr, 'Address'], [COLS.addr2, 'Address 2']]);
    const row = ocrRow(1, 100, [[COLS.num, '7'], [COLS.dp, 'P'], [COLS.sid, '6077'], [COLS.pkgs, '2'],
      [COLS.name, 'ANA ALDEN'], [COLS.addr, '100 MAIN ST']]);
    expect(parseManifest([...header, ...row]).stops[0]).toMatchObject({
      stopNumber: 7, stopType: 'pickup', shelfId: '6077', packageCount: 2,
    });
  });

  it('splits a PDF text run that merged two cells (long name + address)', () => {
    // pdf.js merged Name and Address because the name nearly fills its column.
    const merged = 'ROCKWELL CHARTER HIGH SCHOOL 3435 E STONEBRIDGE LN';
    const charW = 6;
    const nameEnd = COLS.name + 'ROCKWELL CHARTER HIGH SCHOOL'.length * charW;
    const items: TextItem[] = [
      ...header(1),
      ...ocrRow(1, 100, [[COLS.num, '37'], [COLS.dp, 'D'], [COLS.sid, '8330'], [COLS.pkgs, '4']]),
      // Column gap sized so the address starts right at the Address column.
      { text: merged, x: COLS.name, y: 100, width: merged.length * charW * ((COLS.addr - COLS.name) / (nameEnd - COLS.name + charW)), height: 20, page: 1 },
    ];
    expect(parseManifest(items).stops[0]).toMatchObject({
      customerName: 'ROCKWELL CHARTER HIGH SCHOOL',
      addressRaw: '3435 E STONEBRIDGE LN',
    });
  });

  it('fixes O/I confusions in numeric columns', () => {
    const items = [...header(1), ...ocrRow(1, 100, [[COLS.num, '1O'], [COLS.dp, 'D'], [COLS.sid, '6O7I'],
      [COLS.pkgs, 'l'], [COLS.name, 'ANA'], [COLS.addr, '100 MAIN ST']])];
    expect(parseManifest(items).stops[0]).toMatchObject({ stopNumber: 10, shelfId: '6071', packageCount: 1 });
  });
});

describe('parseManifest — photo of a screen (tilt + perspective)', () => {
  /**
   * Each row drifts 9 px right of the one above (keystone) and rises 2 px per 100 px across
   * (tilt), so by row 12 the columns sit ~100 px off the header and y alone can't group rows.
   * OCR line ids keep words of a row together.
   */
  const tiltedRow = (n: number, cells: Array<[number, string]>): TextItem[] =>
    ocrRow(1, 0, cells).map((item) => {
      const x = item.x + n * 9;
      return { ...item, x, y: 100 + n * 38 - x * 0.02, line: n };
    });

  const items: TextItem[] = [
    ...header(1).map((i) => ({ ...i, line: 0 })),
    ...Array.from({ length: 12 }, (_, k) => {
      const n = k + 1;
      return tiltedRow(n, [[COLS.num, String(n)], [COLS.dp, 'D'], [COLS.sid, String(6000 + n)], [COLS.pkgs, '2'],
        [COLS.name, 'ANA ALDEN'], [COLS.addr, `${8100 + n} MAIN ST N`], [COLS.addr2, n === 12 ? 'APT 4' : ''],
        [COLS.status + 40, 'DELIVER'], [COLS.status + 130, 'ATTEMPT']].filter(([, t]) => t !== '') as Array<[number, string]>);
    }).flat(),
  ];

  it('keeps every cell in its column despite the drift', () => {
    const { stops, issues } = parseManifest(items);
    expect(issues).toEqual([]);
    expect(stops).toHaveLength(12);
    stops.forEach((s, k) =>
      expect(s).toMatchObject({ stopNumber: k + 1, shelfId: String(6001 + k), packageCount: 2, addressRaw: `${8101 + k} MAIN ST N` }),
    );
    expect(stops[11].addressLine2).toBe('APT 4');
  });
});
