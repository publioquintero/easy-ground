import { looksLikeBusiness } from '@easy-ground/core';
import { defaultSettings, initialRouteState, type RouteState } from './routeSlice';

/**
 * Keep the route on this phone across reloads (iOS may kill a backgrounded PWA mid-route).
 * Customer data stays in this browser only. Storage can be unavailable (private mode),
 * so every access is guarded and the app works without it.
 */
const KEY = 'easy-ground:route:v1';

export function loadRoute(): RouteState | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return undefined;
    const saved = JSON.parse(raw) as Partial<RouteState>;
    if (!Array.isArray(saved.drafts)) return undefined;
    // Routes saved before stops had a "business" flag get it guessed now.
    const drafts = saved.drafts.map((d) => (d.business === undefined ? { ...d, business: looksLikeBusiness(d) } : d));
    // Settings added later get their defaults.
    return { ...initialRouteState, ...saved, drafts, settings: { ...defaultSettings, ...saved.settings } };
  } catch {
    return undefined;
  }
}

export function saveRoute(state: RouteState): void {
  try {
    if (state.drafts.length === 0 && state.issues.length === 0 && !state.area) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: the route still works for this session.
  }
}
