import type { StopDraft } from '../model';
import type { ParseIssue, ParseResult, TextItem } from './types';

/**
 * Parser for GroundCloud's printed manifest (Manifest View → 🖨️ → Save to Files). Unlike the
 * on-screen table it is a numbered list, one stop per record:
 *
 *   14. 22 S 1400 W CENTERVILLE UT 84014 SID: 1031, Packages: 2. Delivery.
 *   13. 235 N 1250 W STE 200 CENTERVILLE UT 84014 SID: 1013 FL, Packages: 1. Delivery.
 *
 * It has the full address with city/state/ZIP (no "…" truncation) but no customer name and
 * no status. A record may wrap onto the next line. Removed stops leave gaps in the numbering.
 * "FL" after the SID means the packages are on the floor, not on the shelf: kept in shelfId.
 */

const RECORD =
  /(\d{1,4})\.\s+(.+?)\s+SID:\s*(\d+(?:\s+[A-Z]{1,3})?)\s*,\s*Packages:\s*(\d+)\s*\.\s*(Pickup|Delivery)\b\.?/gi;

/** Enough of these in the text means the document is a printed manifest. */
const RECORD_HINT = /SID:\s*\d+[^,]*,\s*Packages:\s*\d+/gi;

const CITY_STATE_ZIP = /^(.*?)\s+([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/;

/** Tokens that end a street: grid directions and USPS street suffixes (not words found in city names). */
const STREET_END = new Set([
  'N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW',
  'ALY', 'AVE', 'BLVD', 'CIR', 'CT', 'CV', 'DR', 'EXPY', 'FWY', 'HWY', 'LN', 'LOOP', 'PKWY', 'PL', 'PLZ',
  'RD', 'ROW', 'RUN', 'SQ', 'ST', 'TER', 'TRL', 'WAY', 'XING',
]);

/** Secondary unit designators; the token after each one is the unit itself ("STE 200", "# B"). */
const UNIT = /^(STE|SUITE|UNIT|APT|BLDG|SPC|LOT|RM|FL|#)$/;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** All text in reading order, one string (lines joined with spaces so wrapped records rejoin). */
function readingText(items: TextItem[]): string {
  const pages = [...new Set(items.map((i) => i.page))].sort((a, b) => a - b);
  return pages
    .map((page) => {
      const pageItems = items.filter((i) => i.page === page);
      const heights = pageItems.map((i) => i.height).sort((a, b) => a - b);
      const tolerance = Math.max(1, (heights[Math.floor(heights.length / 2)] ?? 1) * 0.5);
      return [...pageItems]
        .sort((a, b) => (Math.abs(a.y - b.y) <= tolerance ? a.x - b.x : a.y - b.y))
        .map((i) => i.text)
        .join(' ');
    })
    .join(' ');
}

export function isPrintedManifest(items: TextItem[]): boolean {
  return (readingText(items).match(RECORD_HINT)?.length ?? 0) >= 2;
}

interface SplitAddress {
  street: string;
  unit: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

/** "235 N 1250 W STE 200 CENTERVILLE UT 84014" → street / unit / city / state / ZIP. */
export function splitPrintedAddress(text: string): SplitAddress {
  const m = CITY_STATE_ZIP.exec(clean(text));
  if (!m) return { street: clean(text), unit: null, city: null, state: null, zip: null };
  const [, beforeState, state, zip] = m;
  const tokens = beforeState.split(' ');

  // The street ends at the last suffix/direction token, then an optional unit; the rest is the city.
  let end = -1;
  // A suffix right after another one starts the city ("100 S ST GEORGE", "MAIN ST ST GEORGE").
  for (let i = 1; i < tokens.length - 1; i++) {
    if (STREET_END.has(tokens[i]) && !(end === i - 1 && STREET_END.has(tokens[i - 1]))) end = i;
  }
  let unit: string | null = null;
  let cityStart = end + 1;
  if (end > 0 && cityStart < tokens.length - 1 && UNIT.test(tokens[cityStart])) {
    unit = `${tokens[cityStart]} ${tokens[cityStart + 1]}`;
    cityStart += 2;
  } else if (end > 0 && /^#\S+$/.test(tokens[cityStart] ?? '') && cityStart < tokens.length - 1) {
    unit = tokens[cityStart];
    cityStart += 1;
  }
  if (end <= 0 || cityStart >= tokens.length) {
    // No recognizable street end: keep everything as the street, ZIP still helps geocoding.
    return { street: beforeState, unit: null, city: null, state, zip };
  }
  return {
    street: tokens.slice(0, end + 1).join(' '),
    unit,
    city: tokens.slice(cityStart).join(' '),
    state,
    zip,
  };
}

export function parsePrintedManifest(items: TextItem[]): ParseResult {
  const issues: ParseIssue[] = [];
  const byNumber = new Map<number, StopDraft>();
  const text = readingText(items);

  for (const m of text.matchAll(RECORD)) {
    const [, number, address, sid, packages, type] = m;
    const stopNumber = Number(number);
    const split = splitPrintedAddress(address);
    const shelfId = clean(sid);

    if (!/^\d+\s/.test(split.street)) {
      issues.push({ kind: 'suspect_house_number', stopNumber, detail: split.street });
    }
    if (!split.city) {
      issues.push({ kind: 'missing_field', stopNumber, detail: `City not found in "${clean(address)}"` });
    }
    if (byNumber.has(stopNumber)) {
      issues.push({ kind: 'duplicate_stop', stopNumber, detail: `Stop ${stopNumber} appears more than once` });
      continue;
    }
    byNumber.set(stopNumber, {
      stopNumber,
      stopType: /pickup/i.test(type) ? 'pickup' : 'delivery',
      // "0" is a real SID (pickups use it), kept like any other.
      shelfId,
      packageCount: Number(packages),
      customerName: null,
      addressRaw: split.street,
      addressLine2: split.unit,
      completed: false,
      city: split.city,
      state: split.state,
      zip: split.zip,
    });
  }

  // Numbered lines the record pattern missed (layout changes, garbled text) must not vanish silently.
  const seen = new Set(byNumber.keys());
  for (const m of text.matchAll(/(?:^|\s)(\d{1,4})\.\s+\d+\s[^.]*?SID:/g)) {
    const n = Number(m[1]);
    if (!seen.has(n)) issues.push({ kind: 'unparsed_row', stopNumber: n, detail: clean(m[0]) });
  }

  const stops = [...byNumber.values()].sort((a, b) => a.stopNumber - b.stopNumber);
  return { stops, issues };
}
