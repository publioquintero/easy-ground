import json

import httpx
import pytest

from app.routing.google_matrix import MatrixError, neighbor_pairs, road_matrix
from app.routing.models import Point

GAPS = [0, 1, 3, 6, 10, 15]  # growing gaps: no ties between nearest neighbors


def line(n: int) -> list[Point]:
    return [Point(lat=38.9 + GAPS[i] / 1000, lng=-77.0) for i in range(n)]


def test_neighbor_pairs_link_nearest_points_once():
    pairs = neighbor_pairs(line(5), 1)
    assert pairs == [(0, 1), (1, 2), (2, 3), (3, 4)]
    assert all(i < j for i, j in neighbor_pairs(line(6), 3))
    assert len(neighbor_pairs(line(4), 10)) == 6  # every pair, no more


class FakeRedis:
    def __init__(self):
        self.data: dict[str, str] = {}

    async def mget(self, keys):
        return [self.data.get(k) for k in keys]

    def pipeline(self, transaction=False):
        store = self.data

        class Pipe:
            async def __aenter__(self):
                self.ops = []
                return self

            async def __aexit__(self, *_):
                return False

            def set(self, key, value, ex=None):
                self.ops.append((key, value))

            async def execute(self):
                store.update(self.ops)

        return Pipe()


def matrix_handler(calls: list[dict], unreachable: set[int] = frozenset()):
    def handler(request: httpx.Request) -> httpx.Response:
        data = json.loads(request.read())
        calls.append(data)
        elements = []
        for j, _ in enumerate(data["destinations"]):
            element = {"originIndex": 0, "destinationIndex": j, "status": {}}
            if j in unreachable:
                element["condition"] = "ROUTE_NOT_FOUND"
            else:
                element |= {"condition": "ROUTE_EXISTS", "distanceMeters": 100 * (j + 1), "duration": "30s"}
            if j == 0:
                del element["destinationIndex"]  # proto3 JSON omits zero values
            elements.append(element)
        return httpx.Response(200, json=elements)

    return handler


@pytest.mark.anyio
async def test_road_matrix_requests_only_needed_pairs_and_caches_them():
    calls: list[dict] = []
    redis = FakeRedis()
    points = line(4)
    async with httpx.AsyncClient(transport=httpx.MockTransport(matrix_handler(calls))) as client:
        out = await road_matrix(client, "k", points, 1, redis)
        assert [(p.i, p.j) for p in out.pairs] == [(0, 1), (1, 2), (2, 3)]
        assert all(len(c["origins"]) == 1 for c in calls)
        assert sum(len(c["destinations"]) for c in calls) == 3 == out.billed_elements
        assert all(p.distance_m == 100 and p.duration_s == 30 for p in out.pairs)

        again = await road_matrix(client, "k", points, 1, redis)
    assert len(calls) == 3  # second call served from the cache
    assert again.billed_elements == 0
    assert again.pairs == out.pairs


@pytest.mark.anyio
async def test_road_matrix_marks_pairs_without_a_road():
    calls: list[dict] = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(matrix_handler(calls, unreachable={0}))) as client:
        out = await road_matrix(client, "k", line(2), 1)
    assert (out.pairs[0].distance_m, out.pairs[0].duration_s) == (None, None)


@pytest.mark.anyio
async def test_road_matrix_errors_are_reported():
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(403, text="denied"))) as client:
        with pytest.raises(MatrixError):
            await road_matrix(client, "k", line(2), 1)
