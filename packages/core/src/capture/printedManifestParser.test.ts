import { describe, expect, it } from 'vitest';
import { isPrintedManifest, parsePrintedManifest, splitPrintedAddress } from './printedManifestParser';
import type { TextItem } from './types';

/** One pdf.js-like run per printed line (invented addresses, real layout). */
const lines = (page: number, texts: string[]): TextItem[] =>
  texts.map((text, i) => ({ text, x: 36, y: 50 + i * 14, width: text.length * 5, height: 10, page }));

const items: TextItem[] = [
  ...lines(1, [
    '1. 40 S 1500 W MAPLETON UT 84664 SID: 0, Packages: 1. Pickup.',
    '2. 210 N 1300 W UNIT B104 MAPLETON UT 84664 SID: 1000, Packages: 1. Delivery.',
    '3. 215 N 1300 W # B MAPLETON UT 84664 SID: 1012, Packages: 1. Delivery.',
    '4. 1500 W 900 N WOODS CROSS UT 84087 SID: 1001 FL, Packages: 2. Delivery.',
    // Stop 5 was removed from the route: the printout skips its number.
    '6. 1100 W HARVEST CROSSING BLVD STE 300 MAPLETON UT 84664 SID: 4091, Packages: 4.',
    'Delivery.',
  ]),
  ...lines(2, [
    '7. 1650 BIRCH HOLLOW CIR WEST BOUNTIFUL UT 84087 SID: 2546, Packages: 1. Delivery.',
    '8. 300 E 100 S ST GEORGE UT 84770 SID: 3000, Packages: 3. Delivery.',
  ]),
];

describe('parsePrintedManifest', () => {
  it('detects the printed format and not the table', () => {
    expect(isPrintedManifest(items)).toBe(true);
    expect(isPrintedManifest(lines(1, ['#', 'D/P', 'SID', 'Pkgs', 'Name', 'Address']))).toBe(false);
  });

  it('reads every stop, keeping gaps, wrapped records, units, floor SIDs and city/ZIP', () => {
    const { stops, issues } = parsePrintedManifest(items);
    expect(issues).toEqual([]);
    expect(stops.map((s) => s.stopNumber)).toEqual([1, 2, 3, 4, 6, 7, 8]);
    expect(stops[0]).toEqual({
      stopNumber: 1, stopType: 'pickup', shelfId: '0', packageCount: 1, customerName: null,
      addressRaw: '40 S 1500 W', addressLine2: null, completed: false, city: 'MAPLETON', state: 'UT', zip: '84664',
    });
    expect(stops.map((s) => [s.addressRaw, s.addressLine2, s.city, s.shelfId, s.packageCount])).toEqual([
      ['40 S 1500 W', null, 'MAPLETON', '0', 1],
      ['210 N 1300 W', 'UNIT B104', 'MAPLETON', '1000', 1],
      ['215 N 1300 W', '# B', 'MAPLETON', '1012', 1],
      ['1500 W 900 N', null, 'WOODS CROSS', '1001 FL', 2],
      ['1100 W HARVEST CROSSING BLVD', 'STE 300', 'MAPLETON', '4091', 4],
      ['1650 BIRCH HOLLOW CIR', null, 'WEST BOUNTIFUL', '2546', 1],
      ['300 E 100 S', null, 'ST GEORGE', '3000', 3],
    ]);
    expect(stops.every((s) => s.stopType === 'delivery' || s.stopNumber === 1)).toBe(true);
  });

  it('reports numbered records it could not read', () => {
    const { stops, issues } = parsePrintedManifest(
      lines(1, ['1. 40 S 1500 W MAPLETON UT 84664 SID: 0, Packages: 1. Pickup.', '2. 210 N 1300 W MAPLETON UT 84664 SID: 1000, Packages: ?. Delivery.']),
    );
    expect(stops).toHaveLength(1);
    expect(issues.map((i) => [i.kind, i.stopNumber])).toEqual([['unparsed_row', 2]]);
  });
});

describe('splitPrintedAddress', () => {
  it('keeps the whole text as street when no street end is found', () => {
    expect(splitPrintedAddress('PO BOX 12 MAPLETON UT 84664')).toEqual({
      street: 'PO BOX 12 MAPLETON', unit: null, city: null, state: 'UT', zip: '84664',
    });
  });
});
