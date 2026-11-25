import { distanceMeters } from '../geo';
import type { LatLng } from '../model';

/** Road distance between points[i] and points[j]; null when no road route was found. */
export interface RoadPair {
  i: number;
  j: number;
  distance_m: number | null;
}

/** How much longer than the straight line an unreachable pair counts (effectively "never"). */
const NO_ROAD_FACTOR = 20;
/** Bounds for the typical road/straight ratio used on pairs without a road distance. */
const MIN_FACTOR = 1.2;
const MAX_FACTOR = 3;

const keyOf = (p: LatLng) => `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`;

/**
 * A distance function for the optimizer from road distances between nearby points.
 *
 * Only nearby pairs have a road distance (a full matrix costs too much). Any other pair is
 * the straight line times the route's typical detour ratio (the median of the known pairs),
 * so a far pair is never cheaper than it would be by road. Points are matched by their
 * coordinates rounded to 5 decimals (~1 m), as they were sent to the server.
 */
export function roadDistance(points: LatLng[], pairs: RoadPair[]): (a: LatLng, b: LatLng) => number {
  const index = new Map(points.map((p, i) => [keyOf(p), i]));
  const known = new Map<string, number>();
  const ratios: number[] = [];
  for (const { i, j, distance_m } of pairs) {
    const straight = distanceMeters(points[i], points[j]);
    const value = distance_m ?? Math.max(straight, 1) * NO_ROAD_FACTOR;
    known.set(`${i}|${j}`, value);
    known.set(`${j}|${i}`, value);
    if (distance_m !== null && straight > 30) ratios.push(distance_m / straight);
  }
  ratios.sort((x, y) => x - y);
  const median = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1.4;
  const factor = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, median));

  return (a, b) => {
    const i = index.get(keyOf(a));
    const j = index.get(keyOf(b));
    if (i !== undefined && j !== undefined) {
      if (i === j) return 0;
      const road = known.get(`${i}|${j}`);
      if (road !== undefined) return road;
    }
    return distanceMeters(a, b) * factor;
  };
}
