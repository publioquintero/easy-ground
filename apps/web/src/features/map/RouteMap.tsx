import { useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Circle, CircleMarker, MapContainer, Marker, Polyline, TileLayer, useMap } from 'react-leaflet';
import { distanceMeters, isPriorityStop } from '@easy-ground/core';
import type { DriverPosition } from './useDriverLocation';
import type { MapModel, StopMarker } from './mapModel';

interface Props {
  model: MapModel;
  onSelect: (stopNumber: number) => void;
  me?: DriverPosition | null;
  /** Bump to fly the map to the driver's position. */
  focusMe?: number;
  /** Road geometry for the pending stops; straight dashed lines are drawn until it arrives. */
  roadPath?: [number, number][] | null;
}

const meIcon = L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });

/** Only frame the driver with the stops when they're in the area (not testing from home far away). */
const NEAR_ROUTE_M = 40_000;

const iconCache = new Map<string, L.DivIcon>();
function pinIcon(marker: StopMarker): L.DivIcon {
  const priority = isPriorityStop(marker.stop) || marker.stop.stopType === 'pickup';
  const key = `${marker.stopNumber}:${marker.state}:${priority}`;
  let icon = iconCache.get(key);
  if (!icon) {
    const size = marker.state === 'current' ? 40 : 30;
    icon = L.divIcon({
      className: '',
      // Businesses/pickups get a square pin so they stand out among homes.
      html: `<div class="pin pin-${marker.state}${priority ? ' pin-priority' : ''}">${marker.stopNumber}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
    iconCache.set(key, icon);
  }
  return icon;
}

/** Fit all stops once, then follow the current stop without fighting the driver's panning. */
function Camera({ model, me, focusMe }: { model: MapModel; me?: DriverPosition | null; focusMe?: number }) {
  const map = useMap();
  const fittedFor = useRef<number>(-1);
  const meNearRoute =
    !!me && model.markers.some((m) => distanceMeters({ latitude: me.lat, longitude: me.lng }, { latitude: m.lat, longitude: m.lng }) < NEAR_ROUTE_M);
  useEffect(() => {
    if (model.markers.length === 0 || fittedFor.current === model.markers.length) return;
    fittedFor.current = model.markers.length;
    const points: [number, number][] = model.markers.map((m) => [m.lat, m.lng]);
    if (me && meNearRoute) points.push([me.lat, me.lng]);
    const bounds = L.latLngBounds(points);
    // The map may mount before its container has its final size (lazy load, layout
    // changes): measure again before fitting, and once more after layout settles.
    const fit = () => {
      map.invalidateSize();
      map.fitBounds(bounds, { padding: [36, 36], maxZoom: 17 });
    };
    fit();
    const timer = window.setTimeout(fit, 250);
    return () => window.clearTimeout(timer);
  }, [map, model.markers]); // `me` is only read here for the first framing

  // The first GPS fix usually arrives after the stops are framed: re-frame once to include it.
  const framedMe = useRef(false);
  useEffect(() => {
    if (!me || framedMe.current || model.markers.length === 0) return;
    framedMe.current = true;
    if (!meNearRoute) return;
    const points: [number, number][] = [...model.markers.map((m): [number, number] => [m.lat, m.lng]), [me.lat, me.lng]];
    map.fitBounds(L.latLngBounds(points), { padding: [36, 36], maxZoom: 17 });
  }, [map, me, meNearRoute, model.markers]);

  // Fly to the driver only when asked (focusMe changes), not on every GPS update.
  useEffect(() => {
    if (focusMe && me) map.flyTo([me.lat, me.lng], Math.max(map.getZoom(), 16), { duration: 0.6 });
  }, [map, focusMe]);

  // Keep the map sized to its container (rotation, viewport changes).
  useEffect(() => {
    const container = map.getContainer();
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(container);
    return () => observer.disconnect();
  }, [map]);

  const current = model.current;
  useEffect(() => {
    if (current && !map.getBounds().pad(-0.1).contains([current.lat, current.lng])) {
      map.panTo([current.lat, current.lng]);
    }
  }, [map, current]);
  return null;
}

export default function RouteMap({ model, onSelect, me, focusMe, roadPath }: Props) {
  // Draw completed first so pending/current pins sit on top.
  const ordered = useMemo(() => {
    const rank = { done: 0, pending: 1, check: 2, current: 3 } as const;
    return [...model.markers].sort((a, b) => rank[a.state] - rank[b.state]);
  }, [model.markers]);

  return (
    <MapContainer className="route-map" center={[39.5, -98.35]} zoom={4} zoomControl={false} attributionControl>
      <TileLayer
        className="tiles-dark"
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        maxZoom={19}
      />
      {roadPath && roadPath.length > 1 ? (
        // Distinct keys: Leaflet's setStyle can't remove a dashArray, so remount instead of updating.
        <Polyline key="road" positions={roadPath} pathOptions={{ color: '#4c8dff', weight: 5, opacity: 0.85 }} />
      ) : (
        model.path.length > 1 && (
          <Polyline key="straight" positions={model.path} pathOptions={{ color: '#4c8dff', weight: 3, opacity: 0.6, dashArray: '6 8' }} />
        )
      )}
      {/* Private driveways: where the truck turns in (dot on the road) and the drive to the house. */}
      {ordered
        .filter((m) => m.entry && m.driveway?.isPrivate && m.state !== 'done')
        .map((m) => (
          <Polyline
            key={`drive-${m.stopNumber}`}
            positions={[[m.entry!.lat, m.entry!.lng], [m.lat, m.lng]]}
            pathOptions={{ color: '#f5b301', weight: 3, opacity: 0.9, dashArray: '4 6' }}
            interactive={false}
          />
        ))}
      {ordered
        .filter((m) => m.entry && m.driveway?.isPrivate && m.state !== 'done')
        .map((m) => (
          <CircleMarker
            key={`entry-${m.stopNumber}`}
            center={[m.entry!.lat, m.entry!.lng]}
            radius={5}
            pathOptions={{ color: '#0b0d10', weight: 2, fillColor: '#f5b301', fillOpacity: 1 }}
            interactive={false}
          />
        ))}
      {ordered.map((m) => (
        <Marker
          key={m.stopNumber}
          position={[m.lat, m.lng]}
          icon={pinIcon(m)}
          zIndexOffset={m.state === 'current' ? 1000 : 0}
          eventHandlers={{ click: () => onSelect(m.stopNumber) }}
        />
      ))}
      {me && (
        <>
          {me.accuracy < 1000 && (
            <Circle center={[me.lat, me.lng]} radius={me.accuracy} pathOptions={{ color: '#4c8dff', weight: 1, fillOpacity: 0.12 }} />
          )}
          <Marker position={[me.lat, me.lng]} icon={meIcon} zIndexOffset={2000} interactive={false} />
        </>
      )}
      <Camera model={model} me={me} focusMe={focusMe} />
    </MapContainer>
  );
}
