import { describe, expect, it } from 'vitest';
import type { StopDraft } from '@easy-ground/core';
import type { GeoResult } from './api';
import reducer, { initialRouteState, labelScannedAtStop, manifestImported, routeOptimized, stopAdded, stopsLocated } from './routeSlice';

const stop = (n: number, extra: Partial<StopDraft> = {}): StopDraft => ({
  stopNumber: n, stopType: 'delivery', shelfId: '6000', packageCount: 1, customerName: null,
  addressRaw: `${100 + n} MAIN ST`, addressLine2: null, completed: false, ...extra,
});
const geo = (id: number, lng: number): GeoResult => ({
  id: String(id), status: 'ok', lat: 45, lng, accuracy: 'rooftop', formatted: 'X',
  city: null, state: null, zip: null, street_side: null, provider: 'census', cached: false,
});

// Stops 1, 2, 3 in a line going east, optimized in that order.
const route = [
  manifestImported({ stops: [stop(1), stop(2), stop(3)], issues: [], sourceName: 't' }),
  stopsLocated([geo(1, -93.0), geo(2, -92.99), geo(3, -92.98)]),
  routeOptimized({ order: [1, 2, 3], distanceM: 1, baselineM: 2 }),
].reduce(reducer, initialRouteState);

describe('route slice — package labels', () => {
  it('records the tracking number once and adds an extra package only when asked', () => {
    let s = reducer(route, labelScannedAtStop({ stopNumber: 2, trackingNumber: '794612761758', extraPackage: false }));
    expect(s.drafts[1]).toMatchObject({ packageCount: 1, trackingNumbers: ['794612761758'] });
    s = reducer(s, labelScannedAtStop({ stopNumber: 2, trackingNumber: '794612761758', extraPackage: true }));
    expect(s.drafts[1]).toMatchObject({ packageCount: 2, trackingNumbers: ['794612761758'] });
  });

  it('slots a located label stop into the optimized order where it costs least', () => {
    const added = reducer(route, stopAdded(stop(57, { source: 'label', zip: '84043' })));
    const s = reducer(added, stopsLocated([geo(57, -92.985)]));
    expect(s.optimized?.order).toEqual([1, 2, 57, 3]);
  });

  it('leaves manifest stops added later at the end (re-optimize hint)', () => {
    const added = reducer(route, stopAdded(stop(58)));
    expect(reducer(added, stopsLocated([geo(58, -92.985)])).optimized?.order).toEqual([1, 2, 3]);
  });
});
