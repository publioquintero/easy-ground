import httpx
import pytest
from fastapi.testclient import TestClient

from app.geocoding.cache import MemoryGeocodeCache
from app.geocoding.models import GeocodeRequest, RouteArea
from app.geocoding.providers import (
    CensusGeocoder,
    GoogleGeocoder,
    normalize_address,
    pick_entry_point,
)
from app.geocoding.service import cache_key, geocode_batch
from app.main import app, get_geocode_cache, get_geocoder, get_http

AREA = RouteArea(zip="55000")


def census_reply(matches: list[dict]) -> dict:
    return {"result": {"addressMatches": matches}}


CENSUS_MATCH = {
    "coordinates": {"x": -93.1, "y": 45.1},
    "matchedAddress": "4820 OLD RANCH RD, SPRINGFIELD, MN, 55000",
    "addressComponents": {"city": "SPRINGFIELD", "state": "MN", "zip": "55000"},
    "tigerLine": {"side": "R"},
}


def mock_client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_normalize_strips_ocr_ellipsis_and_spacing():
    assert normalize_address(" 11316  n eagle lake b… ") == "11316 N EAGLE LAKE B"
    assert normalize_address("11701 CENTRAL PARK.") == "11701 CENTRAL PARK"


@pytest.mark.anyio
async def test_census_ok_with_street_side():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["address"] = request.url.params["address"]
        return httpx.Response(200, json=census_reply([CENSUS_MATCH]))

    async with mock_client(handler) as client:
        r = await CensusGeocoder().geocode(client, "4", "4820 old ranch rd", AREA)
    assert seen["address"] == "4820 OLD RANCH RD, 55000"
    assert (r.status, r.lat, r.lng, r.accuracy, r.street_side, r.zip) == ("ok", 45.1, -93.1, "interpolated", "R", "55000")


@pytest.mark.anyio
async def test_census_truncated_or_ambiguous_needs_review_and_misses_are_not_found():
    async with mock_client(lambda _: httpx.Response(200, json=census_reply([CENSUS_MATCH]))) as client:
        assert (await CensusGeocoder().geocode(client, "1", "4820 OLD RANCH R…", AREA)).status == "review"
    async with mock_client(lambda _: httpx.Response(200, json=census_reply([CENSUS_MATCH, CENSUS_MATCH]))) as client:
        assert (await CensusGeocoder().geocode(client, "1", "4820 OLD RANCH RD", AREA)).status == "review"
    async with mock_client(lambda _: httpx.Response(200, json=census_reply([]))) as client:
        assert (await CensusGeocoder().geocode(client, "1", "1 NOWHERE", AREA)).status == "not_found"


@pytest.mark.anyio
async def test_google_filters_by_zip_and_maps_accuracy():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.url.params)
        return httpx.Response(200, json={
            "status": "OK",
            "results": [{
                "types": ["street_address"],
                "formatted_address": "4820 Old Ranch Rd, Springfield, MN 55000, USA",
                "geometry": {"location": {"lat": 45.2, "lng": -93.2}, "location_type": "ROOFTOP"},
                "address_components": [
                    {"long_name": "Springfield", "types": ["locality"]},
                    {"short_name": "MN", "long_name": "Minnesota", "types": ["administrative_area_level_1"]},
                    {"long_name": "55000", "types": ["postal_code"]},
                ],
            }],
        })

    async with mock_client(handler) as client:
        r = await GoogleGeocoder("k").geocode(client, "4", "4820 OLD RANCH RD", AREA)
    assert seen["components"] == "country:US|postal_code:55000"
    assert (r.status, r.accuracy, r.city, r.state, r.zip) == ("ok", "rooftop", "Springfield", "MN", "55000")


@pytest.mark.anyio
async def test_google_partial_match_needs_review():
    body = {"status": "OK", "results": [{"types": ["street_address"], "partial_match": True, "geometry": {
        "location": {"lat": 1, "lng": 2}, "location_type": "ROOFTOP"}}]}
    async with mock_client(lambda _: httpx.Response(200, json=body)) as client:
        assert (await GoogleGeocoder("k").geocode(client, "1", "1 MAIN", AREA)).status == "review"


@pytest.mark.anyio
async def test_batch_uses_cache_and_survives_provider_errors():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.params["address"])
        if "BROKEN" in request.url.params["address"]:
            return httpx.Response(503)
        return httpx.Response(200, json=census_reply([CENSUS_MATCH]))

    cache = MemoryGeocodeCache()
    req = GeocodeRequest(area=AREA, addresses=[{"id": "1", "address": "4820 OLD RANCH RD"}, {"id": "2", "address": "9 BROKEN ST"}])
    async with mock_client(handler) as client:
        first = await geocode_batch(req, CensusGeocoder(), cache, client)
        second = await geocode_batch(req, CensusGeocoder(), cache, client)

    assert [r.status for r in first.results] == ["ok", "error"]
    assert [(r.status, r.cached) for r in second.results] == [("ok", True), ("error", False)]
    assert len(calls) == 3  # the good address was fetched once; errors are never cached
    assert all("OLD RANCH" not in k for k in cache.store)  # keys don't expose addresses


def test_cache_key_depends_on_area():
    assert cache_key("census", "1 MAIN", "zip:55000") != cache_key("census", "1 MAIN", "zip:55001")


