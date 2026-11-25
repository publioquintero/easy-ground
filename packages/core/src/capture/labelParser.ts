import type { StopDraft } from '../model';

/**
 * FedEx package labels (source 6 in docs/PLAN.md): the recipient read from a photo of the
 * label, for boxes that are on the truck but not on the manifest.
 *
 * Two readers, tried in order:
 * 1. The 2D barcode (PDF417 / MaxiCode). FedEx Ground encodes it in the ANSI MH10.8.3
 *    "[)>RS01GS…" format, which carries the ship-to street, city, state, ZIP and name.
 *    The exact field layout isn't published, so the parser locates fields by shape
 *    (ZIP, 2-letter state, house number) instead of trusting fixed positions.
 * 2. OCR text of the "TO" block, when the barcode can't be read (glare, creases).
 */

export interface LabelAddress {
  customerName: string | null;
  /** House number + street, e.g. "2740 KENWOOD PL". */
  street: string;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  trackingNumber: string | null;
  source: 'barcode' | 'ocr';
}

const RS = '\x1e';
const GS = '\x1d';

const clean = (s: string | undefined | null) =>
  (s ?? '').replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
const orNull = (s: string) => (s === '' ? null : s);

const STATE_RE = /^[A-Z]{2}$/;
const STREET_RE = /^\d+[A-Z]?(-\d+)?\s+\S+/;
const UNIT_RE = /^(APT|APARTMENT|UNIT|STE|SUITE|#|BLDG|BUILDING|LOT|SPC|SPACE|TRLR|FL|FLOOR|RM|ROOM)\b/;

/** ZIP from a "postal code" field, which may carry a 2-digit year prefix ("02" + ZIP). */
function zipFromField(field: string): string | null {
  const digits = field.replace(/\D/g, '');
  if (digits.length === 5 || digits.length === 9) return digits.slice(0, 5);
  if (digits.length === 7 || digits.length === 11) return digits.slice(2, 7);
  return null;
}

/** FedEx tracking numbers: 12 digits (Express/Ground) or 15 (Ground). */
const TRACKING_RE = /^(\d{12}|\d{15})$/;

/**
 * Parse the text of a FedEx label's 2D barcode. Returns null when it isn't the
 * "[)>" format or has no street address (Express labels may encode the address compressed).
 */
export function parseLabelBarcode(raw: string): LabelAddress | null {
  // Readers may print control characters as Unicode "control pictures" (␝ U+241D, ␠ U+2420…).
  const text = raw.replace(/[\u2400-\u2420]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x2400));
  const start = text.indexOf('[)>');
  if (start < 0) return null;
  // Format 01 is the shipment data; later formats (06, 07) are carrier extras.
  const records = text.slice(start + 3).split(RS);
  const record = records.find((r) => r.startsWith('01' + GS));
  if (!record) return null;
  const fields = record.split(GS).slice(1).map((f) => f.replace(/\x04/g, '').trim());

  const zip = zipFromField(fields[0] ?? '');
  const trackingNumber = fields.find((f) => TRACKING_RE.test(f)) ?? null;

  // Ship-to block: street, [line 2…], city, state, name. Find it by its street field.
  const streetAt = fields.findIndex((f, i) => i > 3 && STREET_RE.test(clean(f)));
  if (streetAt < 0) return null;
  const rest = fields.slice(streetAt + 1).map(clean);
  const stateAt = rest.findIndex((f) => STATE_RE.test(f));
  if (stateAt < 1) return null;

  const between = rest.slice(0, stateAt - 1).filter(Boolean);
  return {
    street: clean(fields[streetAt]),
    addressLine2: orNull(between.join(' ')),
    city: orNull(rest[stateAt - 1]),
    state: rest[stateAt],
    customerName: orNull(rest.slice(stateAt + 1).find(Boolean) ?? ''),
    zip,
    trackingNumber,
    source: 'barcode',
  };
}

/** Tracking number from the 1D barcode: "96…" Ground barcodes end with the 12-digit number. */
export function trackingFromLinearBarcode(text: string): string | null {
  const digits = text.replace(/\D/g, '');
  if (digits.length === 34 && digits.startsWith('96')) return digits.slice(-12);
  if (TRACKING_RE.test(digits)) return digits;
  return null;
}

const CITY_LINE_RE = /^(.*?[A-Z].*?)[\s,.]+([A-Z]{2})[\s.]+(\d{5})(?:-?\d{4})?\b/;
const NOISE_RE = /TEST LABEL|DO NOT SHIP|^\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}\b|^(REF|INV|PO|DEPT|TRK|BILL)\b|\bUNITED STATES\b|^US$/;
const TRACKING_TEXT_RE = /TRK#?\s*([\d ]{12,19})/;

/**
 * Parse the OCR text of a label: the block after "TO" (name, company, street, line 2)
 * ending with "CITY ST 12345". Falls back to the last city line that has a street above it,
 * since the sender ("FROM") block is printed first.
 */
