import { describe, expect, it } from 'vitest';
import type { ParseIssue, StopDraft } from '@easy-ground/core';
import reducer, {
  areaSet,
  priorityFirstSet,
  orderModeSet,
  routeOptimized,
  initialRouteState,
  routeCleared,
  stopsLocated,
  issueDismissed,
  manifestImported,
  nextFreeStopNumber,
  stopAdded,
  stopRemoved,
  stopReviewed,
  stopUpdated,
} from './routeSlice';

const stop = (n: number, extra: Partial<StopDraft> = {}): StopDraft => ({
  stopNumber: n, stopType: 'delivery', shelfId: '6000', packageCount: 1, customerName: null,
  addressRaw: `${100 + n} MAIN ST`, addressLine2: null, completed: false, ...extra,
});
const issue = (kind: ParseIssue['kind'], stopNumber?: number): ParseIssue => ({ kind, stopNumber, page: 1, detail: '' });

const loaded = reducer(
  initialRouteState,
  manifestImported({
    stops: [stop(1), stop(2), stop(3)],
    issues: [issue('suspect_house_number', 2), issue('inferred_stop_number', 2), issue('unparsed_row'), issue('truncated_address', 3)],
    sourceName: 'test',
  }),
);

describe('route slice — review edits', () => {
  it('saves corrections and clears that stop’s flags', () => {
    const s = reducer(loaded, stopUpdated({ stopNumber: 2, changes: { addressRaw: '11316 N EAGLE LAKE BLVD' } }));
    expect(s.drafts[1].addressRaw).toBe('11316 N EAGLE LAKE BLVD');
    expect(s.issues.map((i) => i.stopNumber)).toEqual([undefined, 3]);
  });

  it('renumbers and keeps the list sorted, but refuses a taken number', () => {
    const moved = reducer(loaded, stopUpdated({ stopNumber: 1, changes: { stopNumber: 9 } }));
    expect(moved.drafts.map((d) => d.stopNumber)).toEqual([2, 3, 9]);
    const refused = reducer(loaded, stopUpdated({ stopNumber: 1, changes: { stopNumber: 3 } }));
    expect(refused).toEqual(loaded);
  });

  it('"looks right" clears flags without changing the stop', () => {
    const s = reducer(loaded, stopReviewed(3));
    expect(s.drafts).toEqual(loaded.drafts);
    expect(s.issues.some((i) => i.stopNumber === 3)).toBe(false);
  });

  it('deletes a stop with its flags', () => {
    const s = reducer(loaded, stopRemoved(2));
    expect(s.drafts.map((d) => d.stopNumber)).toEqual([1, 3]);
    expect(s.issues.some((i) => i.stopNumber === 2)).toBe(false);
  });

  it('adds a manual stop in order and ignores duplicates', () => {
    expect(nextFreeStopNumber(loaded.drafts)).toBe(4);
    const added = reducer(loaded, stopAdded(stop(4)));
    expect(added.drafts.map((d) => d.stopNumber)).toEqual([1, 2, 3, 4]);
    expect(reducer(added, stopAdded(stop(4, { addressRaw: 'X' }))).drafts).toHaveLength(4);
  });

  it('dismisses a page-level problem', () => {
    const s = reducer(loaded, issueDismissed(0));
    expect(s.issues.some((i) => i.kind === 'unparsed_row')).toBe(false);
    expect(s.issues).toHaveLength(3);
  });
});

describe('route slice — geocoding', () => {
  const geo = (id: number, status: 'ok' | 'review' | 'not_found' = 'ok') => ({
    id: String(id), status, lat: 45, lng: -93, accuracy: 'interpolated' as const, formatted: 'X',
    city: null, state: null, zip: null, street_side: null, provider: 'census', cached: false,
  });
  const located = reducer(loaded, stopsLocated([geo(1), geo(2, 'review'), geo(3)]));

  it('keeps a location when only non-address fields change', () => {
    const s = reducer(located, stopUpdated({ stopNumber: 1, changes: { packageCount: 4 } }));
    expect(s.geo[1]).toBeDefined();
  });

  it('drops the location when the address changes, and follows renumbering', () => {
    const s = reducer(located, stopUpdated({ stopNumber: 1, changes: { addressRaw: '9 ELM ST' } }));
    expect(s.geo[1]).toBeUndefined();
    const moved = reducer(located, stopUpdated({ stopNumber: 3, changes: { stopNumber: 7 } }));
    expect([moved.geo[3], moved.geo[7]?.id]).toEqual([undefined, '3']);
  });

  it('"looks right" confirms an uncertain map match', () => {
    expect(reducer(located, stopReviewed(2)).geo[2].status).toBe('ok');
  });

  it('changing the area invalidates locations; clearing the route keeps the area', () => {
    const withArea = reducer(located, areaSet({ zip: '55000' }));
    expect(withArea.geo).toEqual({});
    expect(reducer(withArea, routeCleared()).area).toEqual({ zip: '55000' });
  });
});

describe('route slice — optimized order', () => {
  it('switches to the optimized order only when it is shorter', () => {
    const better = reducer(loaded, routeOptimized({ order: [1, 3, 2], distanceM: 900, baselineM: 1000 }));
    expect(better.orderMode).toBe('optimized');
    const worse = reducer(loaded, routeOptimized({ order: [1, 3, 2], distanceM: 1000, baselineM: 1000 }));
    expect(worse.orderMode).toBe('groundcloud');
  });

  it('keeps the order consistent when stops are deleted or renumbered', () => {
    const s = reducer(loaded, routeOptimized({ order: [1, 3, 2], distanceM: 900, baselineM: 1000 }));
    expect(reducer(s, stopRemoved(3)).optimized?.order).toEqual([1, 2]);
    expect(reducer(s, stopUpdated({ stopNumber: 3, changes: { stopNumber: 8 } })).optimized?.order).toEqual([1, 8, 2]);
  });

  it('optimizing from the driver\'s location makes its first stop the current one', () => {
    const s = reducer(loaded, routeOptimized({ order: [3, 1, 2], distanceM: 900, baselineM: 1000, startedFrom: 'location' }));
    expect(s.currentStopNumber).toBe(3);
  });

  it('cannot select the optimized order before optimizing', () => {
    expect(reducer(loaded, orderModeSet('optimized')).orderMode).toBe('groundcloud');
  });
});

describe('route slice — businesses first', () => {
  it('guesses businesses on import and keeps the driver\'s choice', () => {
    const s = reducer(initialRouteState, manifestImported({
      stops: [stop(1, { customerName: "MACEY'S" }), stop(2, { customerName: 'ANA ALDEN' }), stop(3, { customerName: 'ANA ALDEN', business: true })],
      issues: [], sourceName: 't',
    }));
    expect(s.drafts.map((d) => d.business)).toEqual([true, false, true]);
    expect(reducer(s, stopUpdated({ stopNumber: 1, changes: { business: false } })).drafts[0].business).toBe(false);
  });

  it('always applies a priority-first order, even if longer than GroundCloud\'s', () => {
    const s = reducer(loaded, routeOptimized({ order: [3, 1, 2], distanceM: 1200, baselineM: 1000, priorityCount: 1 }));
    expect(s.orderMode).toBe('optimized');
  });

  it('priority-first is on by default and can be turned off', () => {
    expect(initialRouteState.priorityFirst).toBe(true);
    expect(reducer(loaded, priorityFirstSet(false)).priorityFirst).toBe(false);
  });
});
