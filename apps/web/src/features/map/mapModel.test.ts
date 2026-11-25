import { describe, expect, it } from 'vitest';
import type { StopDraft } from '@easy-ground/core';
import type { GeoResult } from '../../store/api';
import { buildMapModel, navigationLinks } from './mapModel';

const stop = (n: number, completed = false): StopDraft => ({
  stopNumber: n, stopType: 'delivery', shelfId: null, packageCount: 1, customerName: null,
  addressRaw: `${n} MAIN ST`, addressLine2: null, completed,
});
const geo = (n: number, status: GeoResult['status'] = 'ok'): GeoResult => ({
  id: String(n), status, lat: status === 'not_found' ? null : 40 + n / 100, lng: status === 'not_found' ? null : -90,
  accuracy: 'interpolated', formatted: null, city: null, state: null, zip: null, street_side: null, provider: 'census', cached: false,
});

describe('buildMapModel', () => {
  const drafts = [stop(1, true), stop(2), stop(3), stop(4), stop(5)];
  const located = { 1: geo(1), 2: geo(2), 3: geo(3, 'review'), 4: geo(4, 'not_found'), 5: geo(5) };

  it('marks completed, current, uncertain and pending stops; skips unlocated ones', () => {
    const m = buildMapModel(drafts, located, null);
    expect(m.markers.map((x) => [x.stopNumber, x.state])).toEqual([[1, 'done'], [2, 'current'], [3, 'check'], [5, 'pending']]);
    expect(m.unlocated).toBe(1);
  });

  it('draws the line from the current stop onward', () => {
    const m = buildMapModel(drafts, located, 3);
    expect(m.current?.stopNumber).toBe(3);
    expect(m.path).toEqual([[40.03, -90], [40.05, -90]]);
  });

  it('falls back to the first pending stop when the current one is completed', () => {
    expect(buildMapModel(drafts, located, 1).current?.stopNumber).toBe(2);
  });
});

describe('buildMapModel — optimized order', () => {
  const drafts = [stop(1), stop(2), stop(3), stop(4)];
  const located = { 1: geo(1), 2: geo(2), 3: geo(3), 4: geo(4) };

  it('follows the given order and puts stops added later at the end', () => {
    const m = buildMapModel(drafts, located, null, [3, 1, 2]);
    expect(m.sequence.map((x) => x.stopNumber)).toEqual([3, 1, 2, 4]);
    expect(m.current?.stopNumber).toBe(3);
    expect(m.outsideOrder).toBe(1);
    expect(m.path).toEqual([[40.03, -90], [40.01, -90], [40.02, -90], [40.04, -90]]);
  });
});

describe('navigationLinks', () => {
  it('builds Apple and Google Maps driving links', () => {
    const l = navigationLinks(45.1234567, -93.1);
    expect(l.apple).toBe('https://maps.apple.com/?daddr=45.123457,-93.100000&dirflg=d');
    expect(l.google).toContain('destination=45.123457,-93.100000&travelmode=driving');
  });
});

describe('computeOptimizedOrder', () => {
  const drafts = [stop(1), stop(2), stop(3), stop(4)];
  // Stops on a north-south line; GroundCloud order zig-zags 1(40.01) → 2(40.02) → 3(40.03) → 4(40.04).
  const located = { 1: geo(1), 2: geo(2), 3: geo(3), 4: geo(4) };

  it('starts from the driver and reorders every pending stop', async () => {
    const { computeOptimizedOrder } = await import('./useOptimize');
    const model = buildMapModel(drafts, located, 1);
    // Driver is north of stop 4: best is to go 4 → 3 → 2 → 1.
    const r = computeOptimizedOrder(model, { latitude: 40.05, longitude: -90 })!;
    expect(r.order).toEqual([4, 3, 2, 1]);
    expect(r.startedFrom).toBe('location');
    expect(r.distanceM).toBeLessThan(r.baselineM);
  });

  it('without GPS keeps the current stop first', async () => {
    const { computeOptimizedOrder } = await import('./useOptimize');
    const r = computeOptimizedOrder(buildMapModel(drafts, located, 3), null)!;
    expect(r.order[0]).toBe(3);
    expect(r.startedFrom).toBe('stop');
  });
});
