import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { distanceMeters, sideOfArrival, type LatLng } from '@easy-ground/core';
import type { MapModel, StopMarker } from './mapModel';
import type { DriverPosition } from './useDriverLocation';

/**
 * Geofences for the web prototype (docs/PLAN.md §8): while the app is open with GPS on,
 * check the distance to the next few private driveways and speak once when one is close.
 * Safari stops running a page in the background, so the screen is kept on (Wake Lock);
 * true background geofences need the native app.
 */

export const ALERT_RADIUS_M = 150;
/** Only the next few stops are watched (the native app's 20-region limit works the same way). */
export const WATCHED_STOPS = 3;

const ll = (p: { lat: number; lng: number }): LatLng => ({ latitude: p.lat, longitude: p.lng });

export interface DrivewayAlert {
  stopNumber: number;
  text: string;
}

/**
 * The alert to give now, if any: the first of the next stops that is a private driveway,
 * not announced yet, and within the radius. The side comes from the direction of travel
 * (previous GPS fix → entry).
 */
export function drivewayAlert(
  me: LatLng,
  previous: LatLng | null,
  upcoming: StopMarker[],
  announced: ReadonlySet<number>,
): DrivewayAlert | null {
  for (const stop of upcoming.slice(0, WATCHED_STOPS)) {
    if (!stop.entry || !stop.driveway?.isPrivate || announced.has(stop.stopNumber)) continue;
    const entry = ll(stop.entry);
    const meters = distanceMeters(me, entry);
    if (meters > ALERT_RADIUS_M) continue;
    const side = previous ? sideOfArrival(previous, entry, ll(stop)) : null;
    const rounded = Math.max(10, Math.round(meters / 10) * 10);
    return {
      stopNumber: stop.stopNumber,
      text: `Private driveway in ${rounded} meters${side ? `, on the ${side}` : ''}. Stop ${stop.stopNumber}.`,
    };
  }
  return null;
}

function speak(text: string) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    synth.speak(utterance);
  } catch {
    // No voice available: the alert is still shown on screen.
  }
}

/** A fix this far from the last one gives a usable direction of travel. */
const MIN_MOVE_M = 10;

export function useDrivewayAlerts(me: DriverPosition | null, model: MapModel, enabled: boolean) {
  const [message, setMessage] = useState<string | null>(null);
  const announced = useRef(new Set<number>());
  const previous = useRef<LatLng | null>(null);
  const last = useRef<LatLng | null>(null);

  const upcoming = useMemo(() => {
    const index = model.current ? model.sequence.findIndex((m) => m.stopNumber === model.current!.stopNumber) : -1;
    return index >= 0 ? model.sequence.slice(index) : [];
  }, [model]);
  const hasFix = me !== null;

  useEffect(() => {
    if (!me || !enabled) return;
    const here = ll(me);
    if (!last.current || distanceMeters(last.current, here) >= MIN_MOVE_M) {
      previous.current = last.current;
      last.current = here;
    }
    const alert = drivewayAlert(here, previous.current, upcoming, announced.current);
    if (!alert) return;
    announced.current.add(alert.stopNumber);
    setMessage(alert.text);
    speak(alert.text);
  }, [me, enabled, upcoming]);

  // Keep the screen on while alerts can fire (the page stops when the phone locks).
  useEffect(() => {
    if (!enabled || !hasFix || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const request = () =>
      navigator.wakeLock
        .request('screen')
        .then((l) => {
          if (cancelled) l.release();
          else lock = l;
        })
        .catch(() => undefined);
    const onVisible = () => document.visibilityState === 'visible' && request();
    request();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      lock?.release().catch(() => undefined);
    };
  }, [enabled, hasFix]);

  /** Called from a tap: iOS only allows speech that started from a user gesture once. */
  const unlock = useCallback(() => speak('Voice alerts on.'), []);

  return { message, unlock };
}
