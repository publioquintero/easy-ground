"""Render a Manifest View-style PDF (+ expected parse) from a JSON route description.

    backend/.venv/bin/python scripts/make_manifest_from_json.py route.json out.pdf

route.json: {"title": str, "footer": str, "stops": [{"stopNumber", "stopType", "shelfId",
"packageCount", "customerName", "addressRaw", "addressLine2", "status"}]}. "status" is the
text shown in the status column ("" = pending; "Delivered …"/"Attempted …" = completed).
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_sample_manifest import write_pdf


def main() -> None:
    source, out = Path(sys.argv[1]), Path(sys.argv[2])
    route = json.loads(source.read_text())
    status = {s["stopNumber"]: s.get("status", "") for s in route["stops"]}
    stops = [
        {
            "stopNumber": s["stopNumber"],
            "stopType": s["stopType"],
            "shelfId": s["shelfId"],
            "packageCount": s["packageCount"],
            "customerName": s["customerName"],
            "addressRaw": s["addressRaw"],
            "addressLine2": s.get("addressLine2"),
            "completed": bool(status[s["stopNumber"]]),
        }
        for s in route["stops"]
    ]
    write_pdf(stops, out, title=route["title"], status=lambda s: status[s["stopNumber"]], footer_text=route["footer"])
    out.with_suffix(".expected.json").write_text(json.dumps({"stops": stops}, indent=2) + "\n")
    print(f"wrote {out} ({len(stops)} stops)")


if __name__ == "__main__":
    main()
