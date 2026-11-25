import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  cheapestInsertionIndex,
  DEFAULT_DRIVEWAY_THRESHOLD_M,
  looksLikeBusiness,
  type ParseIssue,
  type ParseResult,
  type RightSideMode,
  type StopDraft,
} from '@easy-ground/core';
import type { GeoResult, RouteArea } from './api';

export interface RouteState {
  drafts: StopDraft[];
  issues: ParseIssue[];
  sourceName: string | null;
  currentStopNumber: number | null;
  /** Route area for geocoding; kept when the route is cleared (same area every day). */
  area: RouteArea | null;
  /** Geocoding results by stop number. Dropped when that stop's address changes. */
  geo: Record<number, GeoResult>;
  /** Which order the map follows: GroundCloud's "#" or our optimized sequence. */
  orderMode: 'groundcloud' | 'optimized';
  optimized: OptimizedOrder | null;
  /** Businesses and pickups first when optimizing (they close / have pickup windows). */
  priorityFirst: boolean;
  /** Driver preferences; kept when the route is cleared. */
  settings: DriverSettings;
}

export interface DriverSettings {
  /** How much the optimizer cares about the house being on the right (loading door side). */
  rightSide: RightSideMode;
  /** House-to-road distance above which a stop is a private driveway. */
  drivewayThresholdM: number;
  /** Spoken alerts when approaching a private driveway. */
  voiceAlerts: boolean;
}

export const defaultSettings: DriverSettings = {
  rightSide: 'prefer',
  drivewayThresholdM: DEFAULT_DRIVEWAY_THRESHOLD_M,
  voiceAlerts: true,
};

export interface OptimizedOrder {
  /** Stop numbers in driving order, starting at the stop that was current when optimizing. */
  order: number[];
  /** Path length in meters (see `metric`): ours vs GroundCloud's order over the same stops. */
  distanceM: number;
  baselineM: number;
  /** Where the optimization started: the driver's GPS position or the current stop. */
  startedFrom?: 'location' | 'stop';
  /** How many businesses/pickups were put first (0 = plain shortest order). */
  priorityCount?: number;
  /** How distances were measured: by road (Google) or straight-line (no key / offline). */
  metric?: 'road' | 'straight';
  /** Right-side mode used, stops reached with the house on the left, and meters it added. */
  rightSide?: RightSideMode;
  leftArrivals?: number;
  sideExtraM?: number;
  /** Houses on the left in GroundCloud's order, measured the same way. */
  baselineLeftArrivals?: number;
}

export const initialRouteState: RouteState = {
  drafts: [],
  issues: [],
  sourceName: null,
  currentStopNumber: null,
  area: null,
  geo: {},
  orderMode: 'groundcloud',
  optimized: null,
  priorityFirst: true,
  settings: defaultSettings,
};

/** Guess "business" for stops that don't say yet (the driver can flip it). */
const withBusinessGuess = (d: StopDraft): StopDraft => (d.business === undefined ? { ...d, business: looksLikeBusiness(d) } : d);

const byStopNumber = (a: StopDraft, b: StopDraft) => a.stopNumber - b.stopNumber;
const withoutIssuesFor = (issues: ParseIssue[], stopNumber: number) =>
  issues.filter((i) => i.stopNumber !== stopNumber);

