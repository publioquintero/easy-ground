import { distanceMeters } from '../geo';
import type { LatLng } from '../model';
import { PREFER_MAX_EXTRA, SIDE_PENALTY_M, sideExempt, sideOfArrival, type RightSideMode } from './side';

/**
 * Stop-order optimizer that runs on the phone, offline: an open path (no return to depot)
 * from a fixed start, built with nearest neighbor and improved with 2-opt and Or-opt.
 *
 * Distances are straight-line, so it doesn't know about rivers, highways or one-way streets.
 * GroundCloud's own "#" order is usually road-aware, which is why the app compares both and
 * lets the driver choose. A road-aware matrix (Google, Phase 2) can replace `distance`.
 */

export interface RoutePoint extends LatLng {
  id: number;
}

export interface OptimizeOptions {
  /** Where the driver is now. Not part of the output order. Defaults to the first point. */
  start?: LatLng;
  /** Distance function (meters). Defaults to straight-line. */
  distance?: (a: LatLng, b: LatLng) => number;
  /** Stop improving after this long (ms) — the result is valid at any point. */
  timeBudgetMs?: number;
  /**
   * Right-side preference. Points are where the truck stops (the entry on the road);
   * `house` has the house point of the stops whose side can be told (no entry for private
   * driveways: the driver pulls in, so the side doesn't matter).
   */
  side?: { mode: RightSideMode; house: ReadonlyMap<number, LatLng> };
}

export interface OptimizeResult {
  order: number[];
  /** Total path length from start through all points, in the distance function's units. */
  distance: number;
  /** Stops reached with the house on the left (only counted when a side mode is on). */
  leftArrivals?: number;
  /** How much longer the order is because of the right-side preference. */
  sideExtra?: number;
}

export function pathDistance(points: LatLng[], start?: LatLng, distance = distanceMeters): number {
  let total = 0;
  let prev = start ?? points[0];
  for (const p of points) {
    total += distance(prev, p);
    prev = p;
  }
  return total;
}

/**
 * Where to put one new point in an existing path without reordering it: the index (1..n)
 * that adds the least distance. Never 0, so the path's first point (the current stop) stays.
 */
export function cheapestInsertionIndex(path: LatLng[], point: LatLng, distance = distanceMeters): number {
  if (path.length === 0) return 0;
  let best = path.length;
  let bestCost = distance(path[path.length - 1], point); // appended at the end
  for (let i = 1; i < path.length; i++) {
    const cost = distance(path[i - 1], point) + distance(point, path[i]) - distance(path[i - 1], path[i]);
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  }
  return best;
}

