import type { StopDraft } from '../model';

/**
 * A piece of text with its position on a page. Every capture source (PDF text layer,
 * OCR of a screenshot) is converted to this, so the parsers don't care where text came from.
 *
 * Coordinates are top-down (y grows downward) in the source's own units (PDF points,
 * image pixels…). `y` must use the same reference (baseline, top or center) for all items.
 */
export interface TextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
  /** Line id from the source (OCR engines group tilted text into lines better than y does). */
  line?: number;
}

export type ParseIssueKind =
  | 'header_not_found'
  | 'unparsed_row'
  | 'missing_field'
  | 'truncated_address'
  | 'suspect_house_number'
  | 'inferred_stop_number'
  | 'duplicate_stop';

export interface ParseIssue {
  kind: ParseIssueKind;
  stopNumber?: number;
  page?: number;
  detail: string;
}

export interface ParseResult {
  stops: StopDraft[];
  issues: ParseIssue[];
}