const routeSlice = createSlice({
  name: 'route',
  initialState: initialRouteState,
  reducers: {
    /** Merge a capture's stops, deduplicating by GroundCloud stop number (`#`). */
    manifestImported(state, action: PayloadAction<ParseResult & { sourceName: string }>) {
      const byNumber = new Map(state.drafts.map((d) => [d.stopNumber, d]));
      for (const d of action.payload.stops) {
        if (byNumber.get(d.stopNumber)?.addressRaw !== d.addressRaw) delete state.geo[d.stopNumber];
        byNumber.set(d.stopNumber, withBusinessGuess(d));
      }
      state.drafts = [...byNumber.values()].sort(byStopNumber);
      state.issues = [...state.issues, ...action.payload.issues];
      state.sourceName = action.payload.sourceName;
    },

    /**
     * Save the driver's corrections to a stop. Editing counts as reviewing it, so its OCR
     * flags are cleared. Renumbering is ignored if the new number is already taken.
     */
    stopUpdated(state, action: PayloadAction<{ stopNumber: number; changes: Partial<StopDraft> }>) {
      const { stopNumber, changes } = action.payload;
      const stop = state.drafts.find((d) => d.stopNumber === stopNumber);
      if (!stop) return;
      const renumberTo = changes.stopNumber;
      if (renumberTo !== undefined && renumberTo !== stopNumber && state.drafts.some((d) => d.stopNumber === renumberTo)) {
        return;
      }
      const geo = state.geo[stopNumber];
      delete state.geo[stopNumber];
      const addressChanged = changes.addressRaw !== undefined && changes.addressRaw !== stop.addressRaw;
      Object.assign(stop, changes);
      // Keep the location unless the address changed (then it must be located again).
      if (geo && !addressChanged) state.geo[stop.stopNumber] = geo;
      if (state.optimized && stop.stopNumber !== stopNumber) {
        state.optimized.order = state.optimized.order.map((n) => (n === stopNumber ? stop.stopNumber : n));
      }
      state.drafts.sort(byStopNumber);
      state.issues = withoutIssuesFor(state.issues, stopNumber);
    },

    /** The driver checked a flagged stop and it is correct as read. */
    stopReviewed(state, action: PayloadAction<number>) {
      state.issues = withoutIssuesFor(state.issues, action.payload);
      // The driver confirmed an approximate/autocompleted map match.
      const geo = state.geo[action.payload];
      if (geo?.status === 'review') geo.status = 'ok';
    },

    stopRemoved(state, action: PayloadAction<number>) {
      state.drafts = state.drafts.filter((d) => d.stopNumber !== action.payload);
      state.issues = withoutIssuesFor(state.issues, action.payload);
      delete state.geo[action.payload];
      if (state.optimized) state.optimized.order = state.optimized.order.filter((n) => n !== action.payload);
    },

    /** Add a stop by hand (a row OCR could not read, or a late addition). */
    stopAdded(state, action: PayloadAction<StopDraft>) {
      if (state.drafts.some((d) => d.stopNumber === action.payload.stopNumber)) return;
      state.drafts.push(withBusinessGuess(action.payload));
      state.drafts.sort(byStopNumber);
    },

    /** Dismiss a page-level problem (e.g. an unread row the driver already handled). */
    issueDismissed(state, action: PayloadAction<number>) {
      const general = state.issues.filter((i) => i.stopNumber === undefined);
      const target = general[action.payload];
      state.issues = state.issues.filter((i) => i !== target);
    },

    routeCleared(state) {
      return { ...initialRouteState, area: state.area, settings: state.settings };
    },

    areaSet(state, action: PayloadAction<RouteArea | null>) {
      state.area = action.payload;
      state.geo = {}; // results depend on the area
      state.optimized = null;
      state.orderMode = 'groundcloud';
    },

    routeOptimized(state, action: PayloadAction<OptimizedOrder>) {
      state.optimized = action.payload;
      // Plain optimization: only switch when it actually helps (GroundCloud's order is road-aware).
      // Priority-first is a different goal (businesses/pickups early), so it always applies.
      // So is a right-side order that puts fewer houses on the left than GroundCloud's.
      const { priorityCount, distanceM, baselineM, leftArrivals, baselineLeftArrivals } = action.payload;
      const prioritized = (priorityCount ?? 0) > 0;
      const fewerLeft = leftArrivals !== undefined && baselineLeftArrivals !== undefined && leftArrivals < baselineLeftArrivals;
      state.orderMode = prioritized || fewerLeft || distanceM < baselineM ? 'optimized' : 'groundcloud';
      // Starting from the driver's position, the first stop of the new order is where to go now.
      if (state.orderMode === 'optimized' && action.payload.startedFrom === 'location') {
        state.currentStopNumber = action.payload.order[0] ?? state.currentStopNumber;
      }
    },

    orderModeSet(state, action: PayloadAction<RouteState['orderMode']>) {
      state.orderMode = action.payload === 'optimized' && !state.optimized ? 'groundcloud' : action.payload;
    },

    priorityFirstSet(state, action: PayloadAction<boolean>) {
      state.priorityFirst = action.payload;
    },

    settingsChanged(state, action: PayloadAction<Partial<DriverSettings>>) {
      state.settings = { ...state.settings, ...action.payload };
    },

    currentStopSet(state, action: PayloadAction<number | null>) {
      state.currentStopNumber = action.payload;
    },

    stopsLocated(state, action: PayloadAction<GeoResult[]>) {
      for (const result of action.payload) state.geo[Number(result.id)] = result;
      // A stop added from a package label slots into the optimized order where it costs
      // the least, instead of waiting at the end for a full re-optimize.
      const order = state.optimized?.order;
      if (!order) return;
      for (const result of action.payload) {
        const n = Number(result.id);
        const stop = state.drafts.find((d) => d.stopNumber === n);
        if (stop?.source !== 'label' || order.includes(n) || result.lat === null || result.lng === null) continue;
        const located = order.filter((m) => state.geo[m]?.lat != null && state.geo[m]?.lng != null);
        const path = located.map((m) => ({ latitude: state.geo[m].lat!, longitude: state.geo[m].lng! }));
        const at = cheapestInsertionIndex(path, { latitude: result.lat, longitude: result.lng });
        const before = located[at];
        order.splice(before === undefined ? order.length : order.indexOf(before), 0, n);
      }
    },

    /**
     * A scanned label matched a stop already on the route. Its tracking number is kept so a
     * second scan of the same box is recognized; `extraPackage` when the box wasn't counted
     * in the manifest's Pkgs.
     */
    labelScannedAtStop(state, action: PayloadAction<{ stopNumber: number; trackingNumber: string | null; extraPackage: boolean }>) {
      const { stopNumber, trackingNumber, extraPackage } = action.payload;
      const stop = state.drafts.find((d) => d.stopNumber === stopNumber);
      if (!stop) return;
      if (trackingNumber && !stop.trackingNumbers?.includes(trackingNumber)) {
        stop.trackingNumbers = [...(stop.trackingNumbers ?? []), trackingNumber];
      }
      if (extraPackage) stop.packageCount += 1;
    },
  },
});

export const {
  manifestImported,
  stopUpdated,
  stopReviewed,
  stopRemoved,
  stopAdded,
  issueDismissed,
  routeCleared,
  areaSet,
  stopsLocated,
  labelScannedAtStop,
  currentStopSet,
  routeOptimized,
  orderModeSet,
  priorityFirstSet,
  settingsChanged,
} = routeSlice.actions;
export default routeSlice.reducer;

export const nextFreeStopNumber = (drafts: StopDraft[]) =>
  drafts.reduce((max, d) => Math.max(max, d.stopNumber), 0) + 1;
