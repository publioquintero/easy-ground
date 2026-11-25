"""Connectivity checks for the backing services (Postgres, Redis, object storage)."""

import asyncio
from typing import Literal

import asyncpg
from redis.asyncio import Redis

from app.config import Settings
from app.storage import s3_client

Status = Literal["up", "down"]
TIMEOUT_S = 1.5


async def check_postgres(settings: Settings) -> Status:
    try:
        conn = await asyncpg.connect(settings.database_url, timeout=TIMEOUT_S)
        try:
            await conn.fetchval("SELECT 1")
        finally:
            await conn.close()
        return "up"
    except Exception:  # noqa: BLE001 — any failure means the service is down
        return "down"


async def check_redis(settings: Settings) -> Status:
    client = Redis.from_url(settings.redis_url, socket_connect_timeout=TIMEOUT_S, socket_timeout=TIMEOUT_S)
    try:
        await client.ping()
        return "up"
    except Exception:  # noqa: BLE001 — any failure means the service is down
        return "down"
    finally:
        await client.aclose()


def _check_storage_sync(settings: Settings) -> Status:
    try:
        s3_client(settings, timeout_s=TIMEOUT_S).list_buckets()
        return "up"
    except Exception:  # noqa: BLE001 — any failure means the service is down
        return "down"


async def check_all(settings: Settings) -> dict[str, Status]:
    pg, rd, st = await asyncio.gather(
        check_postgres(settings),
        check_redis(settings),
        asyncio.to_thread(_check_storage_sync, settings),
    )
    return {"postgres": pg, "redis": rd, "storage": st}
