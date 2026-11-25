import type { LatLng } from './model';

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in meters (haversine). */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Default threshold between house and road entry to flag a private driveway (PLAN §6). */
export const DEFAULT_DRIVEWAY_THRESHOLD_M = 65;

export function detectPrivateDriveway(
  house: LatLng,
  entry: LatLng,
  thresholdM = DEFAULT_DRIVEWAY_THRESHOLD_M,
): { isPrivateDriveway: boolean; drivewayDistanceM: number } {
  const drivewayDistanceM = Math.round(distanceMeters(house, entry) * 10) / 10;
  return { isPrivateDriveway: drivewayDistanceM > thresholdM, drivewayDistanceM };
}
