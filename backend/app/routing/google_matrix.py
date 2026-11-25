"""Road distances between nearby stops for the optimizer (Google Routes `computeRouteMatrix`).

A full matrix grows with the square of the stops (120 stops = 14,400 billed elements), so
only each stop's `neighbors` nearest stops (straight-line) get a road distance. Those are
the pairs the optimizer actually chains together; it estimates the rest from the straight
line. Pairs are cached in Redis by their coordinates, so "Re-optimize" only pays for the
pairs involving the driver's new position.

Road distance is treated as symmetric (one direction is requested per pair): one-way
streets make A→B and B→A differ a little, which matters far less than a missing road.
"""

import asyncio
import hashlib
import json
import math
import re

import httpx

from app.geocoding.cache import log  # shared logger setup
from app.routing.models import MatrixPair, Point, RoadMatrixResponse

URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix"
FIELD_MASK = "originIndex,destinationIndex,distanceMeters,duration,condition,status"
CACHE_TTL_S = 30 * 24 * 3600  # roads between two houses rarely change
CONCURRENCY = 6
MAX_DESTINATIONS = 50


class MatrixError(Exception):
    pass


def straight_m(a: Point, b: Point) -> float:
    dlat = math.radians(b.lat - a.lat)
    dlng = math.radians(b.lng - a.lng)
    h = math.sin(dlat / 2) ** 2 + math.cos(math.radians(a.lat)) * math.cos(math.radians(b.lat)) * math.sin(dlng / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(h))


def neighbor_pairs(points: list[Point], k: int) -> list[tuple[int, int]]:
    """Unordered pairs (i < j) linking each point to its k nearest others, without repeats."""
    pairs: set[tuple[int, int]] = set()
    for i, p in enumerate(points):
        others = sorted((straight_m(p, q), j) for j, q in enumerate(points) if j != i)
        for _, j in others[:k]:
            pairs.add((min(i, j), max(i, j)))
    return sorted(pairs)


def _seconds(duration: str) -> int:
    match = re.fullmatch(r"(\d+(?:\.\d+)?)s", duration or "0s")
    return round(float(match.group(1))) if match else 0


def _cache_key(a: Point, b: Point) -> str:
    ends = sorted(f"{p.lat:.5f},{p.lng:.5f}" for p in (a, b))
    return "matrix:v1:google:" + hashlib.sha256("|".join(ends).encode()).hexdigest()[:32]


def _waypoint(p: Point) -> dict:
    return {"waypoint": {"location": {"latLng": {"latitude": p.lat, "longitude": p.lng}}}}


async def _row(
    client: httpx.AsyncClient, api_key: str, origin: Point, destinations: list[Point], gate: asyncio.Semaphore
) -> list[tuple[int | None, int | None]]:
    """(distance_m, duration_s) from one origin to each destination; None when no road route."""
    body = {
        "origins": [_waypoint(origin)],
        "destinations": [_waypoint(d) for d in destinations],
        "travelMode": "DRIVE",
        "routingPreference": "TRAFFIC_UNAWARE",
    }
    async with gate:
        response = await client.post(
            URL, json=body, headers={"X-Goog-Api-Key": api_key, "X-Goog-FieldMask": FIELD_MASK}
        )
    if response.status_code != 200:
        raise MatrixError(f"Route Matrix API {response.status_code}: {response.text[:200]}")
    out: list[tuple[int | None, int | None]] = [(None, None)] * len(destinations)
    for element in response.json():
        # Proto3 JSON leaves out zero values, so index 0 arrives as a missing field.
        j = element.get("destinationIndex", 0)
        if element.get("condition") == "ROUTE_EXISTS" and 0 <= j < len(destinations):
            out[j] = (element.get("distanceMeters", 0), _seconds(element.get("duration", "0s")))
    return out


async def road_matrix(
    client: httpx.AsyncClient, api_key: str, points: list[Point], neighbors: int, redis=None
) -> RoadMatrixResponse:
    pairs = neighbor_pairs(points, neighbors)
    keys = [_cache_key(points[i], points[j]) for i, j in pairs]
    found: dict[tuple[int, int], tuple[int | None, int | None]] = {}

    if redis is not None and keys:
        try:
            for pair, raw in zip(pairs, await redis.mget(keys), strict=True):
                if raw is not None:
                    found[pair] = tuple(json.loads(raw))
        except Exception:  # noqa: BLE001 — cache is best-effort
            log.warning("matrix cache read failed", exc_info=True)

    # One request per origin with only the destinations it needs: billing is per element
    # (origins × destinations), so a rectangular batch would pay for pairs nobody uses.
    missing: dict[int, list[int]] = {}
    for i, j in pairs:
        if (i, j) not in found:
            missing.setdefault(i, []).append(j)
    gate = asyncio.Semaphore(CONCURRENCY)
    jobs = [
        (i, dests[s : s + MAX_DESTINATIONS])
        for i, dests in missing.items()
        for s in range(0, len(dests), MAX_DESTINATIONS)
    ]
    rows = await asyncio.gather(*(_row(client, api_key, points[i], [points[j] for j in js], gate) for i, js in jobs))
    fresh: dict[tuple[int, int], tuple[int | None, int | None]] = {}
    for (i, js), row in zip(jobs, rows, strict=True):
        for j, value in zip(js, row, strict=True):
            fresh[(i, j)] = value
    found.update(fresh)

    if redis is not None and fresh:
        try:
            async with redis.pipeline(transaction=False) as pipe:
                for (i, j), value in fresh.items():
                    pipe.set(_cache_key(points[i], points[j]), json.dumps(value), ex=CACHE_TTL_S)
                await pipe.execute()
        except Exception:  # noqa: BLE001 — cache is best-effort
            log.warning("matrix cache write failed", exc_info=True)

    return RoadMatrixResponse(
        provider="google",
        pairs=[MatrixPair(i=i, j=j, distance_m=found[(i, j)][0], duration_s=found[(i, j)][1]) for i, j in pairs],
        billed_elements=len(fresh),
    )
