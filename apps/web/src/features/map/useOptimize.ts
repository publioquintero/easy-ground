import {
  isPriorityStop,
  optimizeWithPriority,
  pathDistance,
  sideExempt,
  sideOfArrival,
  type LatLng,
  type RightSideMode,
} from '@easy-ground/core';
import { drivePoint, type MapModel, type StopMarker } from './mapModel';
import type { OptimizedOrder } from '../../store/routeSlice';

/** The optimizer routes between the points where the truck stops (road entry when known). */
const toPoint = (m: StopMarker) => {
  const p = drivePoint(m);
  return { id: m.stopNumber, latitude: p.lat, longitude: p.lng };
};

/**
 * House points of the stops whose side of the street matters: those with a road entry that
 * isn't a private driveway (the driver pulls into those, any side is fine).
 */
export function sideHouses(stops: StopMarker[]): Map<number, LatLng> {
  return new Map(
    stops
      .filter((m) => m.entry && !m.driveway?.isPrivate)
      .map((m) => [m.stopNumber, { latitude: m.lat, longitude: m.lng }]),
  );
}

/** Houses reached on the left when driving `stops` in this order from `start`. */
export function countLeftArrivals(stops: StopMarker[], start: LatLng, houses: Map<number, LatLng>): number {
  const all = stops.map(toPoint);
  let prev = start;
  let count = 0;
  for (const p of all) {
    const house = houses.get(p.id);
    if (house && !sideExempt(p, all) && sideOfArrival(prev, p, house) === 'left') count++;
    prev = p;
  }
  return count;
}

type Distance = (a: LatLng, b: LatLng) => number;

/**
 * Every place the optimizer measures between (the start and the stops to order), rounded
 * to 5 decimals and without repeats: what to ask road distances for. Null when there is
 * nothing to optimize.
 */
export function optimizationPoints(model: MapModel, from?: LatLng | null): { lat: number; lng: number }[] | null {
  const current = model.current;
  if (!current) return null;
  const start = from ?? toPoint(current);
  const all = [start, ...model.sequence.map(toPoint)];
  const seen = new Set<string>();
  const points: { lat: number; lng: number }[] = [];
  for (const p of all) {
    const lat = Number(p.latitude.toFixed(5));
    const lng = Number(p.longitude.toFixed(5));
    const key = `${lat},${lng}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({ lat, lng });
  }
  return points.length >= 2 ? points : null;
}

/**
 * Optimize the stops still to do. From the driver's GPS position when known (all pending
 * stops are reordered); otherwise from the current stop. With `priorityFirst`, businesses
 * and pickups come first (each group optimized on its own). The baseline is GroundCloud's
 * "#" order over the same stops from the same start, measured the same way.
 *
 * `distance` is the road distance from the server when available; without it the
 * optimizer uses straight lines.
 */
export function computeOptimizedOrder(
  model: MapModel,
  from?: LatLng | null,
  priorityFirst = false,
  distance?: Distance,
  rightSide: RightSideMode = 'off',
): OptimizedOrder | null {
  const current = model.current;
  if (!current) return null;
  const startAtCurrent = !from;
  const start: LatLng = from ?? toPoint(current);
  const stops = startAtCurrent ? model.sequence.filter((m) => m.stopNumber !== current.stopNumber) : model.sequence;
  const priority = new Set(priorityFirst ? stops.filter((m) => isPriorityStop(m.stop)).map((m) => m.stopNumber) : []);

  const houses = rightSide === 'off' ? null : sideHouses(stops);
  const side = houses && houses.size > 0 ? { mode: rightSide, house: houses } : undefined;
  const result = optimizeWithPriority(stops.map(toPoint), priority, { start, distance, side });
  const byNumber = [...stops].sort((a, b) => a.stopNumber - b.stopNumber);
  return {
    order: startAtCurrent ? [current.stopNumber, ...result.order] : result.order,
    distanceM: result.distance,
    baselineM: pathDistance(byNumber.map(toPoint), start, distance),
    startedFrom: startAtCurrent ? 'stop' : 'location',
    priorityCount: result.priorityCount,
    metric: distance ? 'road' : 'straight',
    ...(side && {
      rightSide,
      leftArrivals: result.leftArrivals ?? 0,
      sideExtraM: result.sideExtra ?? 0,
      baselineLeftArrivals: countLeftArrivals(byNumber, start, side.house),
    }),
  };
}

export const miles = (meters: number) => (meters / 1609.344).toFixed(1);
