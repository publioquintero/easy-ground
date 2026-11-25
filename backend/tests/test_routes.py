import json
from itertools import pairwise

import httpx
import pytest

from app.routing.google_routes import RoutesError, chunks, decode_polyline, road_path
from app.routing.models import Point


def test_decode_polyline_matches_googles_reference_example():
    # Example from Google's "Encoded Polyline Algorithm Format" docs.
    assert decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@") == [(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)]


def test_chunks_share_boundaries_and_stay_within_ten_intermediates():
    points = [Point(lat=i, lng=0) for i in range(30)]
    parts = chunks(points)
    assert all(len(c) <= 12 for c in parts)
    assert [c[0].lat for c in parts] == [0, 11, 22]
    assert all(a[-1] == b[0] for a, b in pairwise(parts))
    assert parts[-1][-1].lat == 29
    assert chunks(points[:2]) == [points[:2]]


@pytest.mark.anyio
async def test_road_path_stitches_chunks_and_sums_legs():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        calls.append(body)
        data = json.loads(body)
        stops = [data["origin"], *data["intermediates"], data["destination"]]
        legs = len(stops) - 1
        return httpx.Response(200, json={"routes": [{
            "polyline": {"encodedPolyline": "_p~iF~ps|U_ulLnnqC"},
            "legs": [{"distanceMeters": 100, "duration": "60s"}] * legs,
        }]})

    points = [Point(lat=38.5 + i / 1000, lng=-120.2) for i in range(14)]
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        out = await road_path(client, "k", points)
    assert len(calls) == 2  # 12 + 3 points (sharing the boundary)
    assert out.legs_distance_m == [100] * 13
    assert (out.distance_m, out.duration_s) == (1300, 780)
    assert out.path[0] == (38.5, -120.2)


@pytest.mark.anyio
async def test_road_path_errors_are_reported():
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(403, text="denied"))) as client:
        with pytest.raises(RoutesError):
            await road_path(client, "k", [Point(lat=1, lng=1), Point(lat=2, lng=2)])