export function parseLabelText(text: string): LabelAddress | null {
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  const toAt = lines.findIndex((l) => /^(SHIP\s*)?TO\b[:\s]*/.test(l) && !/^TOTAL/.test(l));

  const cityAt = (from: number) => {
    for (let i = from; i < lines.length && i < from + 9; i++) if (CITY_LINE_RE.test(lines[i])) return i;
    return -1;
  };

  let blockStart = -1;
  let cityIdx = -1;
  if (toAt >= 0) {
    cityIdx = cityAt(toAt);
    blockStart = toAt;
  }
  if (cityIdx < 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!CITY_LINE_RE.test(lines[i])) continue;
      const above = lines.slice(Math.max(0, i - 4), i);
      if (above.some((l) => STREET_RE.test(l))) {
        cityIdx = i;
        blockStart = Math.max(0, i - 4);
        break;
      }
    }
  }
  if (cityIdx < 0) return null;

  const block = lines
    .slice(blockStart, cityIdx)
    .map((l, i) => (i === 0 && blockStart === toAt ? l.replace(/^(SHIP\s*)?TO\b[:\s]*/, '') : l))
    .filter((l) => l !== '' && !NOISE_RE.test(l));
  const streetAt = block.findIndex((l) => STREET_RE.test(l));
  if (streetAt < 0) return null;

  const [, city, state, zip] = CITY_LINE_RE.exec(lines[cityIdx])!;
  const after = block.slice(streetAt + 1);
  const tracking = TRACKING_TEXT_RE.exec(lines.join('\n'))?.[1].replace(/\D/g, '') ?? null;
  return {
    customerName: block[0] && streetAt > 0 ? block[0] : null,
    street: block[streetAt],
    addressLine2: orNull(after.filter((l) => UNIT_RE.test(l)).join(' ')),
    city: orNull(clean(city).replace(/[,.]$/, '')),
    state,
    zip,
    trackingNumber: tracking && TRACKING_RE.test(tracking) ? tracking : null,
    source: 'ocr',
  };
}

// ---------------------------------------------------------------------------------------
// Matching a label to the route's stops.

const ABBREVIATIONS: Record<string, string> = {
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
  STREET: 'ST', AVENUE: 'AVE', AV: 'AVE', ROAD: 'RD', DRIVE: 'DR', LANE: 'LN', COURT: 'CT', PLACE: 'PL',
  CIRCLE: 'CIR', BOULEVARD: 'BLVD', PARKWAY: 'PKWY', HIGHWAY: 'HWY', TERRACE: 'TER', TRAIL: 'TRL',
  WAY: 'WAY', LOOP: 'LOOP', COVE: 'CV', POINT: 'PT', SQUARE: 'SQ', CROSSING: 'XING',
};
const DIRECTIONS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

/** Uppercase tokens with common words abbreviated, so "2740 Kenwood Place" == "2740 KENWOOD PL". */
export function addressTokens(address: string): string[] {
  return clean(address)
    .replace(/(…|\.\.\.)$/, '')
    .replace(/[.,#]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((t) => ABBREVIATIONS[t] ?? t);
}

export type LabelMatch =
  | { kind: 'tracking'; stop: StopDraft }
  | { kind: 'address'; stop: StopDraft }
  | { kind: 'none' };

/**
 * Find the stop a label belongs to: first by a tracking number already scanned, then by
 * address (same house number and street name; the manifest's address may be truncated,
 * so a prefix of the label's street is enough).
 */
export function matchLabelToStops(label: LabelAddress, stops: StopDraft[]): LabelMatch {
  if (label.trackingNumber) {
    const stop = stops.find((s) => s.trackingNumbers?.includes(label.trackingNumber!));
    if (stop) return { kind: 'tracking', stop };
  }

  const want = addressTokens(label.street);
  const [house, ...streetWords] = want;
  const wantName = streetWords.filter((t) => !DIRECTIONS.has(t));
  let best: { stop: StopDraft; score: number } | null = null;
  for (const stop of stops) {
    const [h, ...rest] = addressTokens(stop.addressRaw);
    if (h !== house) continue;
    const name = rest.filter((t) => !DIRECTIONS.has(t));
    if (name.length === 0 || wantName.length === 0) continue;
    // Every word the stop has must agree with the label; the last may be cut off ("B…").
    const agrees = name.every((t, i) =>
      i === name.length - 1 && i < wantName.length ? wantName[i].startsWith(t) : wantName[i] === t,
    );
    if (!agrees) continue;
    let score = name.length;
    const unit = clean(label.addressLine2);
    if (unit && clean(stop.addressLine2) === unit) score += 10;
    else if (unit && stop.addressLine2) score -= 10; // a different apartment at the same building
    if (!best || score > best.score) best = { stop, score };
  }
  return best && best.score > 0 ? { kind: 'address', stop: best.stop } : { kind: 'none' };
}

/** A new stop for a label that matched nothing on the route. */
export function stopFromLabel(label: LabelAddress, stopNumber: number): StopDraft {
  return {
    stopNumber,
    stopType: 'delivery',
    shelfId: null,
    packageCount: 1,
    customerName: label.customerName,
    addressRaw: label.street,
    addressLine2: label.addressLine2,
    completed: false,
    source: 'label',
    city: label.city,
    state: label.state,
    zip: label.zip,
    trackingNumbers: label.trackingNumber ? [label.trackingNumber] : [],
  };
}
