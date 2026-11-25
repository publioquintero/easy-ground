import { describe, expect, it } from 'vitest';
import type { StopDraft } from '@easy-ground/core';
import type { GeoResult } from '../../store/api';
import { buildMapModel } from './mapModel';
import { drivewayAlert } from './useDrivewayAlerts';
import { countLeftArrivals, sideHouses } from './useOptimize';

// ~1 m per 0.000009° near the equator.
const M = 0.000009;
const stop = (n: number): StopDraft => ({
  stopNumber: n, stopType: 'delivery', shelfId: null, packageCount: 1, customerName: null,
  addressRaw: `${n} MAIN ST`, addressLine2: null, completed: false,
});
/** House `eastM` meters east of a road running north at x = 0; entry on the road. */
const geo = (n: number, northM: number, eastM: number | null): GeoResult => ({
  id: String(n), status: 'ok', lat: northM * M, lng: (eastM ?? 0) * M, accuracy: 'rooftop', formatted: null,
  city: null, state: null, zip: null, street_side: null, provider: 'google', cached: false,
  entry_lat: eastM === null ? null : northM * M, entry_lng: eastM === null ? null : 0,
});

describe('private driveways', () => {
  const drafts = [stop(1), stop(2), stop(3)];
  const located = { 1: geo(1, 100, 20), 2: geo(2, 200, -120), 3: geo(3, 300, null) };

  it('flags houses far from their road entry, with the threshold from settings', () => {
    const m = buildMapModel(drafts, located, null);
    expect(m.markers.map((x) => x.driveway?.isPrivate ?? null)).toEqual([false, true, null]);
    expect(buildMapModel(drafts, located, null, null, 150).markers[1].driveway?.isPrivate).toBe(false);
  });

  it('draws the route to the entry, not the house', () => {
    const m = buildMapModel(drafts, located, null);
    expect(m.path[1]).toEqual([200 * M, 0]);
  });

  it('announces a private driveway once, within 150 m, with the side', () => {
    const m = buildMapModel(drafts, located, 1);
    const before = { latitude: 20 * M, longitude: 0 };
    const far = { latitude: 40 * M, longitude: 0 }; // 160 m from stop 2's entry
    expect(drivewayAlert(far, before, m.sequence, new Set())).toBeNull();
    const near = { latitude: 120 * M, longitude: 0 };
    const alert = drivewayAlert(near, before, m.sequence, new Set());
    expect(alert).toEqual({ stopNumber: 2, text: 'Private driveway in 80 meters, on the left. Stop 2.' });
    expect(drivewayAlert(near, before, m.sequence, new Set([2]))).toBeNull();
  });

  it('counts houses on the left only where the side matters', () => {
    const m = buildMapModel(drafts, located, null);
    const houses = sideHouses(m.sequence);
    expect([...houses.keys()]).toEqual([1]); // 2 is a private driveway, 3 has no entry
    const west = buildMapModel([stop(1), stop(4)], { 1: geo(1, 100, 20), 4: geo(4, 150, -20) }, null);
    const start = { latitude: 0, longitude: 0 };
    expect(countLeftArrivals(west.sequence, start, sideHouses(west.sequence))).toBe(1);
  });
});
