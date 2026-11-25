"""Geocode cache: the same addresses come back every day on a route, so cache for 30 days.
Redis when available; if it is down, geocoding still works, just uncached."""

import json
import logging
from typing import Protocol

from redis.asyncio import Redis

from app.geocoding.models import GeocodeResult

log = logging.getLogger(__name__)
TTL_SECONDS = 30 * 24 * 3600


def _load(raw: str | bytes) -> GeocodeResult:
    # Cached results are stored without the request-specific id.
    return GeocodeResult.model_validate({**json.loads(raw), "id": ""})


class GeocodeCache(Protocol):
    async def get(self, key: str) -> GeocodeResult | None: ...
    async def set(self, key: str, result: GeocodeResult) -> None: ...


class RedisGeocodeCache:
    def __init__(self, client: Redis) -> None:
        self._redis = client

    async def get(self, key: str) -> GeocodeResult | None:
        try:
            raw = await self._redis.get(key)
        except Exception:  # cache is best-effort
            log.warning("geocode cache read failed", exc_info=True)
            return None
        return _load(raw) if raw else None

    async def set(self, key: str, result: GeocodeResult) -> None:
        try:
            await self._redis.set(key, result.model_dump_json(exclude={"id", "cached"}), ex=TTL_SECONDS)
        except Exception:  # cache is best-effort
            log.warning("geocode cache write failed", exc_info=True)


class MemoryGeocodeCache:
    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    async def get(self, key: str) -> GeocodeResult | None:
        raw = self.store.get(key)
        return _load(raw) if raw else None

    async def set(self, key: str, result: GeocodeResult) -> None:
        self.store[key] = result.model_dump_json(exclude={"id", "cached"})
