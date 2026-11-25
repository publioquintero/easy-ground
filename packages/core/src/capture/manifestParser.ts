import type { StopDraft } from '../model';
import type { ParseIssue, ParseResult, TextItem } from './types';

/**
 * Parser for GroundCloud's Manifest View table, from any positioned-text source
 * (PDF text layer or OCR). Columns are located from the header row, so it tolerates
 * different widths, column orders and hidden columns (FILTER) — see docs/PLAN.md §3.
 */

type ColumnKey =
  | 'stopNumber'
  | 'stopType'
  | 'shelfId'
  | 'packageCount'
  | 'customerName'
  | 'address'
  | 'addressLine2'
  | 'status';

const HEADER_PATTERNS: ReadonlyArray<[ColumnKey, RegExp]> = [
  ['stopNumber', /^#/],
  // OCR often misreads the "P" ("D/e", "D/F").
  ['stopType', /^D\s*\/\s*\S?$/i],
  ['shelfId', /^SID$/i],
  ['packageCount', /^Pkgs?$/i],
  ['customerName', /^Name$/i],
  ['addressLine2', /^Address\s*2$/i],
  ['address', /^Address$/i],
  ['status', /^Status$/i],
];

/**
 * Columns that must be present to accept a line as the header. The tiny "#" header is
 * often lost by OCR; when missing, everything left of the first found column is "#".
 */
const REQUIRED_HEADER: ColumnKey[] = ['address'];
const MIN_HEADER_COLUMNS = 4;

/** Status text: "Delivered 02/10 @ 23:32", "Attempted …", or the DELIVER / ATTEMPT buttons. */
const STATUS_START = /^(delivered|attempted|deliver|attempt)$/i;
const COMPLETED_STATUS = /\b(delivered|attempted)\b/i;
// GroundCloud addresses carry no periods, so a trailing "." is a truncation "…" seen by OCR.
const ELLIPSIS = /(…|\.+)\s*$/;

interface Column {
  key: ColumnKey;
  x: number;
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Group items of one page into visual lines, each sorted left→right. OCR sources give their
 * own line ids, which follow tilted text (a photo of a screen); otherwise lines are grouped by y.
 */
function groupLines(items: TextItem[]): TextItem[][] {
  if (items.length > 0 && items.every((i) => i.line !== undefined)) {
    const byLine = new Map<number, TextItem[]>();
    for (const item of items) byLine.set(item.line!, [...(byLine.get(item.line!) ?? []), item]);
    return [...byLine.values()]
      .sort((a, b) => median(a.map((i) => i.y)) - median(b.map((i) => i.y)))
      .map((line) => line.sort((a, b) => a.x - b.x));
  }
  const tolerance = Math.max(1, median(items.map((i) => i.height)) * 0.5);
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: { y: number; items: TextItem[] }[] = [];
  for (const item of sorted) {
    const line = lines.at(-1);
    if (line && Math.abs(item.y - line.y) <= tolerance) {
      line.items.push(item);
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }
  return lines.map((l) => l.items.sort((a, b) => a.x - b.x));
}

/** Merge OCR-split header words ("Address" + "2") into one token. */
function headerTokens(line: TextItem[]): { text: string; x: number }[] {
  const tokens: { text: string; x: number }[] = [];
  for (const item of line) {
    const prev = tokens.at(-1);
    if (prev && /^Address$/i.test(prev.text) && /^2$/.test(item.text.trim())) {
      prev.text = 'Address 2';
    } else {
      tokens.push({ text: item.text.trim(), x: item.x });
    }
  }
  return tokens;
}

function detectHeader(line: TextItem[]): Column[] | null {
  const columns: Column[] = [];
  for (const token of headerTokens(line)) {
    const match = HEADER_PATTERNS.find(([, re]) => re.test(token.text));
    if (match && !columns.some((c) => c.key === match[0])) {
      columns.push({ key: match[0], x: token.x });
    }
  }
  const keys = new Set(columns.map((c) => c.key));
  if (columns.length < MIN_HEADER_COLUMNS || !REQUIRED_HEADER.every((k) => keys.has(k))) {
    return null;
  }
  if (!keys.has('stopNumber')) columns.push({ key: 'stopNumber', x: -Infinity });
  return columns.sort((a, b) => a.x - b.x);
}

function columnFor(item: TextItem, columns: Column[], tolerance: number): ColumnKey {
  let key = columns[0].key;
  for (const col of columns) {
    if (item.x + tolerance >= col.x) key = col.key;
  }
  return key;
}

/**
 * PDF text extraction can merge two neighboring cells into one run when the first one
 * almost fills its column ("ROCKWELL CHARTER HIGH SCHOOL 3435 E STONEBRIDGE LN"). Split an
 * item that crosses a column start at the space closest to that boundary.
 */
function splitAcrossColumns(item: TextItem, columns: Column[], tolerance: number): TextItem[] {
  const text = item.text;
  if (item.width <= 0 || !text.includes(' ')) return [item];
  const charWidth = item.width / text.length;
  const end = item.x + item.width;
  const boundary = columns.find((c) => Number.isFinite(c.x) && c.x > item.x + tolerance && c.x < end - tolerance);
  if (!boundary) return [item];

  let best = -1;
  let bestGap = Infinity;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ' ') continue;
    const gap = Math.abs(item.x + (i + 1) * charWidth - boundary.x);
    if (gap < bestGap) [best, bestGap] = [i, gap];
  }
  if (best < 0 || bestGap > charWidth * 4) return [item];

  const left = text.slice(0, best).trimEnd();
  const right = text.slice(best + 1).trimStart();
  if (!left || !right) return [item];
  // Character widths vary (proportional fonts), so the estimate can land a few points short
  // of the boundary; the right part belongs to the column we split for.
  const rightX = Math.max(item.x + (best + 1) * charWidth, boundary.x);
  return [
    { ...item, text: left, width: left.length * charWidth },
    ...splitAcrossColumns({ ...item, text: right, x: rightX, width: end - rightX }, columns, tolerance),
  ];
}

/**
 * Follow column drift down the table. In a photo taken at an angle every row is a little
 * shifted from the one above, so each column moves to where its cells actually started in
 * the last row — when that is close to the estimate. Columns with no cell in the row move
 * like their nearest observed neighbors. On a straight PDF/screenshot nothing moves.
 */
function trackColumns(columns: Column[], starts: Map<ColumnKey, number>, lineHeight: number): Column[] {
  const deltas = columns.map((col, i) => {
    const start = starts.get(col.key);
    if (start === undefined || !Number.isFinite(col.x)) return null;
    const gaps = [columns[i - 1], columns[i + 1]]
      .filter((n) => n !== undefined && Number.isFinite(n.x))
      .map((n) => Math.abs(n.x - col.x));
    // Real drift is a few pixels per row; a bigger jump means the cell's first word was lost.
    const maxShift = Math.min(lineHeight * 1.5, ...gaps.map((g) => g * 0.4));
    return Math.abs(start - col.x) <= maxShift ? start - col.x : null;
  });
  const known = deltas
    .map((delta, i) => ({ delta, x: columns[i].x }))
    .filter((d): d is { delta: number; x: number } => d.delta !== null);
  if (known.length === 0) return columns;
  return columns.map((col, i) => {
    if (!Number.isFinite(col.x)) return col;
    const nearest = [...known].sort((a, b) => Math.abs(a.x - col.x) - Math.abs(b.x - col.x))[0];
    return { ...col, x: col.x + (deltas[i] ?? nearest.delta) };
  });
}

/** Split a row into its status part (and everything right of it) and the rest. */
function splitStatus(line: TextItem[]): { rest: TextItem[]; status: string } {
  // Skip the first items: a stop number or name never starts the status.
  const idx = line.findIndex((item, i) => i >= 2 && STATUS_START.test(item.text.trim().split(/\s+/)[0]));
  if (idx === -1) return { rest: line, status: '' };
  return {
    rest: line.slice(0, idx),
    status: clean(line.slice(idx).map((i) => i.text).join(' ')),
  };
}

/** A plain house number. Anything else ("10M", "M316", "12A") goes to review. */
const HOUSE_NUMBER = /^\d+$/;

/** Fix common OCR letter↔digit confusions, only in tokens that are otherwise numeric. */
function normalizeDigits(text: string): string {
  return text
    .split(' ')
    .map((t) => (/^[\dOoIl|!]+$/.test(t) && /\d/.test(t) ? t.replace(/[Oo]/g, '0').replace(/[Il|!]/g, '1') : t))
    .join(' ');
}

interface Row {
  text: string;
  /** Vertical position of the row, to tell its slot on screen even if rows above were lost. */
  y: number;
  stopNumber: number | null;
  stopNumberInferred: boolean;
  stopType: StopDraft['stopType'];
  packages: number | null;
  status: string;
  cell: (key: ColumnKey) => string;
  /** Where each column's first item starts in this row (for drift tracking). */
  starts: Map<ColumnKey, number>;
}

/** Read one table line, or null when it is clearly not a stop (title, footer, toolbar). */
function readRow(rawLine: TextItem[], columns: Column[], tolerance: number, lineHeight: number): Row | null {
  const line = rawLine.flatMap((item) => splitAcrossColumns(item, columns, tolerance));
  const { rest, status } = splitStatus(line);
  const cells = new Map<ColumnKey, string[]>();
  const starts = new Map<ColumnKey, number>();
  const lastCol = columns.at(-1)!;
  let lastEnd = -Infinity;
  for (const item of rest) {
    const key = columnFor(item, columns, tolerance);
    // The unlabeled status area (DELIVER/ATTEMPT buttons, often OCR'd as junk) sits right of
    // the last column after a wide gap: drop anything there.
    if (key === lastCol.key && key !== 'status') {
      const far = starts.has(key) ? item.x - lastEnd > lineHeight * 2 : item.x - lastCol.x > lineHeight * 3;
      if (far) break;
      lastEnd = item.x + item.width;
    }
    cells.set(key, [...(cells.get(key) ?? []), item.text]);
    if (!starts.has(key)) starts.set(key, item.x);
  }
  const cell = (key: ColumnKey) => clean((cells.get(key) ?? []).join(' '));
  // Noise lines (OCR'd button art, toolbars) touch few columns and carry no address.
  if (!cell('address') && cells.size < 3) return null;

  // Without a "D/P" header the D/P letter lands in the "#" cell.
  // Without "D/P"/"SID" headers those cells land in the "#" cell too: tell them apart by
  // shape (stop # is 1–3 digits, SID 4–5 digits, D/P a single letter).
  const numberTokens = normalizeDigits(cell('stopNumber')).split(' ');
  const numberToken = numberTokens.find((t) => /^\d{1,3}$/.test(t));
  const shelfToken = numberTokens.find((t) => /^\d{4,5}$/.test(t));
  const typeToken = cell('stopType') || numberTokens.find((t) => /^[DP]$/i.test(t)) || '';
  const packagesText = normalizeDigits(cell('packageCount'));

  const stopNumber = numberToken ? Number(numberToken) : null;
  // A stop without a readable "#" still has an address starting with a (maybe misread) number.
  if (stopNumber === null && !/^\S*\d/.test(cell('address'))) return null;

  return {
    text: clean(line.map((i) => i.text).join(' ')),
    y: median(line.map((i) => i.y)),
    stopNumber,
    stopNumberInferred: false,
    stopType: /^P$/i.test(typeToken) ? 'pickup' : 'delivery',
    packages: /^\d+$/.test(packagesText) ? Number(packagesText) : null,
    status: clean(`${status} ${cell('status')}`),
    cell: (key) => (key === 'shelfId' ? cell('shelfId') || shelfToken || '' : cell(key)),
    starts,
  };
}

/**
 * Stop numbers go down the screen one by one (Manifest View sorts by "#"). OCR on thin fonts
 * misreads them ("12" → "2", "7" → "2", "11" → "Mm"), so when one sequence
 * `number = slot + offset` clearly dominates, a row whose reading is missing, lost digits,
 * repeats another row's number or breaks the ascending order takes the expected number.
 * Readings that are unique and in order are kept, so a filtered list with gaps survives.
 * Without a dominant sequence a missing number is only filled when both neighbors agree.
 */
function inferMissingStopNumbers(rows: Row[]): void {
  if (rows.length === 0) return;
  // Slot = row position counted in row heights, so a row OCR dropped entirely leaves a gap
  // instead of shifting every number below it.
  const pitch = median(rows.slice(1).map((r, i) => r.y - rows[i].y).filter((d) => d > 0)) || 1;
  const slot = (row: Row) => Math.round((row.y - rows[0].y) / pitch);
  const known = rows
    .map((row) => ({ row, index: slot(row) }))
    .filter(({ row }) => row.stopNumber !== null);

  const counts = new Map<number, number>();
  for (const k of known) {
    const offset = k.row.stopNumber! - k.index;
    counts.set(offset, (counts.get(offset) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [offset, support] = ranked[0] ?? [0, 0];
  const runnerUp = ranked[1]?.[1] ?? 0;
  const dominant = support >= 3 && (support >= runnerUp * 2 || support / known.length >= 0.5);

  if (dominant) {
    const readCounts = new Map<number, number>();
    for (const r of rows) if (r.stopNumber !== null) readCounts.set(r.stopNumber, (readCounts.get(r.stopNumber) ?? 0) + 1);
    let previous = -Infinity;
    for (const row of rows) {
      const expected = slot(row) + offset;
      const read = row.stopNumber;
      const wrong =
        read === null ||
        (read !== expected &&
          (String(expected).endsWith(String(read)) || readCounts.get(read)! > 1 || read <= previous));
      if (wrong) {
        row.stopNumber = expected;
        row.stopNumberInferred = true;
      }
      previous = row.stopNumber!;
    }
    return;
  }

  rows.forEach((row) => {
    if (row.stopNumber !== null) return;
    const index = slot(row);
    const prev = known.filter((k) => k.index < index).at(-1);
    const next = known.find((k) => k.index > index);
    if (prev && next && prev.row.stopNumber! - prev.index === next.row.stopNumber! - next.index) {
      row.stopNumber = index + prev.row.stopNumber! - prev.index;
      row.stopNumberInferred = true;
    }
  });
}

export function parseManifest(items: TextItem[]): ParseResult {
  const issues: ParseIssue[] = [];
  const byNumber = new Map<number, StopDraft>();
  const pages = [...new Set(items.map((i) => i.page))].sort((a, b) => a - b);
  let columns: Column[] | null = null;

  for (const page of pages) {
    const pageItems = items.filter((i) => i.page === page && i.text.trim() !== '');
    const lines = groupLines(pageItems);
    const lineHeight = median(pageItems.map((i) => i.height));
    const tolerance = lineHeight * 0.4;

    // Each page may repeat the header; screenshots of later pages may not have it.
    let start = 0;
    const headerIdx = lines.findIndex((l) => detectHeader(l) !== null);
    if (headerIdx !== -1) {
      columns = detectHeader(lines[headerIdx]);
      start = headerIdx + 1;
    } else if (!columns) {
      issues.push({ kind: 'header_not_found', page, detail: 'Column header row not found' });
      continue;
    }

    // Track drift with a per-page copy, so the next page starts again from the header.
    let tracked = columns!;
    const rows: Row[] = [];
    for (const line of lines.slice(start)) {
      const row = readRow(line, tracked, tolerance, lineHeight);
      if (!row) continue;
      rows.push(row);
      tracked = trackColumns(tracked, row.starts, lineHeight);
    }
    inferMissingStopNumbers(rows);

    for (const row of rows) {
      if (row.stopNumber === null) {
        issues.push({ kind: 'unparsed_row', page, detail: row.text });
        continue;
      }
      const { stopNumber } = row;
      if (row.stopNumberInferred) {
        issues.push({ kind: 'inferred_stop_number', stopNumber, page, detail: `"#" unreadable, assumed ${stopNumber}` });
      }
      if (row.packages === null) {
        issues.push({ kind: 'missing_field', stopNumber, page, detail: `Unreadable Pkgs: "${row.cell('packageCount')}"` });
      }
      const address = row.cell('address');
      if (!address) {
        issues.push({ kind: 'missing_field', stopNumber, page, detail: 'Missing address' });
      } else {
        if (ELLIPSIS.test(address)) {
          issues.push({ kind: 'truncated_address', stopNumber, page, detail: address });
        }
        const [houseNumber, ...street] = address.split(' ');
        if (!HOUSE_NUMBER.test(houseNumber) || street.length === 0) {
          issues.push({ kind: 'suspect_house_number', stopNumber, page, detail: address });
        }
      }

      const stop: StopDraft = {
        stopNumber,
        stopType: row.stopType,
        shelfId: normalizeDigits(row.cell('shelfId')) || null,
        packageCount: row.packages ?? 1,
        customerName: row.cell('customerName') || null,
        addressRaw: address,
        addressLine2: row.cell('addressLine2') || null,
        completed: COMPLETED_STATUS.test(row.status),
      };

      if (byNumber.has(stopNumber)) {
        // Overlapping screenshots repeat rows: keep the first reading.
        issues.push({ kind: 'duplicate_stop', stopNumber, page, detail: `Stop ${stopNumber} appears more than once` });
        continue;
      }
      byNumber.set(stopNumber, stop);
    }
  }

  const stops = [...byNumber.values()].sort((a, b) => a.stopNumber - b.stopNumber);
  return { stops, issues };
}
