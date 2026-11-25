from pydantic import BaseModel, Field


class Point(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class RoadPathRequest(BaseModel):
    """Points in driving order (the driver's position first, if known)."""

    points: list[Point] = Field(min_length=2, max_length=300)


class RoadPathResponse(BaseModel):
    provider: str
    # Road geometry as [lat, lng] pairs, ready for the map.
    path: list[tuple[float, float]]
    distance_m: int
    duration_s: int
    # Per stop-to-stop leg, in the same order as the input points (len = points - 1).
    legs_distance_m: list[int]
    legs_duration_s: list[int]


class RoadMatrixRequest(BaseModel):
    """Stops to optimize (and the driver's position, if known). Order doesn't matter."""

    points: list[Point] = Field(min_length=2, max_length=300)
    # Road distances are fetched only between each point and this many nearest points.
    neighbors: int = Field(default=8, ge=1, le=20)


class MatrixPair(BaseModel):
    """Road distance between points[i] and points[j] (i < j); None when no road route exists."""

    i: int
    j: int
    distance_m: int | None
    duration_s: int | None


class RoadMatrixResponse(BaseModel):
    provider: str
    pairs: list[MatrixPair]
    # Pairs not found in the cache, i.e. what this call cost at Google.
    billed_elements: int
