"""Demo manifest for Eagle Mountain, Utah: 15 PUBLIC places (city buildings, schools,
parks, stores) with invented customer names, in GroundCloud's Manifest View layout.

Addresses were checked with the Google Geocoding API (Nov 2026). Stop numbers are shuffled
so route optimization has something to improve, and a few rows carry real-capture quirks.

Usage (from repo root):
    backend/.venv/bin/python scripts/make_eagle_mountain_manifest.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_sample_manifest import OUT_DIR, write_pdf

NAME = "manifest_eagle_mountain"
ROUTE_DATE = "11/25/2026"

# (#, D/P, SID, Pkgs, Name, Address, Address 2, status)   — place in the comment
ROWS = [
    (1, "D", "7101", 1, "ANA ALDEN", "1650 E STAGECOACH RUN", None, "Delivered 11/25 @ 09:05"),  # City Hall & Library
    (2, "D", "7101", 2, "BRIAN CORVIN", "9399 N SPRING RUN P…", None, None),  # Walmart (truncated by GroundCloud)
    (3, "D", "7114", 1, "CARLA ESPARZA", "1632 E HERITAGE DR", None, None),  # Senior Center
    (4, "D", "7114", 3, "DEV FINLEY", "3435 E STONEBRIDGE LN", None, None),  # Rockwell Charter High
    (5, "D", "7127", 1, "ELENA GARROWAY", "2565 N PONY EXPRESS PKWY", None, None),  # Public Works
    (6, "D", "7127", 2, "FRANK HOLLOWAY", "7862 N TINAMOUS RD", None, None),  # Nolan Park
    (7, "P", "7140", 1, "NORTHWIND SUPPLY LLC", "4045 E PONY EXPRESS PKWY", None, None),  # Ridley's (pickup)
    (8, "D", "7140", 1, "GINA IVERSEN", "1389 E AVIATOR AVE", "RM 104", None),  # Cedar Valley High
    (9, "D", "7153", 5, "HUGO JUAREZ", "3450 E GOLDEN EAGLE RD", None, None),  # Bike park
    (10, "D", "7153", 1, "IRIS KESTREL", "3726 N PONY EXPRESS PKWY", None, "Attempted 11/25 @ 09:41"),  # Fire station
    (11, "D", "7166", 2, "JAMAL LINDQVIST", "1557 E EAGLE MOUNTAIN BLVD", "SUITE 100", None),  # Macey's
    (12, "D", "7166", 1, "KIRA MORROW", "7082 N SEEDLING DR", None, None),  # Brookhaven Elementary
    (13, "D", "7179", 1, "LEO NAKAMURA", "2546 E PONY EXPRESS PKWY", None, None),  # Hidden Hollow Elementary
    (14, "D", "7179", 2, "MAYA OYELARAN", "3985 E SMITH RANCH RD", None, None),  # Pony Express Elementary
    (15, "D", "7192", 1, "NOAH PRESCOTT", "4475 N HERITAGE DR", None, None),  # Eagle Valley Elementary
]


def main() -> None:
    stops = [
        {
            "stopNumber": n,
            "stopType": "pickup" if dp == "P" else "delivery",
            "shelfId": sid,
            "packageCount": pkgs,
            "customerName": name,
            "addressRaw": address,
            "addressLine2": line2,
            "completed": status is not None,
        }
        for n, dp, sid, pkgs, name, address, line2, status in ROWS
    ]
    statuses = {n: status or "" for n, *_, status in ROWS}
    write_pdf(
        stops,
        OUT_DIR / f"{NAME}.pdf",
        title=f"Manifest - Route 415 - Eagle Mountain, UT - {ROUTE_DATE}",
        status=lambda s: statuses[s["stopNumber"]],
        footer_text="SAMPLE - public places in Eagle Mountain, UT; customer names are invented",
    )
    (OUT_DIR / f"{NAME}.expected.json").write_text(json.dumps({"routeDate": "2026-11-25", "stops": stops}, indent=2) + "\n")
    print(f"wrote {OUT_DIR / NAME}.pdf ({len(stops)} stops)")


if __name__ == "__main__":
    main()
