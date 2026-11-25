import { describe, expect, it } from 'vitest';
import { optimizeRoute, type RoutePoint } from './optimize';
import { sideExempt, sideOfArrival } from './side';
import type { LatLng } from '../model';

// ~1 m per 0.000009° of latitude; at the equator the same for longitude.
const M = 0.000009;
const at = (eastM: number, northM: number): LatLng => ({ latitude: northM * M, longitude: eastM * M });

describe('sideOfArrival', () => {
  it('tells right from left for a truck driving north', () => {
    const from = at(0, -100);
    const entry = at(0, 0);
    expect(sideOfArrival(from, entry, at(20, 0))).toBe('right');
    expect(sideOfArrival(from, entry, at(-20, 0))).toBe('left');
  });

  it('flips when driving the other way', () => {
    expect(sideOfArrival(at(0, 100), at(0, 0), at(20, 0))).toBe('left');
  });

  it('is unknown when the house is on the road point or straight ahead', () => {
    expect(sideOfArrival(at(0, -100), at(0, 0), at(2, 0))).toBeNull();
    expect(sideOfArrival(at(0, -100), at(0, 0), at(0, 30))).toBeNull();
  });
});

describe('sideExempt', () => {
  it('exempts a stop with nobody near it', () => {
    const a = at(0, 0);
    expect(sideExempt(a, [a, at(0, 1000)])).toBe(true);
    expect(sideExempt(a, [a, at(0, 100)])).toBe(false);
  });
});

/**
 * A street running north with stops on both sides. Starting at the south end:
 * Houses directly across (a few meters apart) are one parking spot, so they are staggered.
 * Shortest goes up the street once; "prefer"/"strict" do the right side (east) going up
 * and the left side coming back.
 */
function street() {
  const points: RoutePoint[] = [];
  const house = new Map<number, LatLng>();
  for (let k = 0; k < 6; k++) {
    const north = 40 + k * 40;
    points.push({ id: k * 2, ...at(0, north) }); // east side
    house.set(k * 2, at(25, north));
    points.push({ id: k * 2 + 1, ...at(0, north + 20) }); // west side (staggered)
    house.set(k * 2 + 1, at(-25, north + 20));
  }
  return { points, house, start: at(0, 0) };
}

describe('optimizeRoute with a right-side mode', () => {
  it('off: shortest, no side info', () => {
    const { points, start } = street();
    const r = optimizeRoute(points, { start });
    expect(r.leftArrivals).toBeUndefined();
  });

  it('strict: every house on the right except the last one', () => {
    const { points, house, start } = street();
    const r = optimizeRoute(points, { start, side: { mode: 'strict', house } });
    // The last house at the end of the street can only be reached heading north (left):
    // the model doesn't know the driver turns around there.
    expect(r.leftArrivals).toBe(1);
    // E.g. up the east side and back down the west (or leapfrogging): 460 m either way,
    // vs 280 m going straight up with half the houses on the left.
    expect(r.distance).toBeCloseTo(460, 0);
  });

  it('prefer: does not accept a long detour', () => {
    const { points, house, start } = street();
    const shortest = optimizeRoute(points, { start });
    const r = optimizeRoute(points, { start, side: { mode: 'prefer', house } });
    expect(r.distance).toBeLessThanOrEqual(shortest.distance * 1.1 + 1e-6);
    // Going back down the street doubles the route here, so "prefer" keeps the shortest.
    expect(r.sideExtra).toBe(0);
    expect(r.leftArrivals).toBeGreaterThan(0);
  });

  it('prefer: takes a cheap reorder that puts a house on the right', () => {
    // Two stops at the same spot on opposite sides; the order between them is free.
    const points: RoutePoint[] = [
      { id: 1, ...at(0, 100) },
      { id: 2, ...at(0, 100.5) },
      { id: 3, ...at(0, 300) },
    ];
    const house = new Map([[1, at(-25, 100)], [2, at(25, 100.5)], [3, at(25, 300)]]);
    const r = optimizeRoute(points, { start: at(0, 0), side: { mode: 'prefer', house } });
    expect(r.order).toEqual([2, 1, 3]);
    expect(r.leftArrivals).toBe(0);
  });
});
