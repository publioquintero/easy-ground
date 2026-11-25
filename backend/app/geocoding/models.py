from typing import Literal

from pydantic import BaseModel, Field, model_validator

Accuracy = Literal["rooftop", "interpolated", "approximate"]
# ok: trustworthy point. review: found, but approximate or a partial/autocompleted match.
GeocodeStatus = Literal["ok", "review", "not_found", "error"]


class RouteArea(BaseModel):
    """Where the route is. GroundCloud's manifest has no city/ZIP, so the driver sets it once."""

    zip: str | None = Field(default=None, pattern=r"^\d{5}$")
    city: str | None = Field(default=None, max_length=80)
    state: str | None = Field(default=None, pattern=r"^[A-Za-z]{2}$")
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)

    @model_validator(mode="after")
    def _needs_something(self) -> "RouteArea":
        if not (self.zip or (self.city and self.state) or (self.lat is not None and self.lng is not None)):
            raise ValueError("Set a ZIP, a city and state, or a location")
        return self

    def cache_key(self) -> str:
        if self.zip:
            return f"zip:{self.zip}"
        if self.city and self.state:
            return f"city:{self.city.upper()},{self.state.upper()}"
        return f"ll:{self.lat:.2f},{self.lng:.2f}"


class AddressIn(BaseModel):
    id: str = Field(max_length=40)
    address: str = Field(min_length=1, max_length=200)
    # Known ZIP for this address (from a package label). Overrides the route area for it.
    zip: str | None = Field(default=None, pattern=r"^\d{5}$")


class GeocodeRequest(BaseModel):
    area: RouteArea
    addresses: list[AddressIn] = Field(min_length=1, max_length=300)


class GeocodeResult(BaseModel):
    id: str
    status: GeocodeStatus
    lat: float | None = None
    lng: float | None = None
    accuracy: Accuracy | None = None
    formatted: str | None = None
    city: str | None = None
    state: str | None = None
    zip: str | None = None
    # Census only: side of the street the address range is on, relative to the line's
    # direction ("L"/"R"). Input for the right-side routing in Phase 2.
    street_side: Literal["L", "R"] | None = None
    # Where a vehicle stops to reach the address (Google navigation point, on the road).
    # With the house point it gives the driveway length and which side of the street it is on.
    entry_lat: float | None = None
    entry_lng: float | None = None
    provider: str
    cached: bool = False


class GeocodeResponse(BaseModel):
    provider: str
    results: list[GeocodeResult]
