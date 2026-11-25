import { describe, expect, it } from 'vitest';
import { optimizeWithPriority } from './priority';
import type { RoutePoint } from './optimize';

const flat = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) =>
  Math.hypot(a.latitude - b.latitude, a.longitude - b.longitude);
const pt = (id: number, x: number): RoutePoint => ({ id, latitude: 0, longitude: x });

describe('optimizeWithPriority', () => {
  // Homes at 1..3, businesses far out at 8 and 9; the driver starts at 0.
  const points = [pt(1, 1), pt(2, 2), pt(3, 3), pt(8, 8), pt(9, 9)];
  const start = { latitude: 0, longitude: 0 };

  it('visits priority stops first even when homes are closer', () => {
    const r = optimizeWithPriority(points, new Set([8, 9]), { start, distance: flat });
    expect(r.order).toEqual([8, 9, 3, 2, 1]);
    expect(r.priorityCount).toBe(2);
    expect(r.distance).toBeCloseTo(9 + 6 + 2);
  });

  it('is a plain optimization when nothing (or everything) is priority', () => {
    expect(optimizeWithPriority(points, new Set(), { start, distance: flat }).order).toEqual([1, 2, 3, 8, 9]);
    expect(optimizeWithPriority(points, new Set([1, 2, 3, 8, 9]), { start, distance: flat }).order).toEqual([1, 2, 3, 8, 9]);
  });
});
