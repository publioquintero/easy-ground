import { lazy, Suspense, useMemo, useState } from 'react';
import { skipToken } from '@reduxjs/toolkit/query';
import { useLazyRoadMatrixQuery, useRoadPathQuery } from '../../store/api';
import { useAppDispatch, useAppSelector } from '../../store';
import { currentStopSet, orderModeSet, priorityFirstSet, routeOptimized, settingsChanged, stopUpdated } from '../../store/routeSlice';
import { distanceMeters, isPriorityStop, pickupWindowOf, roadDistance, sideOfArrival, simulateRoute, timeLimits, timeToday, type RightSideMode, type TimeRules } from '@easy-ground/core';
import { formatClock, formatHhmm, formatWindow } from '../time';
import { buildMapModel, drivePoint, navigationLinks } from './mapModel';
import { DriverSettingsPanel } from './DriverSettingsPanel';
import { useDrivewayAlerts } from './useDrivewayAlerts';
import { computeOptimizedOrder, miles, optimizationPoints } from './useOptimize';
import { useDriverLocation, type LocationStatus } from './useDriverLocation';

/** Leading house number of a street address ("8952 N CEDAR PASS RD" → "8952"), or null. */
export function houseNumberOf(address: string): string | null {
  const m = /^\s*(\d+[A-Z]?)\b/i.exec(address);
  return m ? m[1] : null;
}

/** 4,000 s → "1 h 7 min"; 600 s → "10 min". */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

const LOCATION_MESSAGE: Partial<Record<LocationStatus, string>> = {
  locating: 'Finding your location…',
  denied: 'Location permission is off. Allow it for this site in your browser settings.',
  unavailable: 'Could not get your location. Check that Location Services are on.',
  insecure: 'Your location needs a secure connection (HTTPS). It works on this computer via localhost; on the phone the app must be served over HTTPS.',
};

/** Show "house on the right/left" only when coming from this close (see `near`). */
const SIDE_HINT_MAX_M = 400;

// Leaflet is only loaded once there is something to show.
const RouteMap = lazy(() => import('./RouteMap'));