def test_endpoint_validates_area_and_returns_results():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=census_reply([CENSUS_MATCH]))

    app.dependency_overrides[get_geocoder] = CensusGeocoder
    app.dependency_overrides[get_geocode_cache] = MemoryGeocodeCache
    app.dependency_overrides[get_http] = lambda: mock_client(handler)
    try:
        with TestClient(app) as client:
            bad = client.post("/api/geocode", json={"area": {}, "addresses": [{"id": "1", "address": "x"}]})
            assert bad.status_code == 422
            ok = client.post("/api/geocode", json=
                {"area": {"zip": "55000"}, "addresses": [{"id": "4", "address": "4820 OLD RANCH RD"}]})
            assert ok.status_code == 200, ok.text
            assert ok.json()["results"][0] | {"lat": 45.1, "status": "ok", "id": "4"} == ok.json()["results"][0]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_batch_retries_misses_outside_the_zip_in_the_routes_city():
    other_zip = {**CENSUS_MATCH, "addressComponents": {"city": "SPRINGFIELD", "state": "MN", "zip": "55001"}}

    def handler(request: httpx.Request) -> httpx.Response:
        address = request.url.params["address"]
        if address == "700 ELM ST, 55000":
            return httpx.Response(200, json=census_reply([]))  # different ZIP than the area
        if address == "700 ELM ST, SPRINGFIELD, MN":
            return httpx.Response(200, json=census_reply([other_zip]))
        if address.startswith("4820 OLD RANCH RD"):
            return httpx.Response(200, json=census_reply([CENSUS_MATCH]))
        return httpx.Response(200, json=census_reply([]))

    req = GeocodeRequest(area=AREA, addresses=[
        {"id": "1", "address": "4820 OLD RANCH RD"},
        {"id": "2", "address": "700 ELM ST"},
        {"id": "3", "address": "1 NOWHERE"},
    ])
    async with mock_client(handler) as client:
        out = await geocode_batch(req, CensusGeocoder(), MemoryGeocodeCache(), client)
    assert [(r.status, r.zip) for r in out.results] == [("ok", "55000"), ("ok", "55001"), ("not_found", None)]


@pytest.mark.anyio
async def test_google_zip_or_city_only_match_is_not_found():
    body = {"status": "OK", "results": [{"types": ["postal_code"], "partial_match": True, "geometry": {
        "location": {"lat": 1, "lng": 2}, "location_type": "APPROXIMATE"}}]}
    async with mock_client(lambda _: httpx.Response(200, json=body)) as client:
        assert (await GoogleGeocoder("k").geocode(client, "1", "1600 PENNSYLVANIA A…", AREA)).status == "not_found"


@pytest.mark.anyio
async def test_address_with_its_own_zip_ignores_the_route_area():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.params["address"])
        return httpx.Response(200, json=census_reply([CENSUS_MATCH]))

    req = GeocodeRequest(area=AREA, addresses=[
        {"id": "1", "address": "4820 OLD RANCH RD"},
        {"id": "2", "address": "52 OAK ST", "zip": "84043"},
    ])
    async with mock_client(handler) as client:
        await geocode_batch(req, CensusGeocoder(), MemoryGeocodeCache(), client)
    assert seen == ["4820 OLD RANCH RD, 55000", "52 OAK ST, 84043"]


GOOGLE_V3_OK = {
    "status": "OK",
    "results": [{
        "types": ["street_address"],
        "formatted_address": "4820 Old Ranch Rd, Springfield, MN 55000, USA",
        "geometry": {"location": {"lat": 45.0, "lng": -93.0}, "location_type": "ROOFTOP"},
    }],
}


@pytest.mark.anyio
async def test_google_adds_the_driving_entry_point_from_geocoding_v4():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json=GOOGLE_V3_OK)
        seen["mask"] = request.headers["X-Goog-FieldMask"]
        seen["key"] = request.headers["X-Goog-Api-Key"]
        return httpx.Response(200, json={"destinations": [{"navigationPoints": [
            {"location": {"latitude": 45.0, "longitude": -93.002}, "travelModes": ["WALK"]},
            {"location": {"latitude": 45.0009, "longitude": -93.0}, "travelModes": ["DRIVE"], "usages": ["PARKING"]},
            {"location": {"latitude": 45.001, "longitude": -93.0}, "travelModes": ["DRIVE"], "usages": ["DROPOFF"]},
        ]}]})

    async with mock_client(handler) as client:
        r = await GoogleGeocoder("k").geocode(client, "4", "4820 OLD RANCH RD", AREA)
    assert seen == {"mask": "destinations.navigationPoints", "key": "k"}
    assert (r.status, r.lat, r.entry_lat, r.entry_lng) == ("ok", 45.0, 45.001, -93.0)


@pytest.mark.anyio
async def test_google_without_entry_point_still_geocodes():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json=GOOGLE_V3_OK)
        return httpx.Response(403, json={"error": {"message": "API not enabled"}})

    async with mock_client(handler) as client:
        r = await GoogleGeocoder("k").geocode(client, "4", "4820 OLD RANCH RD", AREA)
    assert (r.status, r.lat, r.entry_lat) == ("ok", 45.0, None)


def test_entry_point_far_from_the_house_is_ignored():
    far = [{"navigationPoints": [{"location": {"latitude": 45.02, "longitude": -93.0}, "travelModes": ["DRIVE"]}]}]
    assert pick_entry_point(far, 45.0, -93.0) is None
