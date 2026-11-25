"""Road geometry and driving distance/time for an ordered list of points (Google Routes API).

A request with more than 10 intermediate waypoints is billed at a higher SKU, so long
routes are split into chained chunks of at most 12 points (origin + 10 + destination),
each cached in Redis — the same legs repeat while the driver re-checks the route.
"""

import asyncio
import hashlib
import json
import re

import httpx

from app.geocoding.cache import log  # shared logger setup
from app.routing.models import Point, RoadPathResponse

URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
FIELD_MASK = "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.distanceMeters,routes.legs.duration"
CHUNK_POINTS = 12
CACHE_TTL_S = 7 * 24 * 3600


class RoutesError(Exception):
    pass


def decode_polyline(encoded: str) -> list[tuple[float, float]]:
    """Google's encoded polyline algorithm (precision 5)."""
    coords: list[tuple[float, float]] = []
    index = lat = lng = 0
    while index < len(encoded):
        for is_lng in (False, True):
            shift = result = 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if is_lng:
                lng += delta
            else:
                lat += delta
        coords.append((lat / 1e5, lng / 1e5))
    return coords


def _seconds(duration: str) -> int:
    match = re.fullmatch(r"(\d+(?:\.\d+)?)s", duration or "0s")
    return round(float(match.group(1))) if match else 0


def chunks(points: list[Point], size: int = CHUNK_POINTS) -> list[list[Point]]:
    """Split into consecutive chunks that share their boundary point."""
    out, i = [], 0
    while i < len(points) - 1:
        out.append(points[i : i + size])
        i += size - 1
    return out


def _waypoint(p: Point) -> dict:
    return {"location": {"latLng": {"latitude": p.lat, "longitude": p.lng}}}


def _cache_key(chunk: list[Point]) -> str:
    raw = "|".join(f"{p.lat:.5f},{p.lng:.5f}" for p in chunk)
    return "route:v1:google:" + hashlib.sha256(raw.encode()).hexdigest()[:32]


async def _route_chunk(client: httpx.AsyncClient, api_key: str, chunk: list[Point], redis) -> dict:
    key = _cache_key(chunk)
    if redis is not None:
        try:
            if cached := await redis.get(key):
                return json.loads(cached)
        except Exception:  # noqa: BLE001 — cache is best-effort
            log.warning("route cache read failed", exc_info=True)

    body = {
        "origin": _waypoint(chunk[0]),
        "destination": _waypoint(chunk[-1]),
        "intermediates": [_waypoint(p) for p in chunk[1:-1]],
        "travelMode": "DRIVE",
        "routingPreference": "TRAFFIC_UNAWARE",
    }
    response = await client.post(
        URL, json=body, headers={"X-Goog-Api-Key": api_key, "X-Goog-FieldMask": FIELD_MASK}
    )
    if response.status_code != 200:
        raise RoutesError(f"Routes API {response.status_code}: {response.text[:200]}")
    routes = response.json().get("routes") or []
    if not routes:
        raise RoutesError("no route between these points")
    route = routes[0]
    result = {
        "path": decode_polyline(route["polyline"]["encodedPolyline"]),
        "legs_distance_m": [leg.get("distanceMeters", 0) for leg in route.get("legs", [])],
        "legs_duration_s": [_seconds(leg.get("duration", "0s")) for leg in route.get("legs", [])],
    }
    if redis is not None:
        try:
            await redis.set(key, json.dumps(result), ex=CACHE_TTL_S)
        except Exception:  # noqa: BLE001 — cache is best-effort
            log.warning("route cache write failed", exc_info=True)
    return result


async def road_path(client: httpx.AsyncClient, api_key: str, points: list[Point], redis=None) -> RoadPathResponse:
    parts = await asyncio.gather(*(_route_chunk(client, api_key, c, redis) for c in chunks(points)))
    path: list[tuple[float, float]] = []
    legs_d: list[int] = []
    legs_t: list[int] = []
    for part in parts:
        segment = [tuple(p) for p in part["path"]]
        path.extend(segment[1:] if path and segment and segment[0] == path[-1] else segment)
        legs_d += part["legs_distance_m"]
        legs_t += part["legs_duration_s"]
    return RoadPathResponse(
        provider="google",
        path=path,
        distance_m=sum(legs_d),
        duration_s=sum(legs_t),
        legs_distance_m=legs_d,
        legs_duration_s=legs_t,
    )
