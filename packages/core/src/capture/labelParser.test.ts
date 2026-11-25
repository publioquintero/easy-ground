import { describe, expect, it } from 'vitest';
import type { StopDraft } from '../model';
import {
  addressTokens,
  matchLabelToStops,
  parseLabelBarcode,
  parseLabelText,
  stopFromLabel,
  trackingFromLinearBarcode,
  type LabelAddress,
} from './labelParser';

const RS = '\x1e';
const GS = '\x1d';
const EOT = '\x04';

// Synthetic FedEx Ground PDF417 payload (invented customer), ANSI MH10.8.3 format 01.
const groundBarcode =
  `[)>${RS}01${GS}0284043${GS}840${GS}019${GS}794612761758${GS}FDEG${GS}123456789${GS}328${GS}${GS}1/1${GS}4.50LB${GS}N${GS}` +
  `1482 W CEDAR HOLLOW DR${GS}APT 12${GS}EAGLE MOUNTAIN${GS}UT${GS}JORDAN SAMPLE${RS}06${GS}10ZGD008${GS}12Z8015550100${RS}${EOT}`;

describe('parseLabelBarcode', () => {
  it('reads the ship-to address, ZIP and tracking number', () => {
    expect(parseLabelBarcode(groundBarcode)).toEqual({
      customerName: 'JORDAN SAMPLE',
      street: '1482 W CEDAR HOLLOW DR',
      addressLine2: 'APT 12',
      city: 'EAGLE MOUNTAIN',
      state: 'UT',
      zip: '84043',
      trackingNumber: '794612761758',
      source: 'barcode',
    } satisfies LabelAddress);
  });

  it('works without an address line 2 or the year prefix on the ZIP', () => {
    const payload = `[)>${RS}01${GS}84043${GS}840${GS}019${GS}794612761758${GS}FDEG${GS}1${GS}328${GS}${GS}1/1${GS}1LB${GS}N${GS}52 OAK ST${GS}LEHI${GS}UT${GS}PAT DOE${RS}${EOT}`;
    expect(parseLabelBarcode(payload)).toMatchObject({ street: '52 OAK ST', addressLine2: null, city: 'LEHI', zip: '84043' });
  });

  it('accepts control characters printed as control pictures (␝ ␞ ␠)', () => {
    const pictures = groundBarcode.replace(/[\x00-\x20]/g, (c) => String.fromCharCode(0x2400 + c.charCodeAt(0)));
    expect(parseLabelBarcode(pictures)).toEqual(parseLabelBarcode(groundBarcode));
  });

  it('returns null for other barcodes', () => {
    expect(parseLabelBarcode('794612761758')).toBeNull();
    expect(parseLabelBarcode(`[)>${RS}01${GS}0284043${GS}840${GS}019${GS}794612761758${RS}${EOT}`)).toBeNull();
  });
});

describe('trackingFromLinearBarcode', () => {
  it('takes the last 12 digits of a 34-digit "96" barcode', () => {
    expect(trackingFromLinearBarcode('9622001900008000257000794612761758')).toBe('794612761758');
    expect(trackingFromLinearBarcode('794612761758')).toBe('794612761758');
    expect(trackingFromLinearBarcode('ABC')).toBeNull();
  });
});

