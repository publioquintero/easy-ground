/** Data model v2 — see docs/PLAN.md §5. */

export interface LatLng {
  latitude: number;
  longitude: number;
}

export type StopType = 'delivery' | 'pickup';
export type StopStatus = 'pending' | 'delivered' | 'attempted' | 'skipped';
export type ApproachSide = 'right' | 'left' | 'either';
export type AddressConfidence = 'ocr_exact' | 'completed_by_geocoder' | 'manual';

/** A stop as read from GroundCloud, before geocoding/routing. */
export interface StopDraft {
  /** GroundCloud `#` column — unique key within a route (SID is NOT unique). */
  stopNumber: number;
  stopType: StopType;
  /** GroundCloud `SID` column — shelf / load zone, shared by several stops. */
  shelfId: string | null;
  packageCount: number;
  customerName: string | null;
  /** Raw address as read (may be truncated with "…"). */
  addressRaw: string;
  addressLine2: string | null;
  /** True when GroundCloud already shows Delivered/Attempted. */
  completed: boolean;
  /** Commercial stop (delivered first). Guessed on import, editable by the driver. */
  business?: boolean;
  /** Where the stop came from. Absent means the manifest (or typed by hand before labels existed). */
  source?: StopSource;
  /** City/state/ZIP when known for this stop (a package label has them; the manifest doesn't). */
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  /** Tracking numbers of packages scanned from their labels at this stop. */
  trackingNumbers?: string[];
  /** Customer instructions from GroundCloud's stop card ("CUST REQ: …"). */
  customerNotes?: string | null;
  /** Pickups only: when the pickup can be made. Absent/null = the driver's default window. */
  pickupWindow?: TimeWindow | null;
}

/** A time range on the route's day, local time "HH:MM". */
export interface TimeWindow {
  from: string;
  to: string;
}

export type StopSource = 'manifest' | 'manual' | 'label' | 'recording';

export interface Stop extends StopDraft {
  stopId: string;
  routeDate: string;
  sequenceOrder: number | null;
  houseNumber: string;
  streetAddress: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  addressConfidence: AddressConfidence;
  houseLatLng: LatLng | null;
  entryLatLng: LatLng | null;
  isPrivateDriveway: boolean;
  drivewayDistanceM: number | null;
  approachSide: ApproachSide;
  packagesChecked: number;
  visualNote: string | null;
  entryPhotoUrl: string | null;
  status: StopStatus;
}
