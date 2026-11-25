import { describe, expect, it } from 'vitest';
import type { StopDraft } from '../model';
import { mergeStopCards, parseStopCardFrames, parseStopCardText } from './stopCardParser';

// OCR of a frame: map labels and turn instructions around the card (as in GroundCloud).
const FRAME = `
then turn right on S Clement Ave
0.1 mi  turn right on S Kinnickinnic Ave
Humboldt Park
3276 S LENOX ST
MILWAUKEE, WI 53207
DELIVERY | 1 PKG | SID: 1506
LISA DOE
CUST REQ:FRONT DOOR/DOORBELL BROKEN,
PLEASE KNOCK
START  DELIVERED  ATTEMPTED  CALL
25  1:42 PM
`;

describe('parseStopCardText', () => {
  it('reads the card and ignores the map around it', () => {
    expect(parseStopCardText(FRAME, 3)).toEqual({
      stopNumber: null,
      stopType: 'delivery',
      packageCount: 1,
      shelfId: '1506',
      street: '3276 S LENOX ST',
      city: 'MILWAUKEE',
      state: 'WI',
      zip: '53207',
      customerName: 'LISA DOE',
      customerNotes: 'CUST REQ:FRONT DOOR/DOORBELL BROKEN, PLEASE KNOCK',
      frame: 3,
    });
  });

  it('tolerates OCR without the bars and a stop number when shown', () => {
    const card = parseStopCardText('STOP 14\n52 OAK ST\nLEHI UT 84043\nPICKUP 3 PKGS SID 6000\nACME INC\nSTART');
    expect(card).toMatchObject({ stopNumber: 14, stopType: 'pickup', packageCount: 3, shelfId: '6000', street: '52 OAK ST', zip: '84043', customerName: 'ACME INC', customerNotes: null });
  });

  it('is null for frames without a card', () => {
    expect(parseStopCardText('Humboldt Park\n0.1 mi turn right')).toBeNull();
    expect(parseStopCardText('DELIVERY | 1 PKG\nLISA DOE')).toBeNull(); // no address
  });
});

describe('parseStopCardFrames', () => {
  it('keeps one card per stop, the most complete reading, in first-seen order', () => {
    const blurry = '3276 S LENOX ST\nDELIVERY 1 PKG\nSTART';
    const other = '10 ELM ST\nMILWAUKEE, WI 53207\nDELIVERY | 2 PKG | SID: 1507\nSTART';
    const cards = parseStopCardFrames([blurry, FRAME, other, blurry]);
    expect(cards.map((c) => [c.street, c.frame, c.shelfId])).toEqual([
      ['3276 S LENOX ST', 0, '1506'],
      ['10 ELM ST', 2, '1507'],
    ]);
  });
});

describe('mergeStopCards', () => {
  const draft = (n: number, address: string): StopDraft => ({
    stopNumber: n, stopType: 'delivery', shelfId: null, packageCount: 1, customerName: null,
    addressRaw: address, addressLine2: null, completed: false,
  });

  it('enriches matching stops (full street, ZIP, notes) and numbers new ones after the last', () => {
    const cards = parseStopCardFrames([FRAME, '10 ELM ST\nMILWAUKEE, WI 53207\nDELIVERY | 2 PKG | SID: 1507\nSTART']);
    const out = mergeStopCards(cards, [draft(7, '3276 S LENOX S…'), draft(9, '1 MAIN ST')]);
    expect(out.matched).toBe(1);
    expect(out.added).toBe(1);
    expect(out.stops[0]).toMatchObject({ stopNumber: 7, addressRaw: '3276 S LENOX ST', zip: '53207', shelfId: '1506', customerNotes: expect.stringContaining('KNOCK') });
    expect(out.stops[1]).toMatchObject({ stopNumber: 10, addressRaw: '10 ELM ST', packageCount: 2, source: 'recording' });
    expect(out.issues).toEqual([expect.objectContaining({ kind: 'inferred_stop_number', stopNumber: 10 })]);
  });
});
