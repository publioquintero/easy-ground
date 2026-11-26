import { describe, expect, it } from 'vitest';
import { CLOSE_MARGIN_MS, insertTimedStops, PLANNING_SPEED_MPS, simulateRoute, timeLimits, timeToday, type WindowedPoint } from './schedule';

const now = new Date(2026, 10, 26, 9, 0);
const at = (hhmm: string) => timeToday(hhmm, now)!;
const min = 60_000;

describe('simulateRoute', () => {
  it('adds drive and stop time, waits for windows and flags late stops', () => {
    const stops = [
      { stopNumber: 1 },
      { stopNumber: 2, open: at('09:30') },
      { stopNumber: 3, close: at('09:40') },
    ];
    // 9:10 at #1, 9:22 → waits to 9:30 at #2, 9:42 at #3 (2 min late).
    const sim = simulateRoute(stops, [600, 600, 600], at('09:00'), 2);
    expect(sim.arrivals).toEqual([at('09:10'), at('09:30'), at('09:42')]);
    expect(sim.waitS).toBe(8 * 60);
    expect(sim.late).toEqual([3]);
    expect(sim.latenessS).toBe(120);
    expect(sim.endMs).toBe(at('09:44'));
  });
});

describe('timeLimits', () => {
  const rules = { businessCloseAt: '16:00', pickupWindow: { from: '14:00', to: '17:00' } };
  it('uses the default pickup window, a stop’s own window, and the business close', () => {
    expect(timeLimits({ stopNumber: 1, stopType: 'pickup' }, rules, now)).toEqual({ stopNumber: 1, open: at('14:00'), close: at('17:00') });
    expect(timeLimits({ stopNumber: 2, stopType: 'pickup', business: true, pickupWindow: { from: '15:30', to: '16:30' } }, rules, now))
      .toEqual({ stopNumber: 2, open: at('15:30'), close: at('16:30') });
    expect(timeLimits({ stopNumber: 3, stopType: 'delivery', business: true }, rules, now)).toEqual({ stopNumber: 3, close: at('16:00') });
    expect(timeLimits({ stopNumber: 4, stopType: 'delivery' }, rules, now)).toEqual({ stopNumber: 4 });
  });
});

describe('insertTimedStops', () => {
  // Points on a line, 1 unit = PLANNING_SPEED_MPS meters = 1 s of driving; stops take no time.
  const distance = (a: { longitude: number }, b: { longitude: number }) => Math.abs(a.longitude - b.longitude) * PLANNING_SPEED_MPS;
  const p = (id: number, x: number, limits: Partial<WindowedPoint['limits']> = {}): WindowedPoint =>
    ({ id, latitude: 0, longitude: x, limits: { stopNumber: id, ...limits } });
  const start = { latitude: 0, longitude: 0 };
  const startMs = at('09:00');

  it('puts a pickup that opens later at the end, even if it is on the way', () => {
    const route = [p(1, 100), p(2, 200), p(3, 300)];
    const order = insertTimedStops(route, [p(9, 150, { open: startMs + 3600_000 })], { start, startMs, stopMinutes: 0, distance });
    expect(order).toEqual([1, 2, 3, 9]);
  });

  it('puts an open pickup where it costs the least driving', () => {
    const route = [p(1, 100), p(2, 200), p(3, 300)];
    const order = insertTimedStops(route, [p(9, 150, { close: startMs + 2 * 3600_000 })], { start, startMs, stopMinutes: 0, distance });
    expect(order).toEqual([1, 9, 2, 3]);
  });

  it('serves a pickup before its window closes even if that means a detour', () => {
    const route = [p(1, 100), p(2, 200), p(3, 300)];
    // Closes 50 s after the start: only reachable on time if it goes first.
    const order = insertTimedStops(route, [p(9, 40, { close: startMs + CLOSE_MARGIN_MS + 50_000 })], { start, startMs, stopMinutes: 0, distance });
    expect(order[0]).toBe(9);
  });

  it('places pickups between their windows when the day runs into them', () => {
    // Each stop takes 10 min: #1 at 9:01, #2 at 9:12, done 9:22; the pickup opens at 9:20.
    const route = [p(1, 60), p(2, 120), p(3, 180)];
    const order = insertTimedStops(route, [p(9, 130, { open: startMs + 20 * min, close: startMs + 40 * min })], {
      start, startMs, stopMinutes: 10, distance,
    });
    expect(order).toEqual([1, 2, 9, 3]);
  });
});
