import { describe, expect, it } from 'vitest';
import { distanceMeters } from '../geo';
import { optimizeRoute } from './optimize';
import { roadDistance } from './roadDistance';

const at = (latitude: number, longitude: number) => ({ latitude, longitude });

describe('roadDistance', () => {
  const points = [at(38.9, -77), at(38.901, -77), at(38.902, -77)];

  it('uses the road distance for known pairs, in both directions', () => {
    const d = roadDistance(points, [{ i: 0, j: 1, distance_m: 500 }]);
    expect(d(points[0], points[1])).toBe(500);
    expect(d(points[1], points[0])).toBe(500);
    expect(d(at(38.9, -77), at(38.901, -77))).toBe(500); // matched by coordinates
    expect(d(points[0], points[0])).toBe(0);
  });

  it('estimates other pairs with the typical detour ratio, bounded', () => {
    const straight01 = distanceMeters(points[0], points[1]);
    const d = roadDistance(points, [{ i: 0, j: 1, distance_m: straight01 * 2 }]);
    expect(d(points[0], points[2])).toBeCloseTo(distanceMeters(points[0], points[2]) * 2, 3);
    const wild = roadDistance(points, [{ i: 0, j: 1, distance_m: straight01 * 50 }]);
    expect(wild(points[1], points[2])).toBeCloseTo(distanceMeters(points[1], points[2]) * 3, 3);
  });

  it('makes a pair with no road very expensive', () => {
    const d = roadDistance(points, [{ i: 0, j: 1, distance_m: null }]);
    expect(d(points[0], points[1])).toBeGreaterThan(distanceMeters(points[0], points[1]) * 10);
  });

  it('keeps the optimizer away from a close stop with no road between them', () => {
    // A dead-end street: B is 100 m from A in a straight line but 2 km by road;
    // C is 300 m from A along the same street.
    const start = at(38.9, -77);
    const B = { id: 1, ...at(38.9009, -77) };
    const C = { id: 2, ...at(38.9, -76.9965) };
    const nodes = [start, B, C];
    const straight = optimizeRoute([B, C], { start });
    expect(straight.order).toEqual([1, 2]);
    const d = roadDistance(nodes, [
      { i: 0, j: 1, distance_m: 2000 },
      { i: 0, j: 2, distance_m: 320 },
      { i: 1, j: 2, distance_m: 1800 },
    ]);
    expect(optimizeRoute([B, C], { start, distance: d }).order).toEqual([2, 1]);
  });
});
