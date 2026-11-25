import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from redis.asyncio import Redis

from app.config import Settings, get_settings
from app.geocoding.cache import GeocodeCache, RedisGeocodeCache
from app.geocoding.models import GeocodeRequest, GeocodeResponse
from app.geocoding.providers import CensusGeocoder, Geocoder, GoogleGeocoder
from app.geocoding.service import geocode_batch
from app.health import check_all
from app.routing.google_matrix import MatrixError, road_matrix
from app.routing.google_routes import RoutesError, road_path
from app.routing.models import (
    RoadMatrixRequest,
    RoadMatrixResponse,
    RoadPathRequest,
    RoadPathResponse,
)
from app.storage import ensure_bucket


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    app.state.http = httpx.AsyncClient(timeout=10)
    app.state.redis = Redis.from_url(settings.redis_url, socket_connect_timeout=1, socket_timeout=1)
    await asyncio.to_thread(ensure_bucket, settings)
    try:
        yield
    finally:
        await app.state.http.aclose()
        await app.state.redis.aclose()


app = FastAPI(title="Easy Ground API", version="0.0.0", lifespan=lifespan)
api = APIRouter(prefix="/api")

SettingsDep = Annotated[Settings, Depends(get_settings)]


def get_geocoder(settings: SettingsDep) -> Geocoder:
    use_google = settings.geocoder == "google" or (settings.geocoder == "auto" and settings.google_maps_api_key)
    return GoogleGeocoder(settings.google_maps_api_key) if use_google else CensusGeocoder()


def get_geocode_cache(request: Request) -> GeocodeCache:
    return RedisGeocodeCache(request.app.state.redis)


def get_http(request: Request) -> httpx.AsyncClient:
    return request.app.state.http


@api.get("/health")
async def health(settings: SettingsDep) -> dict:
    return {"status": "ok", "services": await check_all(settings)}


@api.post("/geocode")
async def geocode(
    body: GeocodeRequest,
    geocoder: Annotated[Geocoder, Depends(get_geocoder)],
    cache: Annotated[GeocodeCache, Depends(get_geocode_cache)],
    http: Annotated[httpx.AsyncClient, Depends(get_http)],
) -> GeocodeResponse:
    return await geocode_batch(body, geocoder, cache, http)


@api.post("/routes/road-path")
async def route_road_path(
    body: RoadPathRequest,
    request: Request,
    settings: SettingsDep,
    http: Annotated[httpx.AsyncClient, Depends(get_http)],
) -> RoadPathResponse:
    """Road geometry + driving distance/time for points in order. Needs a Google key;
    without one the app keeps drawing straight lines."""
    if not settings.google_maps_api_key:
        raise HTTPException(status_code=501, detail="Road routing needs GOOGLE_MAPS_API_KEY")
    try:
        return await road_path(http, settings.google_maps_api_key, body.points, getattr(request.app.state, "redis", None))
    except RoutesError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail="Could not reach the routing service") from error


@api.post("/routes/matrix")
async def route_matrix(
    body: RoadMatrixRequest,
    request: Request,
    settings: SettingsDep,
    http: Annotated[httpx.AsyncClient, Depends(get_http)],
) -> RoadMatrixResponse:
    """Road distances between nearby points, for the optimizer. Needs a Google key; without
    one the app optimizes by straight-line distance."""
    if not settings.google_maps_api_key:
        raise HTTPException(status_code=501, detail="Road distances need GOOGLE_MAPS_API_KEY")
    try:
        return await road_matrix(
            http, settings.google_maps_api_key, body.points, body.neighbors, getattr(request.app.state, "redis", None)
        )
    except MatrixError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail="Could not reach the routing service") from error


app.include_router(api)