export function MapCard() {
  const dispatch = useAppDispatch();
  const { drafts, geo, currentStopNumber, orderMode, optimized, priorityFirst, settings } = useAppSelector((s) => s.route);
  const order = orderMode === 'optimized' ? optimized?.order : null;
  const location = useDriverLocation();
  const me = location.status === 'on' ? location.position : null;
  const [focusMe, setFocusMe] = useState(0);
  const [fetchMatrix, matrix] = useLazyRoadMatrixQuery();
  const model = useMemo(
    () => buildMapModel(drafts, geo, currentStopNumber, order, settings.drivewayThresholdM),
    [drafts, geo, currentStopNumber, order, settings.drivewayThresholdM],
  );
  const alerts = useDrivewayAlerts(me, model, settings.voiceAlerts);

  // Road geometry for the whole pending sequence: it only changes when the order or the
  // set of pending stops changes (not on every GPS update or stop selection). RTK Query
  // keys the cache by these values, so equal point lists never refetch.
  const roadPoints = useMemo(
    () =>
      model.sequence.map((m) => {
        const p = drivePoint(m);
        return { lat: Number(p.lat.toFixed(5)), lng: Number(p.lng.toFixed(5)) };
      }),
    [model.sequence],
  );
  const road = useRoadPathQuery(roadPoints.length >= 2 ? { points: roadPoints } : skipToken);
  // currentData: only the result for these exact points (data would show the previous route while loading).
  const roadPath = road.currentData?.path ?? null;

  if (model.markers.length === 0) return null;

  const current = model.current;
  const pendingOnMap = model.sequence;
  const index = current ? pendingOnMap.findIndex((m) => m.stopNumber === current.stopNumber) : -1;
  const go = (delta: number) => {
    const next = pendingOnMap[index + delta];
    if (next) dispatch(currentStopSet(next.stopNumber));
  };
  const priorityOnMap = model.sequence.filter((m) => isPriorityStop(m.stop)).length;
  // Business deliveries close at a set time and pickups have a window: estimate when the
  // route reaches each one, from now, with road drive times plus time spent at each stop.
  const rules: TimeRules = {
    businessCloseAt: settings.businessCloseAt ?? '16:00',
    pickupWindow: settings.pickupWindow ?? { from: '14:00', to: '17:00' },
  };
  const nowDate = new Date();
  const closeAt = timeToday(rules.businessCloseAt, nowDate);
  const pickupsOnMap = pendingOnMap.filter((m) => m.stop.stopType === 'pickup');
  const legs = road.currentData?.legs_duration_s;
  const timeCheck =
    legs && legs.length === pendingOnMap.length - 1 && (priorityOnMap > 0 || pickupsOnMap.length > 0)
      ? simulateRoute(pendingOnMap.map((m) => timeLimits(m.stop, rules, nowDate)), [0, ...legs], nowDate.getTime(), settings.stopMinutes ?? 2)
      : null;
  const arrivalOf = (n: number) => timeCheck?.arrivals[pendingOnMap.findIndex((m) => m.stopNumber === n)];
  const lastBusiness = pendingOnMap.filter((m) => isPriorityStop(m.stop)).at(-1);
  const pickupTimes = pickupsOnMap.map((m) => arrivalOf(m.stopNumber)!).filter((t) => t !== undefined);
  const lateLabel = (n: number) => {
    const m = pendingOnMap.find((x) => x.stopNumber === n)!;
    return m.stop.stopType === 'pickup' ? `#${n} (pickup ${formatWindow(pickupWindowOf(m.stop, rules))})` : `#${n} (business)`;
  };
  // Plan pickups with this route's real average speed (traffic, residential streets).
  const speedMps = road.currentData && road.currentData.duration_s > 0 ? road.currentData.distance_m / road.currentData.duration_s : undefined;
  const timing = { rules, now: nowDate, stopMinutes: settings.stopMinutes ?? 2, speedMps };
  // Road distances between nearby stops come from the server (cached there and here);
  // without them (no key, offline) the optimizer falls back to straight lines.
  const optimize = async (withPriority = priorityFirst, rightSide: RightSideMode = settings.rightSide) => {
    const from = me ? { latitude: me.lat, longitude: me.lng } : null;
    const points = optimizationPoints(model, from);
    if (!points) return;
    let distance;
    try {
      const { pairs } = await fetchMatrix({ points }, true).unwrap();
      distance = roadDistance(points.map((p) => ({ latitude: p.lat, longitude: p.lng })), pairs);
    } catch {
      distance = undefined;
    }
    const result = computeOptimizedOrder(model, from, withPriority, distance, rightSide, { ...timing, now: new Date() });
    if (result) dispatch(routeOptimized(result));
  };
  const optimizing = matrix.isFetching;
  const togglePriority = (on: boolean) => {
    dispatch(priorityFirstSet(on));
    if (optimized) optimize(on); // apply right away to the current optimized order
  };
  const setRightSide = (mode: RightSideMode) => {
    dispatch(settingsChanged({ rightSide: mode }));
    if (optimized) optimize(priorityFirst, mode);
  };
  const locateMe = () => {
    if (location.status === 'on') setFocusMe((n) => n + 1);
    else location.start();
  };
  // SID is not unique: when another pending stop shares it, the house number tells them apart.
  const house = current ? houseNumberOf(current.stop.addressRaw) : null;
  const street = current && house ? current.stop.addressRaw.trimStart().slice(house.length) : current?.stop.addressRaw;
  const sameSid = current?.stop.shelfId
    ? drafts.filter((d) => !d.completed && d.stopNumber !== current.stopNumber && d.shelfId === current.stop.shelfId)
    : [];
  const saved = optimized ? optimized.baselineM - optimized.distanceM : 0;
  // Side of the house on arrival: coming from the driver's position, else the previous stop.
  const prev = me ?? (index > 0 ? drivePoint(pendingOnMap[index - 1]) : null);
  const entry = current ? drivePoint(current) : null;
  // From far away the straight line says little about the street the truck arrives on.
  const near = prev && entry && distanceMeters({ latitude: prev.lat, longitude: prev.lng }, { latitude: entry.lat, longitude: entry.lng }) <= SIDE_HINT_MAX_M;
  const arrivalSide =
    current?.entry && entry && prev && near && !current.driveway?.isPrivate
      ? sideOfArrival({ latitude: prev.lat, longitude: prev.lng }, { latitude: entry.lat, longitude: entry.lng }, { latitude: current.lat, longitude: current.lng })
      : null;
  const links = entry ? navigationLinks(entry.lat, entry.lng) : null;
  const measure = optimized?.metric === 'road' ? 'by road' : 'straight-line';

  return (
    <section className="card map-card">
      <div className="card-head">
        <div>
          <h2>Route map</h2>
          <span className="muted small">
            {pendingOnMap.length} to go{model.unlocated > 0 && <span className="amber-text"> · {model.unlocated} not on map</span>}
          </span>
        </div>
        <button
          className={`button small-btn${location.status === 'on' ? ' located-btn' : ''}`}
          onClick={locateMe}
          disabled={location.status === 'locating' || location.status === 'insecure'}
        >
          {location.status === 'on' ? '◉ Center on me' : '◎ My location'}
        </button>
      </div>
      {LOCATION_MESSAGE[location.status] && (
        <p className={`small ${location.status === 'locating' ? 'muted' : 'amber-text'}`}>{LOCATION_MESSAGE[location.status]}</p>
      )}

      {pendingOnMap.length > 2 && (
        <div className="order-bar">
          <div className="segmented order-toggle" role="group" aria-label="Stop order">
            <button className={orderMode === 'groundcloud' ? 'on' : ''} onClick={() => dispatch(orderModeSet('groundcloud'))}>
              GC #
            </button>
            <button
              className={orderMode === 'optimized' ? 'on' : ''}
              disabled={optimizing}
              onClick={() => (optimized ? dispatch(orderModeSet('optimized')) : optimize())}
            >
              {optimizing ? 'Optimizing…' : 'Optimized'}
            </button>
          </div>
          {optimized && (
            <button className="button ghost small-btn" disabled={optimizing} onClick={() => optimize()} title="Re-optimize the stops left">
              ↻ {me ? 'From here' : 'Again'}
            </button>
          )}
          {priorityOnMap > 0 && (
            <label className="check priority-check">
              <input type="checkbox" checked={priorityFirst} onChange={(e) => togglePriority(e.target.checked)} />
              Businesses first ({priorityOnMap}) — they close at {formatHhmm(rules.businessCloseAt)}
            </label>
          )}
        </div>
      )}
      {optimized && (
        <p className="muted small order-note">
          {(optimized.priorityCount ?? 0) > 0 ? (
            <>
              <strong className="text">{optimized.priorityCount} business{optimized.priorityCount === 1 ? '' : 'es'} first</strong>, then homes
              {(optimized.timedCount ?? 0) > 0 && <>, pickups in their windows</>}:{' '}
              ≈ <strong className="text">{miles(optimized.distanceM)} mi</strong> {measure}
              {optimized.startedFrom === 'location' ? ' from your location.' : ` from stop #${optimized.order[0]}.`}
            </>
          ) : (optimized.timedCount ?? 0) > 0 ? (
            <>
              <strong className="text">{optimized.timedCount} pickup{optimized.timedCount === 1 ? '' : 's'} placed in their windows</strong>:{' '}
              ≈ <strong className="text">{miles(optimized.distanceM)} mi</strong> {measure}
              {optimized.startedFrom === 'location' ? ' from your location.' : ` from stop #${optimized.order[0]}.`}
            </>
          ) : saved > 0 ? (
            <>
              Optimized ≈ <strong className="text">{miles(optimized.distanceM)} mi</strong> vs {miles(optimized.baselineM)} mi
              in GroundCloud order (<span className="good">−{miles(saved)} mi</span>, {measure} estimate)
              {optimized.startedFrom === 'location' ? ', starting from your location.' : `, starting from stop #${optimized.order[0]}.`}
            </>
          ) : (
            <>GroundCloud's order is already as short ({miles(optimized.baselineM)} mi {measure}). Keeping it.</>
          )}
          {optimized.leftArrivals !== undefined && (
            <span>
              {' '}Right side ({optimized.rightSide === 'strict' ? 'strict' : 'preferred'}):{' '}
              <strong className="text">{optimized.leftArrivals}</strong> house{optimized.leftArrivals === 1 ? '' : 's'} on the left
              {optimized.baselineLeftArrivals !== undefined && <> (GroundCloud order: {optimized.baselineLeftArrivals})</>}
              {(optimized.sideExtraM ?? 0) >= 50 ? <>, +{miles(optimized.sideExtraM!)} mi for it.</> : '.'}
            </span>
          )}
          {model.outsideOrder > 0 && (
            <span className="amber-text"> {model.outsideOrder} new stop{model.outsideOrder === 1 ? '' : 's'} at the end — re-optimize.</span>
          )}
        </p>
      )}

      <p className="muted small drive-summary">
        {road.currentData ? (
          <>
            Driving {pendingOnMap.length} stops: <strong className="text">{miles(road.currentData.distance_m)} mi</strong> ·{' '}
            <strong className="text">{formatDuration(road.currentData.duration_s)}</strong> on the road (no stop time).
            {timeCheck && (
              timeCheck.late.length > 0 ? (
                <span className="amber-text">
                  {' '}{timeCheck.late.length} stop{timeCheck.late.length === 1 ? '' : 's'} outside their time:{' '}
                  {timeCheck.late.slice(0, 5).map(lateLabel).join(', ')}{timeCheck.late.length > 5 ? '…' : ''}.
                  {orderMode !== 'optimized' ? ' Try the optimized order.' : !priorityFirst && priorityOnMap > 0 ? ' Turn on "Businesses first".' : ''}
                </span>
              ) : (
                <span>
                  {lastBusiness && closeAt !== null && (
                    <>
                      {' '}Last business ≈ <strong className="text">{formatClock(arrivalOf(lastBusiness.stopNumber)!)}</strong>, before the{' '}
                      {formatClock(closeAt)} close.
                    </>
                  )}
                  {pickupTimes.length > 0 && (
                    <>
                      {' '}Pickups ≈ <strong className="text">{formatClock(Math.min(...pickupTimes))}</strong>
                      {pickupTimes.length > 1 && <>–<strong className="text">{formatClock(Math.max(...pickupTimes))}</strong></>}, in their windows
                      {timeCheck.waitS >= 60 ? <> ({formatDuration(timeCheck.waitS)} waiting for them to open).</> : '.'}
                    </>
                  )}
                </span>
              )
            )}
          </>
        ) : road.isFetching ? (
          'Getting road directions…'
        ) : road.error ? (
          'Road directions unavailable — showing straight lines.'
        ) : null}
      </p>

      <Suspense fallback={<div className="route-map placeholder">Loading map…</div>}>
        <RouteMap model={model} onSelect={(n) => dispatch(currentStopSet(n))} me={me} focusMe={focusMe} roadPath={roadPath} />
      </Suspense>

      {current ? (
        <div className="current-stop">
          <div className="current-head">
            <span className="current-num">#{current.stopNumber}</span>
            <div className="current-addr">
              <strong>
                {house && <span className="house-num">{house}</span>}
                {street}
              </strong>
              {current.stop.addressLine2 && <span className="addr2"> · {current.stop.addressLine2}</span>}
              {current.stop.customerName && <div className="meta">{current.stop.customerName}</div>}
              {current.stop.customerNotes && <div className="cust-notes">{current.stop.customerNotes}</div>}
              {current.stop.stopType === 'pickup' && (
                <div className="meta">
                  Pickup window <strong className="text">{formatWindow(pickupWindowOf(current.stop, rules))}</strong>
                  {arrivalOf(current.stopNumber) !== undefined && <> · arrive ≈ {formatClock(arrivalOf(current.stopNumber)!)}</>}
                </div>
              )}
              {current.state === 'check' && <span className="tag amber">Check map match</span>}
            </div>
          </div>
          {current.driveway?.isPrivate ? (
            <div className="side-bar driveway-bar">
              Private driveway · {Math.round(current.driveway.distanceM)} m from the road. Navigation goes to the entry.
            </div>
          ) : arrivalSide ? (
            <div className={`side-bar side-${arrivalSide}`}>{arrivalSide === 'right' ? 'House on the RIGHT ▶' : '◀ House on the LEFT'}</div>
          ) : null}
          {/* What the driver needs from the truck, readable at a glance from the seat. */}
          <div className="load-facts">
            <div className="fact">
              <strong>{current.stop.packageCount}</strong>
              <span>{current.stop.packageCount === 1 ? 'package' : 'packages'}</span>
            </div>
            <div className={`fact${sameSid.length > 0 ? ' shared-sid' : ''}`}>
              <strong>{current.stop.shelfId ?? '—'}</strong>
              <span>SID / shelf</span>
            </div>
            {house && (
              <div className="fact house-fact">
                <strong>{house}</strong>
                <span>House #</span>
              </div>
            )}
            {current.stop.stopType === 'pickup' && (
              <div className="fact pickup-fact">
                <strong>P</strong>
                <span>pickup</span>
              </div>
            )}
          </div>
          {sameSid.length > 0 && (
            <p className="small amber-text sid-note">
              SID {current.stop.shelfId} is also on{' '}
              {sameSid.map((d) => `#${d.stopNumber} (${houseNumberOf(d.addressRaw) ?? d.addressRaw})`).join(', ')} — match the house number.
            </p>
          )}
          <div className="row">
            <a className="button primary" href={links!.apple} target="_blank" rel="noreferrer">
              Navigate
            </a>
            <a className="button" href={links!.google} target="_blank" rel="noreferrer">
              Google Maps
            </a>
            <button
              className="button done-btn push-right"
              onClick={() => dispatch(stopUpdated({ stopNumber: current.stopNumber, changes: { completed: true } }))}
            >
              Delivered
            </button>
          </div>
          <div className="row stepper">
            <button className="button ghost" disabled={index <= 0} onClick={() => go(-1)}>‹ Prev</button>
            <span className="muted small">{index + 1} of {pendingOnMap.length}</span>
            <button className="button ghost" disabled={index >= pendingOnMap.length - 1} onClick={() => go(1)}>Next ›</button>
          </div>
        </div>
      ) : (
        <p className="good small">All stops on the map are done.</p>
      )}
      {alerts.message && <p className="small amber-text alert-note">{alerts.message}</p>}
      <DriverSettingsPanel onVoiceEnabled={alerts.unlock} onRightSide={setRightSide} rightSideDisabled={optimizing} />
    </section>
  );
}