export function optimizeRoute(points: RoutePoint[], options: OptimizeOptions = {}): OptimizeResult {
  const distance = options.distance ?? distanceMeters;
  const n = points.length;
  if (n <= 2) {
    const order = options.start || n < 2 ? nearestNeighbor(points, options.start ?? points[0], distance) : [0, 1];
    return finish(points, order, options.start, distance);
  }

  // Node 0 is the start; nodes 1..n are the points. Precompute the matrix once.
  const nodes: LatLng[] = [options.start ?? points[0], ...points];
  const size = nodes.length;
  const d = new Float64Array(size * size);
  for (let i = 0; i < size; i++) {
    for (let j = i + 1; j < size; j++) {
      const v = distance(nodes[i], nodes[j]);
      d[i * size + j] = v;
      d[j * size + i] = v;
    }
  }
  const dist = (a: number, b: number) => d[a * size + b];

  // Tour over node indices, tour[0] = start (fixed).
  const tour = [0, ...nearestNeighbor(points, nodes[0], distance).map((i) => i + 1)];
  const deadline = performance.now() + (options.timeBudgetMs ?? 400);

  let improved = true;
  while (improved && performance.now() < deadline) {
    improved = twoOpt(tour, dist) || false;
    improved = orOpt(tour, dist) || improved;
  }

  const shortest = finish(points, tour.slice(1).map((i) => i - 1), options.start, distance);
  const side = options.side;
  if (!side || side.mode === 'off' || side.house.size === 0) return shortest;

  // Side-aware pass: a left-side arrival adds a penalty to that leg, which makes the cost
  // depend on the direction of travel, so it runs as its own search on top of the shortest.
  const penalty = SIDE_PENALTY_M[side.mode];
  const houses = nodes.map((_, k) => (k === 0 ? undefined : side.house.get(points[k - 1].id)));
  const exempt = nodes.map((p, k) => k === 0 || !houses[k] || sideExempt(p, nodes.slice(1)));
  const left = new Uint8Array(size * size);
  for (let a = 0; a < size; a++) {
    for (let b = 1; b < size; b++) {
      if (a !== b && !exempt[b] && sideOfArrival(nodes[a], nodes[b], houses[b]!) === 'left') left[a * size + b] = 1;
    }
  }
  const cost = (a: number, b: number) => dist(a, b) + (left[a * size + b] ? penalty : 0);
  const tourCost = (t: number[]) => t.slice(1).reduce((sum, b, k) => sum + cost(t[k], b), 0);
  // Local search gets stuck near its starting order, so start it from two: the shortest
  // order and a nearest-neighbor built with the side penalty. Keep the cheaper result.
  const sideDeadline = performance.now() + (options.timeBudgetMs ?? 400);
  const improve = (t: number[]) => {
    let more = true;
    while (more && performance.now() < sideDeadline) {
      more = twoOptDirected(t, cost) || false;
      more = orOpt(t, cost, false) || more;
    }
    return t;
  };
  const sideTour = [improve([...tour]), improve(directedNearestNeighbor(size, cost))].reduce((a, b) =>
    tourCost(b) < tourCost(a) ? b : a,
  );
  const leftOf = (t: number[]) => t.slice(1).filter((b, k) => left[t[k] * size + b]).length;

  const preferred = finish(points, sideTour.slice(1).map((i) => i - 1), options.start, distance);
  const tooLong = side.mode === 'prefer' && preferred.distance > shortest.distance * (1 + PREFER_MAX_EXTRA);
  return tooLong
    ? { ...shortest, leftArrivals: leftOf(tour), sideExtra: 0 }
    : { ...preferred, leftArrivals: leftOf(sideTour), sideExtra: Math.max(0, preferred.distance - shortest.distance) };
}

function finish(
  points: RoutePoint[],
  order: number[],
  start: LatLng | undefined,
  distance: (a: LatLng, b: LatLng) => number,
): OptimizeResult {
  const ordered = order.map((i) => points[i]);
  return { order: ordered.map((p) => p.id), distance: pathDistance(ordered, start, distance) };
}

function nearestNeighbor(points: RoutePoint[], from: LatLng, distance: (a: LatLng, b: LatLng) => number): number[] {
  const left = new Set(points.map((_, i) => i));
  const order: number[] = [];
  let here = from;
  while (left.size > 0) {
    let best = -1;
    let bestD = Infinity;
    for (const i of left) {
      const v = distance(here, points[i]);
      if (v < bestD) [best, bestD] = [i, v];
    }
    order.push(best);
    left.delete(best);
    here = points[best];
  }
  return order;
}

/** Nearest neighbor over node indices from node 0, with a (possibly one-way) cost. */
function directedNearestNeighbor(size: number, cost: (a: number, b: number) => number): number[] {
  const tour = [0];
  const left = new Set(Array.from({ length: size - 1 }, (_, k) => k + 1));
  while (left.size > 0) {
    const here = tour[tour.length - 1];
    let best = -1;
    let bestC = Infinity;
    for (const b of left) {
      const c = cost(here, b);
      if (c < bestC) [best, bestC] = [b, c];
    }
    tour.push(best);
    left.delete(best);
  }
  return tour;
}

const EPS = 1e-7;

