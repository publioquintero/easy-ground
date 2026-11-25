import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

export interface HealthResponse {
  status: 'ok';
  services: Record<'postgres' | 'redis' | 'storage', 'up' | 'down'>;
}

/** Where the route is — GroundCloud's manifest has no city/ZIP. */
export interface RouteArea {
  zip?: string;
  city?: string;
  state?: string;
}

export type GeoStatus = 'ok' | 'review' | 'not_found' | 'error';

export interface GeoResult {
  id: string;
  status: GeoStatus;
  lat: number | null;
  lng: number | null;
  accuracy: 'rooftop' | 'interpolated' | 'approximate' | null;
  formatted: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  street_side: 'L' | 'R' | null;
  /** Where the truck stops for this address (on the road). Google only. */
  entry_lat?: number | null;
  entry_lng?: number | null;
  provider: string;
  cached: boolean;
}

export interface GeocodeRequest {
  area: RouteArea;
  /** `zip` overrides the area for that address (known from a package label). */
  addresses: { id: string; address: string; zip?: string }[];
}

export interface RoadPathResponse {
  provider: string;
  path: [number, number][];
  distance_m: number;
  duration_s: number;
  legs_distance_m: number[];
  legs_duration_s: number[];
}

export interface RoadMatrixResponse {
  provider: string;
  /** Road distance between points[i] and points[j] (i < j); null when there is no road route. */
  pairs: { i: number; j: number; distance_m: number | null; duration_s: number | null }[];
  billed_elements: number;
}

export const api = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({ baseUrl: '/api' }),
  endpoints: (build) => ({
    health: build.query<HealthResponse, void>({ query: () => 'health' }),
    geocode: build.mutation<{ provider: string; results: GeoResult[] }, GeocodeRequest>({
      query: (body) => ({ url: 'geocode', method: 'POST', body }),
    }),
    // A POST that only reads: a query so RTK caches it by its points.
    roadPath: build.query<RoadPathResponse, { points: { lat: number; lng: number }[] }>({
      query: (body) => ({ url: 'routes/road-path', method: 'POST', body }),
      keepUnusedDataFor: 600,
    }),
    // Road distances between nearby points for the optimizer (also a read-only POST).
    roadMatrix: build.query<RoadMatrixResponse, { points: { lat: number; lng: number }[] }>({
      query: (body) => ({ url: 'routes/matrix', method: 'POST', body }),
      keepUnusedDataFor: 600,
    }),
  }),
});

export const { useHealthQuery, useGeocodeMutation, useRoadPathQuery, useLazyRoadMatrixQuery } = api;
