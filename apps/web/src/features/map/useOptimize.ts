import {
  distanceMeters,
  insertTimedStops,
  isPriorityStop,
  optimizeWithPriority,
  timeLimits,
  type TimeRules,
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

/** What pickup windows and business hours need to plan with: the rules, the time now and the time per stop. */
export interface Timing {
  rules: TimeRules;
  now: Date;
  stopMinutes: number;
  /** Average speed of the route by road (m/s), when Google's route is known. */
  speedMps?: number;
}

/**
 * Optimize the stops still to do. From the driver's GPS position when known (all pending
 * stops are reordered); otherwise from the current stop. With `priorityFirst`, businesses
 * and pickups come first (each group optimized on its own). The baseline is GroundCloud's
 * "#" order over the same stops from the same start, measured the same way.
 *
 * `distance` is the road distance from the server when available; without it the
 * optimizer uses straight lines.
 *
 * With `timing`, pickups are left out of that optimization and then placed where they fit
 * their time window (usually in the afternoon), waiting for the window when needed.
 */
export function computeOptimizedOrder(
  model: MapModel,
  from?: LatLng | null,
  priorityFirst = false,
  distance?: Distance,
  rightSide: RightSideMode = 'off',
  timing?: Timing,
): OptimizedOrder | null {
  const current = model.current;
  if (!current) return null;
  const startAtCurrent = !from;
  const start: LatLng = from ?? toPoint(current);
  const stops = startAtCurrent ? model.sequence.filter((m) => m.stopNumber !== current.stopNumber) : model.sequence;
  const timed = timing ? stops.filter((m) => m.stop.stopType === 'pickup') : [];
  const rest = stops.filter((m) => !timed.includes(m));
  const priority = new Set(priorityFirst ? rest.filter((m) => isPriorityStop(m.stop)).map((m) => m.stopNumber) : []);

  const houses = rightSide === 'off' ? null : sideHouses(stops);
  const side = houses && houses.size > 0 ? { mode: rightSide, house: houses } : undefined;
  const result =
    rest.length > 0
      ? optimizeWithPriority(rest.map(toPoint), priority, { start, distance, side })
      : { order: [] as number[], distance: 0, priorityCount: 0, leftArrivals: undefined, sideExtra: undefined };
  const marker = new Map(stops.map((m) => [m.stopNumber, m]));
  let order = result.order;
  if (timing && timed.length > 0) {
    const withLimits = (m: StopMarker) => ({ ...toPoint(m), limits: timeLimits(m.stop, timing.rules, timing.now) });
    order = insertTimedStops(order.map((n) => withLimits(marker.get(n)!)), timed.map(withLimits), {
      start,
      startMs: timing.now.getTime(),
      stopMinutes: timing.stopMinutes,
      speedMps: timing.speedMps,
      // Without road distances, streets are about 1.4× the straight line.
      distance: distance ?? ((a, b) => distanceMeters(a, b) * 1.4),
    });
  }
  const ordered = order.map((n) => marker.get(n)!);
  const byNumber = [...stops].sort((a, b) => a.stopNumber - b.stopNumber);
  return {
    order: startAtCurrent ? [current.stopNumber, ...order] : order,
    distanceM: timed.length > 0 ? pathDistance(ordered.map(toPoint), start, distance) : result.distance,
    baselineM: pathDistance(byNumber.map(toPoint), start, distance),
    startedFrom: startAtCurrent ? 'stop' : 'location',
    priorityCount: result.priorityCount,
    timedCount: timed.length,
    metric: distance ? 'road' : 'straight',
    ...(side && {
      rightSide,
      leftArrivals: timed.length > 0 ? countLeftArrivals(ordered, start, side.house) : (result.leftArrivals ?? 0),
      sideExtraM: result.sideExtra ?? 0,
      baselineLeftArrivals: countLeftArrivals(byNumber, start, side.house),
    }),
  };
}

export const miles = (meters: number) => (meters / 1609.344).toFixed(1);
