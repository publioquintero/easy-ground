import type { LatLng, StopDraft, TimeWindow } from '../model';

/**
 * Times along the route: business deliveries must be done before closing (4 PM), and each
 * pickup has a window (usually 2–5 PM, but it varies) when it can be made.
 */

export interface TimedStop {
  stopNumber: number;
  /** Earliest service time (epoch ms): arriving earlier means waiting. */
  open?: number | null;
  /** Latest service time (epoch ms): arriving later is late. */
  close?: number | null;
}

export interface Simulation {
  /** When service starts at each stop (after any wait), in route order. */
  arrivals: number[];
  /** Stops served after their close time, in route order. */
  late: number[];
  /** Total time spent waiting for windows to open (s). */
  waitS: number;
  /** Sum of how late every late stop is (s). */
  latenessS: number;
  /** When the last stop is done (epoch ms). */
  endMs: number;
}

/**
 * Drive the route in order. `travelS[i]` is the drive to stop i from the previous stop (or,
 * for the first one, from where the driver starts). `stopMinutes` is spent at every stop.
 */
export function simulateRoute(stops: TimedStop[], travelS: number[], startMs: number, stopMinutes: number): Simulation {
  const arrivals: number[] = [];
  const late: number[] = [];
  let t = startMs;
  let waitS = 0;
  let latenessS = 0;
  stops.forEach((stop, i) => {
    t += (travelS[i] ?? 0) * 1000;
    if (stop.open != null && t < stop.open) {
      waitS += (stop.open - t) / 1000;
      t = stop.open;
    }
    arrivals.push(t);
    if (stop.close != null && t > stop.close) {
      late.push(stop.stopNumber);
      latenessS += (t - stop.close) / 1000;
    }
    t += stopMinutes * 60_000;
  });
  return { arrivals, late, waitS, latenessS, endMs: t };
}

/** "16:00" on the day of `now` as epoch ms (local time), or null when the text isn't a time. */
export function timeToday(hhmm: string, now: Date): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.getTime();
}

export interface TimeRules {
  /** Business deliveries close at this time, "HH:MM". */
  businessCloseAt: string;
  /** Window for pickups that don't have their own. */
  pickupWindow: TimeWindow;
}

/** The pickup window that applies to a stop (its own, else the default). */
export function pickupWindowOf(stop: Pick<StopDraft, 'pickupWindow'>, rules: TimeRules): TimeWindow {
  return stop.pickupWindow ?? rules.pickupWindow;
}

/** Time limits of one stop today: pickups by window, business deliveries by closing time. */
export function timeLimits(
  stop: Pick<StopDraft, 'stopNumber' | 'stopType' | 'business' | 'pickupWindow'>,
  rules: TimeRules,
  now: Date,
): TimedStop {
  if (stop.stopType === 'pickup') {
    const w = pickupWindowOf(stop, rules);
    return { stopNumber: stop.stopNumber, open: timeToday(w.from, now), close: timeToday(w.to, now) };
  }
  if (stop.business) return { stopNumber: stop.stopNumber, close: timeToday(rules.businessCloseAt, now) };
  return { stopNumber: stop.stopNumber };
}

/** Driving speed used to turn distances into times when planning (≈ 25 mph in town). */
export const PLANNING_SPEED_MPS = 11;

/** Each late second costs like this many seconds of driving: being on time comes first. */
const LATE_WEIGHT = 50;
/** Plan to be done this long before a window closes: drive times are estimates. */
export const CLOSE_MARGIN_MS = 10 * 60_000;

export interface WindowedPoint extends LatLng {
  id: number;
  limits: TimedStop;
}

/**
 * Put stops with time windows (pickups) into an already optimized order: each one goes
 * where the route ends earliest, with lateness (its own and any it causes to other timed
 * stops) weighing far more than driving or waiting. Tightest windows are placed first.
 * Every close time is planned CLOSE_MARGIN_MS early, so estimate errors don't make it late.
 */
export function insertTimedStops(
  route: WindowedPoint[],
  timed: WindowedPoint[],
  options: {
    start: LatLng;
    startMs: number;
    stopMinutes: number;
    distance: (a: LatLng, b: LatLng) => number;
    /** Average driving speed on this route (m/s), e.g. from Google's route; defaults to town speed. */
    speedMps?: number;
  },
): number[] {
  const { start, startMs, stopMinutes, distance } = options;
  const speed = options.speedMps && options.speedMps > 1 ? options.speedMps : PLANNING_SPEED_MPS;
  const planned = (l: TimedStop): TimedStop => (l.close != null ? { ...l, close: l.close - CLOSE_MARGIN_MS } : l);
  const cost = (seq: WindowedPoint[]) => {
    const travel = seq.map((p, i) => distance(i === 0 ? start : seq[i - 1], p) / speed);
    const sim = simulateRoute(seq.map((p) => planned(p.limits)), travel, startMs, stopMinutes);
    return (sim.endMs - startMs) / 1000 + sim.latenessS * LATE_WEIGHT;
  };

  let seq = [...route];
  const byClose = [...timed].sort((a, b) => (a.limits.close ?? Infinity) - (b.limits.close ?? Infinity));
  for (const point of byClose) {
    let best: WindowedPoint[] | null = null;
    let bestCost = Infinity;
    for (let i = 0; i <= seq.length; i++) {
      const candidate = [...seq.slice(0, i), point, ...seq.slice(i)];
      const c = cost(candidate);
      if (c < bestCost) [best, bestCost] = [candidate, c];
    }
    seq = best!;
  }
  return seq.map((p) => p.id);
}
