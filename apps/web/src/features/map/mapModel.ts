import { DEFAULT_DRIVEWAY_THRESHOLD_M, detectPrivateDriveway, type StopDraft } from '@easy-ground/core';
import type { GeoResult } from '../../store/api';

export type MarkerState = 'current' | 'pending' | 'check' | 'done';

export interface StopMarker {
  stopNumber: number;
  lat: number;
  lng: number;
  state: MarkerState;
  stop: StopDraft;
  geo: GeoResult;
  /** Where the truck stops, on the road (Google navigation point); null when unknown. */
  entry: { lat: number; lng: number } | null;
  /** House-to-road distance and whether it counts as a private driveway (null without an entry). */
  driveway: { isPrivate: boolean; distanceM: number } | null;
}

/** Where to drive to: the road entry when known, else the house. */
export const drivePoint = (m: StopMarker) => m.entry ?? { lat: m.lat, lng: m.lng };

export interface MapModel {
  markers: StopMarker[];
  /** Pending stops in driving order, current first — drawn as the route line. */
  path: [number, number][];
  current: StopMarker | null;
  /** Pending stops that can't be drawn yet (not located / not found). */
  unlocated: number;
  /** Pending stops on the map, in driving order (drives Prev/Next). */
  sequence: StopMarker[];
  /** Located pending stops missing from the optimized order (added after optimizing). */
  outsideOrder: number;
}

/**
 * Turn the route into what the map draws. Pending stops follow `order` (the optimized
 * sequence) when given, else GroundCloud's "#"; stops missing from `order` go last.
 */
export function buildMapModel(
  drafts: StopDraft[],
  geo: Record<number, GeoResult>,
  currentStopNumber: number | null,
  order?: number[] | null,
  drivewayThresholdM = DEFAULT_DRIVEWAY_THRESHOLD_M,
): MapModel {
  const located = drafts.filter((d) => {
    const g = geo[d.stopNumber];
    return g && g.lat !== null && g.lng !== null && (g.status === 'ok' || g.status === 'review');
  });
  const rank = new Map((order ?? []).map((n, i) => [n, i]));
  const pending = located
    .filter((d) => !d.completed)
    .sort((a, b) => (rank.get(a.stopNumber) ?? Infinity) - (rank.get(b.stopNumber) ?? Infinity) || a.stopNumber - b.stopNumber);
  const current =
    pending.find((d) => d.stopNumber === currentStopNumber) ?? pending[0] ?? null;

  const markers: StopMarker[] = located.map((stop) => {
    const g = geo[stop.stopNumber];
    const state: MarkerState = stop.completed
      ? 'done'
      : stop.stopNumber === current?.stopNumber
        ? 'current'
        : g.status === 'review'
          ? 'check'
          : 'pending';
    const entry = g.entry_lat != null && g.entry_lng != null ? { lat: g.entry_lat, lng: g.entry_lng } : null;
    const check = entry
      ? detectPrivateDriveway({ latitude: g.lat!, longitude: g.lng! }, { latitude: entry.lat, longitude: entry.lng }, drivewayThresholdM)
      : null;
    const driveway = check && { isPrivate: check.isPrivateDriveway, distanceM: check.drivewayDistanceM };
    return { stopNumber: stop.stopNumber, lat: g.lat!, lng: g.lng!, state, stop, geo: g, entry, driveway };
  });

  const ordered = current ? pending.slice(pending.indexOf(current)) : [];
  const byNumber = new Map(markers.map((m) => [m.stopNumber, m]));
  return {
    markers,
    // The truck drives to each stop's road entry, so the line goes there.
    path: ordered.map((d) => {
      const p = drivePoint(byNumber.get(d.stopNumber)!);
      return [p.lat, p.lng];
    }),
    current: markers.find((m) => m.state === 'current') ?? null,
    unlocated: drafts.filter((d) => !d.completed && d.addressRaw).length - pending.length,
    sequence: pending.map((d) => byNumber.get(d.stopNumber)!),
    outsideOrder: order ? pending.filter((d) => !rank.has(d.stopNumber)).length : 0,
  };
}

/** Deep links that open turn-by-turn navigation to a stop in the phone's maps app. */
export function navigationLinks(lat: number, lng: number) {
  const dest = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  return {
    apple: `https://maps.apple.com/?daddr=${dest}&dirflg=d`,
    google: `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`,
  };
}
