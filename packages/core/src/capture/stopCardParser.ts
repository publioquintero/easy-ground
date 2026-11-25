import type { StopDraft, StopSource } from '../model';
import { addressTokens, matchLabelToStops } from './labelParser';
import type { ParseIssue } from './types';

/**
 * GroundCloud's stop card (source 3 in docs/PLAN.md): the panel GroundCloud shows for one
 * stop, read from frames of a screen recording (or screenshots) while the driver swipes
 * through the stops. Each frame is OCR'd to plain text; the card looks like:
 *
 *   3276 S LENOX ST
 *   MILWAUKEE, WI 53207
 *   DELIVERY | 1 PKG | SID: 1506
 *   LISA DOE
 *   CUST REQ:FRONT DOOR/DOORBELL BROKEN, PLEASE KNOCK
 *   START  DELIVERED  ATTEMPTED  CALL
 *
 * The rest of the screen (map labels, turn instructions) is noise. The card is found by
 * its "DELIVERY | n PKG" line, then the address above it and the name/notes below it.
 * The card doesn't show the manifest's "#", so stops are matched to the route by address.
 */
export interface StopCard {
  /** Stop number when the card shows one ("STOP 14", "#14"); usually null. */
  stopNumber: number | null;
  stopType: 'delivery' | 'pickup';
  packageCount: number;
  shelfId: string | null;
  street: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  customerName: string | null;
  customerNotes: string | null;
  /** Index of the first frame it was read from (recording order ≈ route order). */
  frame: number;
}

const clean = (s: string) => s.replace(/[|¦]/g, ' | ').replace(/\s+/g, ' ').trim().toUpperCase();

