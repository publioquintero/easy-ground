import { useCallback, useEffect, useRef, useState } from 'react';

export interface DriverPosition {
  lat: number;
  lng: number;
  /** Radius of uncertainty in meters (GPS outdoors ~5–20 m; Wi-Fi/cell can be 100s). */
  accuracy: number;
  at: number;
}

export type LocationStatus = 'off' | 'locating' | 'on' | 'denied' | 'unavailable' | 'insecure';

const PREF_KEY = 'easy-ground:location-on';
const readPref = () => {
  try {
    return localStorage.getItem(PREF_KEY) === '1';
  } catch {
    return false;
  }
};
const writePref = (on: boolean) => {
  try {
    if (on) localStorage.setItem(PREF_KEY, '1');
    else localStorage.removeItem(PREF_KEY);
  } catch {
    // Not critical: the driver just taps the button again next time.
  }
};

/**
 * The phone's live position. It only starts on a tap (iOS asks for permission on a user
 * gesture) and resumes on its own next time if permission was already granted.
 * Browsers only expose GPS on secure origins: HTTPS or localhost.
 */
export function useDriverLocation() {
  const [status, setStatus] = useState<LocationStatus>(() =>
    typeof window !== 'undefined' && !window.isSecureContext ? 'insecure' : 'off',
  );
  const [position, setPosition] = useState<DriverPosition | null>(null);
  const watchId = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    setStatus((s) => (s === 'insecure' ? s : 'off'));
    writePref(false);
  }, []);

  const start = useCallback(() => {
    if (!window.isSecureContext) return setStatus('insecure');
    if (!('geolocation' in navigator)) return setStatus('unavailable');
    if (watchId.current !== null) return;
    setStatus('locating');
    writePref(true);
    watchId.current = navigator.geolocation.watchPosition(
      (p) => {
        setPosition({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: p.timestamp });
        setStatus('on');
      },
      (error) => {
        if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
        watchId.current = null;
        setStatus(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable');
        if (error.code === error.PERMISSION_DENIED) writePref(false);
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    );
  }, []);

  // Resume automatically when the driver turned it on before and permission is still granted.
  useEffect(() => {
    if (!readPref() || !window.isSecureContext) return;
    let cancelled = false;
    const permissions = navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    if (!permissions) return;
    permissions
      .then((p) => {
        if (!cancelled && p.state === 'granted') start();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [start]);

  useEffect(() => () => {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
  }, []);

  return { status, position, start, stop };
}
