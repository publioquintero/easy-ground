import type { LatLng } from '../model';
import { optimizeRoute, type OptimizeOptions, type OptimizeResult, type RoutePoint } from './optimize';

/**
 * Priority stops (businesses, pickups) first, then the rest: each group is optimized on its
 * own, and the second one starts where the first one ends.
 */
export function optimizeWithPriority(
  points: RoutePoint[],
  priorityIds: ReadonlySet<number>,
  options: OptimizeOptions = {},
): OptimizeResult & { priorityCount: number } {
  const priority = points.filter((p) => priorityIds.has(p.id));
  const rest = points.filter((p) => !priorityIds.has(p.id));
  if (priority.length === 0 || rest.length === 0) {
    return { ...optimizeRoute(points, options), priorityCount: priority.length };
  }
  const first = optimizeRoute(priority, options);
  const last = priority.find((p) => p.id === first.order.at(-1))!;
  const from: LatLng = { latitude: last.latitude, longitude: last.longitude };
  const second = optimizeRoute(rest, { ...options, start: from });
  const sideOn = first.leftArrivals !== undefined || second.leftArrivals !== undefined;
  return {
    order: [...first.order, ...second.order],
    distance: first.distance + second.distance,
    priorityCount: priority.length,
    ...(sideOn && {
      leftArrivals: (first.leftArrivals ?? 0) + (second.leftArrivals ?? 0),
      sideExtra: (first.sideExtra ?? 0) + (second.sideExtra ?? 0),
    }),
  };
}
