"""Geocoding providers. Each one turns one address + route area into a GeocodeResult."""

import math
import re
from typing import ClassVar, Protocol

import httpx

from app.geocoding.models import GeocodeResult, RouteArea

# GroundCloud truncates long addresses ("11316 N EAGLE LAKE B…"); OCR may read the "…" as dots.
_TRAILING_ELLIPSIS = re.compile(r"(…|\.+)\s*$")


def normalize_address(address: str) -> str:
    return _TRAILING_ELLIPSIS.sub("", " ".join(address.upper().split())).strip()


def is_truncated(address: str) -> bool:
    return bool(_TRAILING_ELLIPSIS.search(address.strip()))


class Geocoder(Protocol):
    name: str

    async def geocode(self, client: httpx.AsyncClient, item_id: str, address: str, area: RouteArea) -> GeocodeResult: ...


_STREET_LEVEL = {"street_address", "premise", "subpremise", "route", "intersection", "establishment", "point_of_interest"}


class GoogleGeocoder:
    """Google Geocoding API: rooftop points where available; best with a ZIP or city filter."""

    name = "google"
    URL = "https://maps.googleapis.com/maps/api/geocode/json"
    DESTINATIONS_URL = "https://geocode.googleapis.com/v4/geocode/destinations"
    _ACCURACY: ClassVar[dict[str, str]] = {"ROOFTOP": "rooftop", "RANGE_INTERPOLATED": "interpolated"}

    def __init__(self, api_key: str) -> None:
        self._key = api_key

    async def geocode(self, client: httpx.AsyncClient, item_id: str, address: str, area: RouteArea) -> GeocodeResult:
        components = ["country:US"]
        if area.zip:
            components.append(f"postal_code:{area.zip}")
        elif area.city and area.state:
            components += [f"locality:{area.city}", f"administrative_area:{area.state}"]
        params = {"address": normalize_address(address), "components": "|".join(components), "key": self._key}
        if area.lat is not None and area.lng is not None:
            # Bias (not a filter) towards ~10 km around the driver.
            params["bounds"] = f"{area.lat - 0.09},{area.lng - 0.12}|{area.lat + 0.09},{area.lng + 0.12}"

        response = await client.get(self.URL, params=params)
        response.raise_for_status()
        body = response.json()
        if body.get("status") == "ZERO_RESULTS" or not body.get("results"):
            return GeocodeResult(id=item_id, status="not_found", provider=self.name)
        if body.get("status") != "OK":
            return GeocodeResult(id=item_id, status="error", provider=self.name)

        best = body["results"][0]
        # A match that only resolves the ZIP or city (e.g. a truncated street) would drop a
        # pin in the middle of the area: treat it as not found so the driver fixes the address.
        if not _STREET_LEVEL & set(best.get("types", [])):
            return GeocodeResult(id=item_id, status="not_found", provider=self.name)
        geometry = best["geometry"]
        accuracy = self._ACCURACY.get(geometry.get("location_type", ""), "approximate")
        parts = {t: c for c in best.get("address_components", []) for t in c.get("types", [])}
        trusted = accuracy != "approximate" and not best.get("partial_match") and not is_truncated(address)
        lat, lng = geometry["location"]["lat"], geometry["location"]["lng"]
        entry = await self._entry_point(client, best.get("formatted_address"), lat, lng)
        return GeocodeResult(
            id=item_id,
            status="ok" if trusted else "review",
            lat=lat,
            lng=lng,
            accuracy=accuracy,
            formatted=best.get("formatted_address"),
            entry_lat=entry[0] if entry else None,
            entry_lng=entry[1] if entry else None,
            city=parts.get("locality", {}).get("long_name"),
            state=parts.get("administrative_area_level_1", {}).get("short_name"),
            zip=parts.get("postal_code", {}).get("long_name"),
            provider=self.name,
        )


    async def _entry_point(
        self, client: httpx.AsyncClient, formatted: str | None, lat: float, lng: float
    ) -> tuple[float, float] | None:
        """Where a car stops for this address: the Geocoding v4 navigation point for driving
        (v3's navigation_points was retired). Best-effort: without it the stop has no entry
        point and no driveway check, but it is still on the map."""
        if not formatted:
            return None
        try:
            response = await client.post(
                self.DESTINATIONS_URL,
                json={"addressQuery": {"addressQuery": formatted}, "travelModes": ["DRIVE"]},
                headers={"X-Goog-Api-Key": self._key, "X-Goog-FieldMask": "destinations.navigationPoints"},
            )
            response.raise_for_status()
            destinations = response.json().get("destinations") or []
        except (httpx.HTTPError, ValueError):
            return None
        return pick_entry_point(destinations, lat, lng)


# A navigation point farther than this from the house is some other place (wrong match).
MAX_ENTRY_DISTANCE_M = 600


def pick_entry_point(destinations: list[dict], lat: float, lng: float) -> tuple[float, float] | None:
    """The driving navigation point to use: a drop-off/pick-up one if there is one, else the
    first driving one (Google's own advice). Points that are implausibly far are ignored."""
    points = [p for d in destinations[:1] for p in d.get("navigationPoints") or []]
    drive = [p for p in points if "DRIVE" in (p.get("travelModes") or ["DRIVE"]) and p.get("location")]
    preferred = [p for p in drive if {"DROPOFF", "PICKUP"} & set(p.get("usages") or p.get("usage") or [])]
    for p in preferred + drive:
        loc = p["location"]
        point = (loc.get("latitude"), loc.get("longitude"))
        if None not in point and _meters(lat, lng, *point) <= MAX_ENTRY_DISTANCE_M:
            return point
    return None


def _meters(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6_371_008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


class CensusGeocoder:
    """US Census Bureau geocoder: free, no key, US only. Points are interpolated along the
    street's address range (not rooftop) and it needs the full street name."""

    name = "census"
    URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"

    async def geocode(self, client: httpx.AsyncClient, item_id: str, address: str, area: RouteArea) -> GeocodeResult:
        where = area.zip or (f"{area.city}, {area.state}" if area.city and area.state else "")
        if not where:
            # Census can't bias by coordinates; without a ZIP or city it would match nationwide.
            return GeocodeResult(id=item_id, status="error", provider=self.name)
        params = {
            "address": f"{normalize_address(address)}, {where}",
            "benchmark": "Public_AR_Current",
            "format": "json",
        }
        response = await client.get(self.URL, params=params)
        response.raise_for_status()
        matches = response.json().get("result", {}).get("addressMatches", [])
        if not matches:
            return GeocodeResult(id=item_id, status="not_found", provider=self.name)

        best = matches[0]
        parts = best.get("addressComponents", {})
        side = best.get("tigerLine", {}).get("side")
        trusted = len(matches) == 1 and not is_truncated(address)
        return GeocodeResult(
            id=item_id,
            status="ok" if trusted else "review",
            lat=best["coordinates"]["y"],
            lng=best["coordinates"]["x"],
            accuracy="interpolated",
            formatted=best.get("matchedAddress"),
            city=parts.get("city"),
            state=parts.get("state"),
            zip=parts.get("zip"),
            street_side=side if side in ("L", "R") else None,
            provider=self.name,
        )
