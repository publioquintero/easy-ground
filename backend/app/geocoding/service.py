import asyncio
import hashlib
from collections import Counter

import httpx

from app.geocoding.cache import GeocodeCache
from app.geocoding.models import (
    AddressIn,
    GeocodeRequest,
    GeocodeResponse,
    GeocodeResult,
    RouteArea,
)
from app.geocoding.providers import Geocoder, normalize_address

# Be polite to free/public endpoints and stay under provider QPS limits.
MAX_CONCURRENCY = 5


def cache_key(provider: str, address: str, area_key: str) -> str:
    # Hash so customer addresses aren't readable as plain Redis keys.
    digest = hashlib.sha256(f"{normalize_address(address)}|{area_key}".encode()).hexdigest()[:32]
    # v2: results carry the entry point (v1 entries had none and would never get one).
    return f"geocode:v2:{provider}:{digest}"


async def geocode_batch(
    request: GeocodeRequest, geocoder: Geocoder, cache: GeocodeCache, client: httpx.AsyncClient
) -> GeocodeResponse:
    semaphore = asyncio.Semaphore(MAX_CONCURRENCY)

    async def one(item_id: str, address: str, area: RouteArea) -> GeocodeResult:
        key = cache_key(geocoder.name, address, area.cache_key())
        if (hit := await cache.get(key)) is not None:
            return hit.model_copy(update={"id": item_id, "cached": True})
        async with semaphore:
            try:
                result = await geocoder.geocode(client, item_id, address, area)
            except httpx.HTTPError:
                return GeocodeResult(id=item_id, status="error", provider=geocoder.name)
        if result.status in ("ok", "review", "not_found"):
            await cache.set(key, result)
        return result

    def area_for(a: AddressIn) -> RouteArea:
        return RouteArea(zip=a.zip) if a.zip else request.area

    results = list(await asyncio.gather(*(one(a.id, a.address, area_for(a)) for a in request.addresses)))

    # A route crosses ZIP boundaries, but a ZIP filter only matches inside that ZIP. Retry the
    # misses in the city/state where the other stops were found.
    if request.area.zip:
        fallback = _dominant_city(results)
        has_own_zip = {a.id for a in request.addresses if a.zip}
        missing = [i for i, r in enumerate(results) if r.status == "not_found" and r.id not in has_own_zip]
        if fallback and missing:
            by_id = {a.id: a.address for a in request.addresses}
            retried = await asyncio.gather(*(one(results[i].id, by_id[results[i].id], fallback) for i in missing))
            for i, result in zip(missing, retried, strict=True):
                if result.status in ("ok", "review"):
                    results[i] = result
    return GeocodeResponse(provider=geocoder.name, results=results)


def _dominant_city(results: list[GeocodeResult]) -> RouteArea | None:
    cities = Counter((r.city, r.state) for r in results if r.status in ("ok", "review") and r.city and r.state)
    if not cities:
        return None
    (city, state), _ = cities.most_common(1)[0]
    return RouteArea(city=city, state=state)