/** Reverse tour[i..j] when it shortens the open path. tour[0] stays fixed. */
function twoOpt(tour: number[], dist: (a: number, b: number) => number): boolean {
  let improved = false;
  const last = tour.length - 1;
  for (let i = 1; i < last; i++) {
    for (let j = i + 1; j <= last; j++) {
      const a = tour[i - 1];
      const b = tour[i];
      const c = tour[j];
      const next = j < last ? tour[j + 1] : -1; // open path: nothing after the last stop
      const before = dist(a, b) + (next >= 0 ? dist(c, next) : 0);
      const after = dist(a, c) + (next >= 0 ? dist(b, next) : 0);
      if (after < before - EPS) {
        reverse(tour, i, j);
        improved = true;
      }
    }
  }
  return improved;
}

/**
 * 2-opt for a direction-dependent cost: reversing tour[i..j] also flips every leg inside it,
 * so their change is added up as j grows.
 */
function twoOptDirected(tour: number[], cost: (a: number, b: number) => number): boolean {
  let improved = false;
  const last = tour.length - 1;
  for (let i = 1; i < last; i++) {
    let inner = 0; // Σ cost(reversed inner legs) − Σ cost(inner legs) for tour[i..j]
    for (let j = i + 1; j <= last; j++) {
      inner += cost(tour[j], tour[j - 1]) - cost(tour[j - 1], tour[j]);
      const a = tour[i - 1];
      const next = j < last ? tour[j + 1] : -1;
      const before = cost(a, tour[i]) + (next >= 0 ? cost(tour[j], next) : 0);
      const after = cost(a, tour[j]) + (next >= 0 ? cost(tour[i], next) : 0);
      if (after + inner < before - EPS) {
        reverse(tour, i, j);
        improved = true;
        inner = 0;
        // Recompute for the new tour[i..j] (now reversed) before continuing.
        for (let k = i + 1; k <= j; k++) inner += cost(tour[k], tour[k - 1]) - cost(tour[k - 1], tour[k]);
      }
    }
  }
  return improved;
}

/** Move a run of 1–3 stops to a better place in the path (Or-opt). */
function orOpt(tour: number[], dist: (a: number, b: number) => number, allowReverse = true): boolean {
  let improved = false;
  for (let len = 1; len <= 3; len++) {
    for (let i = 1; i + len - 1 < tour.length; i++) {
      const j = i + len - 1; // segment tour[i..j]
      const prev = tour[i - 1];
      const next = j + 1 < tour.length ? tour[j + 1] : -1;
      const first = tour[i];
      const lastOfSeg = tour[j];
      const removeGain = dist(prev, first) + (next >= 0 ? dist(lastOfSeg, next) : 0) - (next >= 0 ? dist(prev, next) : 0);

      const segment = tour.slice(i, j + 1);
      const rest = [...tour.slice(0, i), ...tour.slice(j + 1)];
      let bestDelta = -EPS;
      let bestPos = -1;
      let bestReversed = false;
      // Insert between rest[k] and rest[k+1] (or at the end).
      for (let k = 0; k < rest.length; k++) {
        if (k === i - 1) continue; // same place
        const p = rest[k];
        const q = k + 1 < rest.length ? rest[k + 1] : -1;
        const base = q >= 0 ? dist(p, q) : 0;
        for (const reversed of allowReverse ? [false, true] : [false]) {
          const head = reversed ? lastOfSeg : first;
          const tail = reversed ? first : lastOfSeg;
          const add = dist(p, head) + (q >= 0 ? dist(tail, q) : 0) - base;
          const delta = add - removeGain;
          if (delta < bestDelta) [bestDelta, bestPos, bestReversed] = [delta, k, reversed];
        }
      }
      if (bestPos >= 0) {
        const moved = bestReversed ? segment.reverse() : segment;
        rest.splice(bestPos + 1, 0, ...moved);
        tour.splice(0, tour.length, ...rest);
        improved = true;
      }
    }
  }
  return improved;
}

function reverse(tour: number[], i: number, j: number) {
  while (i < j) {
    [tour[i], tour[j]] = [tour[j], tour[i]];
    i++;
    j--;
  }
}