// "DELIVERY | 1 PKG | SID: 1506" — OCR may drop the bars or read "PKG" as "PKGS"/"PK6".
const TYPE_LINE = /\b(DELIVERY|PICKUP|PICK UP)\b\W*(\d{1,3})\s*PK[G6]S?\b(?:.*?\bSID\W*([A-Z0-9-]{1,12}))?/;
const CITY_LINE = /^(.+?),?\s+([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/;
const STREET_LINE = /^\d+[A-Z]?(-\d+)?\s+[A-Z0-9]/;
const STOP_NUMBER = /\b(?:STOP|#)\s*(\d{1,3})\b/;
const BUTTONS = /\b(START|DELIVERED|ATTEMPTED|CALL|NAVIGATE|ARRIVE)\b/;
const NAME_LINE = /^[A-Z][A-Z .,'&-]{1,60}$/;
const NOTE_START = /^(CUST|NOTE|DRIVER|GATE|CODE|LEAVE|PLEASE|DO NOT|DOG|BACK|FRONT|SIDE)/;

/** Read the stop card from one frame's OCR text, or null when there isn't one. */
export function parseStopCardText(text: string, frame = 0): StopCard | null {
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  const at = lines.findIndex((l) => TYPE_LINE.test(l));
  if (at < 0) return null;
  const [, type, pkgs, sid] = TYPE_LINE.exec(lines[at])!;

  // Address: the street line and the "CITY, ST 12345" line just above the type line.
  let city: string | null = null;
  let state: string | null = null;
  let zip: string | null = null;
  let street: string | null = null;
  for (let i = at - 1; i >= Math.max(0, at - 4); i--) {
    const m = CITY_LINE.exec(lines[i]);
    if (m && !city) {
      [city, state, zip] = [m[1].replace(/,$/, '').trim(), m[2], m[3]];
      continue;
    }
    if (STREET_LINE.test(lines[i])) {
      street = lines[i].replace(/\s*[|>›»•]+\s*$/, '').trim();
      break;
    }
  }
  if (!street) return null;

  // Below: the customer's name, then notes, until the action buttons.
  let customerName: string | null = null;
  const notes: string[] = [];
  for (let i = at + 1; i < Math.min(lines.length, at + 6); i++) {
    const line = lines[i];
    if (BUTTONS.test(line)) break;
    if (!customerName && notes.length === 0 && NAME_LINE.test(line) && !NOTE_START.test(line)) customerName = line;
    else notes.push(line);
  }

  const number = lines.slice(Math.max(0, at - 5), at + 1).map((l) => STOP_NUMBER.exec(l)).find(Boolean);
  return {
    stopNumber: number ? Number(number[1]) : null,
    stopType: type === 'DELIVERY' ? 'delivery' : 'pickup',
    packageCount: Number(pkgs),
    shelfId: sid ?? null,
    street,
    city,
    state,
    zip,
    customerName,
    customerNotes: notes.length ? notes.join(' ') : null,
    frame,
  };
}

const sameStop = (a: StopCard, b: StopCard) => addressTokens(a.street).join(' ') === addressTokens(b.street).join(' ');
/** How much of the card was read; the best reading of a stop wins. */
const completeness = (c: StopCard) =>
  (c.shelfId ? 2 : 0) + (c.zip ? 2 : 0) + (c.customerName ? 1 : 0) + (c.customerNotes?.length ?? 0) / 100;

/**
 * Cards from all frames of a recording, one per stop: the same card is on screen for many
 * frames, and it can come back later (the driver swiped back). Keeps the best reading.
 */
export function parseStopCardFrames(frames: string[]): StopCard[] {
  const cards: StopCard[] = [];
  frames.forEach((text, frame) => {
    const card = parseStopCardText(text, frame);
    if (!card) return;
    const i = cards.findIndex((c) => sameStop(c, card));
    if (i < 0) cards.push(card);
    else if (completeness(card) > completeness(cards[i])) cards[i] = { ...card, frame: cards[i].frame };
  });
  return cards;
}

export interface StopCardMerge {
  /** Stops to import: existing ones enriched with card data, and new ones. */
  stops: StopDraft[];
  issues: ParseIssue[];
  matched: number;
  added: number;
}

/**
 * Combine stop cards with the route. A card that matches a stop (by its number, else by
 * address) fills in what the manifest lacks (city/ZIP, full street, notes); a card that
 * matches nothing becomes a new stop numbered after the last one, flagged for review.
 */
export function mergeStopCards(cards: StopCard[], existing: StopDraft[]): StopCardMerge {
  const stops: StopDraft[] = [];
  const issues: ParseIssue[] = [];
  let next = existing.reduce((max, d) => Math.max(max, d.stopNumber), 0) + 1;
  let matched = 0;
  const source: StopSource = 'recording';

  for (const card of cards) {
    const byNumber = card.stopNumber !== null ? existing.find((d) => d.stopNumber === card.stopNumber) : undefined;
    const match =
      byNumber ??
      (() => {
        const m = matchLabelToStops(
          { street: card.street, addressLine2: null, city: card.city, state: card.state, zip: card.zip, customerName: null, trackingNumber: null, source: 'ocr' },
          existing,
        );
        return m.kind === 'none' ? undefined : m.stop;
      })();

    if (match) {
      matched++;
      // The manifest may have cut the street ("11316 N EAGLE LAKE B…"); the card has it whole.
      const truncated = /(…|\.\.\.)$/.test(match.addressRaw.trim());
      stops.push({
        ...match,
        addressRaw: truncated ? card.street : match.addressRaw,
        city: match.city ?? card.city,
        state: match.state ?? card.state,
        zip: match.zip ?? card.zip,
        shelfId: match.shelfId ?? card.shelfId,
        customerName: match.customerName ?? card.customerName,
        customerNotes: card.customerNotes ?? match.customerNotes ?? null,
      });
      continue;
    }

    const stopNumber = card.stopNumber !== null && !existing.some((d) => d.stopNumber === card.stopNumber) ? card.stopNumber : next++;
    if (card.stopNumber === null) {
      issues.push({ kind: 'inferred_stop_number', stopNumber, detail: `${card.street}: not on the route yet — numbered #${stopNumber} from the recording.` });
    }
    stops.push({
      stopNumber,
      stopType: card.stopType,
      shelfId: card.shelfId,
      packageCount: card.packageCount,
      customerName: card.customerName,
      addressRaw: card.street,
      addressLine2: null,
      completed: false,
      source,
      city: card.city,
      state: card.state,
      zip: card.zip,
      customerNotes: card.customerNotes,
    });
  }
  return { stops, issues, matched, added: stops.length - matched };
}