describe('parseLabelText (OCR fallback)', () => {
  it('reads the TO block and skips test/phone/ref lines', () => {
    const text = [
      'ORIGIN ID:AVXA (123) 456-7890 SHIP DATE: 06DEC21',
      'SAMPLE SENDER',
      '3400 BIRCH ST',
      'LOS ANGELES, CA 90011',
      'UNITED STATES US BILL SENDER',
      'TO JORDAN SAMPLE',
      'ACME TRADING',
      '2740 Kenwood Place',
      '**TEST LABEL - DO NOT SHIP**',
      'FORT LAUDERDALE FL 33301',
      '(111) 111-1111 REF: 1234',
      'TRK# 7946 3599 4149',
    ].join('\n');
    expect(parseLabelText(text)).toEqual({
      customerName: 'JORDAN SAMPLE',
      street: '2740 KENWOOD PLACE',
      addressLine2: null,
      city: 'FORT LAUDERDALE',
      state: 'FL',
      zip: '33301',
      trackingNumber: '794635994149',
      source: 'ocr',
    } satisfies LabelAddress);
  });

  it('without a TO marker, uses the last city line with a street above it', () => {
    const text = ['FROM SENDER CO', '1 SENDER WAY', 'MEMPHIS TN 38118', 'PAT DOE', '52 OAK ST', 'STE 4', 'LEHI, UT 84043-1234'].join('\n');
    expect(parseLabelText(text)).toMatchObject({ street: '52 OAK ST', addressLine2: 'STE 4', city: 'LEHI', state: 'UT', zip: '84043' });
  });

  it('returns null when there is no address', () => {
    expect(parseLabelText('FedEx\nGround\n||||| ||||')).toBeNull();
  });
});

const draft = (n: number, addressRaw: string, extra: Partial<StopDraft> = {}): StopDraft => ({
  stopNumber: n, stopType: 'delivery', shelfId: '6000', packageCount: 1, customerName: null,
  addressRaw, addressLine2: null, completed: false, ...extra,
});
const label = (street: string, extra: Partial<LabelAddress> = {}): LabelAddress => ({
  customerName: null, street, addressLine2: null, city: null, state: null, zip: '84043', trackingNumber: null, source: 'ocr', ...extra,
});

describe('matchLabelToStops', () => {
  const stops = [
    draft(1, '1482 W CEDAR HOLLOW DR'),
    draft(2, '11316 N EAGLE LAKE B…'),
    draft(3, '500 MAIN ST', { addressLine2: 'APT 1' }),
    draft(4, '500 MAIN ST', { addressLine2: 'APT 2' }),
    draft(5, '77 ELM AVE', { trackingNumbers: ['111122223333'] }),
  ];

  it('normalizes street words', () => {
    expect(addressTokens('1482 West Cedar Hollow Drive')).toEqual(['1482', 'W', 'CEDAR', 'HOLLOW', 'DR']);
  });

  it('matches by address, abbreviations and truncation included', () => {
    expect(matchLabelToStops(label('1482 WEST CEDAR HOLLOW DRIVE'), stops)).toMatchObject({ kind: 'address', stop: { stopNumber: 1 } });
    expect(matchLabelToStops(label('11316 N EAGLE LAKE BLVD'), stops)).toMatchObject({ kind: 'address', stop: { stopNumber: 2 } });
  });

  it('picks the right apartment', () => {
    expect(matchLabelToStops(label('500 MAIN ST', { addressLine2: 'APT 2' }), stops)).toMatchObject({ stop: { stopNumber: 4 } });
  });

  it('matches a tracking number scanned before', () => {
    expect(matchLabelToStops(label('9 NOWHERE RD', { trackingNumber: '111122223333' }), stops)).toMatchObject({ kind: 'tracking', stop: { stopNumber: 5 } });
  });

  it('does not match a different house number or street', () => {
    expect(matchLabelToStops(label('1484 W CEDAR HOLLOW DR'), stops).kind).toBe('none');
    expect(matchLabelToStops(label('1482 W CEDAR PARK DR'), stops).kind).toBe('none');
  });

  it('builds a new stop from a label', () => {
    expect(stopFromLabel(label('9 NOWHERE RD', { trackingNumber: '123412341234', city: 'LEHI', state: 'UT' }), 57)).toMatchObject({
      stopNumber: 57, addressRaw: '9 NOWHERE RD', source: 'label', city: 'LEHI', state: 'UT', zip: '84043', trackingNumbers: ['123412341234'], packageCount: 1,
    });
  });
});
