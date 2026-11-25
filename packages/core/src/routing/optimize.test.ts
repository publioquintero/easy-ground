import { describe, expect, it } from 'vitest';
import { optimizeRoute, pathDistance, type RoutePoint } from './optimize';

/** Planar distance in "blocks" keeps expected values exact. */
const flat = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) =>
  Math.hypot(a.latitude - b.latitude, a.longitude - b.longitude);
const pt = (id: number, x: number, y: number): RoutePoint => ({ id, latitude: y, longitude: x });

/** Deterministic pseudo-random points (LCG) so tests are reproducible. */
function scatter(n: number, seed = 7): RoutePoint[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  return Array.from({ length: n }, (_, i) => pt(i + 1, rnd() * 10, rnd() * 10));
}

describe('optimizeRoute', () => {
  it('walks points on a line in order from the start, whatever the input order', () => {
    const points = [pt(3, 3, 0), pt(1, 1, 0), pt(5, 5, 0), pt(2, 2, 0), pt(4, 4, 0)];
    const r = optimizeRoute(points, { start: { latitude: 0, longitude: 0 }, distance: flat });
    expect(r.order).toEqual([1, 2, 3, 4, 5]);
    expect(r.distance).toBeCloseTo(5);
  });

  it('untangles a crossing (2-opt) on a block of houses', () => {
    // A 2×4 grid visited in a zig-zag that crosses itself.
    const points = [pt(1, 0, 0), pt(2, 1, 1), pt(3, 1, 0), pt(4, 2, 1), pt(5, 2, 0), pt(6, 3, 1), pt(7, 3, 0), pt(8, 0, 1)];
    const r = optimizeRoute(points, { start: { latitude: 0, longitude: -1 }, distance: flat });
    // Best open path from (-1,0): along one side and back along the other = 1 + 3 + 1 + 3 = 8.
    expect(r.distance).toBeCloseTo(8);
  });

  it('is never worse than the original order and much better than a random one', () => {
    const points = scatter(60);
    const start = { latitude: 0, longitude: 0 };
    const original = pathDistance(points, start, flat);
    const r = optimizeRoute(points, { start, distance: flat });
    expect(r.distance).toBeLessThan(original * 0.5);
    expect(new Set(r.order)).toEqual(new Set(points.map((p) => p.id)));
    expect(r.order).toHaveLength(60);
  });

  it('handles a full day (150 stops) well within the time budget', () => {
    const points = scatter(150, 42);
    const t0 = performance.now();
    const r = optimizeRoute(points, { start: { latitude: 0, longitude: 0 }, distance: flat });
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(r.order).toHaveLength(150);
  });

  it('handles tiny inputs', () => {
    expect(optimizeRoute([]).order).toEqual([]);
    expect(optimizeRoute([pt(9, 1, 1)]).order).toEqual([9]);
    expect(optimizeRoute([pt(1, 0, 0), pt(2, 5, 5)], { start: { latitude: 5, longitude: 5 }, distance: flat }).order).toEqual([2, 1]);
  });

  it('uses meters by default', () => {
    const r = optimizeRoute([pt(1, -93, 45), pt(2, -93, 45.01)]);
    expect(r.distance).toBeGreaterThan(1100);
    expect(r.distance).toBeLessThan(1120);
  });
});
