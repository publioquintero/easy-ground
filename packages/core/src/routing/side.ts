import { distanceMeters } from '../geo';
import type { LatLng } from '../model';

/**
 * Which side of the street a stop ends up on (docs/PLAN.md §7). The truck's loading door is
 * on the right, so arriving with the house on the right is nicer, but it is a preference,
 * not a rule: forcing it makes the driver go around blocks for nothing.
 *
 * - off: side is ignored, only distance counts.
 * - prefer: arriving with the house on the left costs a little extra in the optimizer, so a
 *   right-side order only wins when the detour is small. Capped (see PREFER_MAX_EXTRA).
 * - strict: right side first; the other side on the way back.
 */
export type RightSideMode = 'off' | 'prefer' | 'strict';

/** Extra meters a left-side arrival "costs" the optimizer, per mode. */
export const SIDE_PENALTY_M: Record<RightSideMode, number> = { off: 0, prefer: 150, strict: 3000 };
/** In "prefer", never accept a right-side order more than this much longer than the shortest. */
export const PREFER_MAX_EXTRA = 0.1;
/** A stop with no other stop this close is on a quiet road: crossing it is fine. */
export const ISOLATED_STOP_M = 250;

/** Flat local coordinates in meters around `ref` (plenty accurate at street scale). */
function local(ref: LatLng, p: LatLng): [number, number] {
  const k = (Math.PI / 180) * 6_371_008.8;
  return [(p.longitude - ref.longitude) * k * Math.cos((ref.latitude * Math.PI) / 180), (p.latitude - ref.latitude) * k];
}

/**
 * Side of the house when the truck arrives at `entry` (the point on the road) coming from
 * `from`. The arrival heading is approximated by the straight line from → entry, which is
 * the street's direction when consecutive stops are on the same street. Null when it can't
 * be told: the house is too close to the road point, the move is tiny, or the house is
 * roughly ahead/behind instead of to one side.
 */
export function sideOfArrival(from: LatLng, entry: LatLng, house: LatLng): 'right' | 'left' | null {
  const [hx, hy] = local(entry, from).map((v) => -v); // heading: from → entry
  const [ox, oy] = local(entry, house); // offset: entry → house
  const hLen = Math.hypot(hx, hy);
  const oLen = Math.hypot(ox, oy);
  if (hLen < 15 || oLen < 6) return null;
  const sine = (hx * oy - hy * ox) / (hLen * oLen); // > 0: house to the left of the heading
  if (sine > 0.35) return 'left';
  if (sine < -0.35) return 'right';
  return null;
}

/** Stops for which the side doesn't matter: no house point, or nobody else nearby. */
export function sideExempt(point: LatLng, others: LatLng[]): boolean {
  return !others.some((o) => o !== point && distanceMeters(o, point) < ISOLATED_STOP_M);
}
