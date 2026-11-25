"""Generate a SYNTHETIC manifest PDF + its expected parse, for parser tests.

All names and house numbers are invented. The layout mimics the columns seen in
GroundCloud's Manifest View (#, D/P, SID, Pkgs, Name, Address, Address 2, status);
the real "print" output format is still unconfirmed (PLAN.md D2), so treat this as a
best guess until a real PDF is available.

Usage (from repo root):
    backend/.venv/bin/python scripts/make_sample_manifest.py
"""

import json
import random
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

OUT_DIR = Path(__file__).resolve().parent.parent / "packages" / "core" / "fixtures"
NAME = "manifest_synthetic_01"
ROUTE_DATE = "11/24/2026"
STOP_COUNT = 42

FIRST = ["ANA", "BRIAN", "CARLA", "DEV", "ELENA", "FRANK", "GINA", "HUGO", "IRIS", "JAMAL",
         "KIRA", "LEO", "MAYA", "NOAH", "OLGA", "PAUL", "QUINN", "ROSA", "SAM", "TINA"]
LAST = ["ALDEN", "BRANDT", "CORVIN", "DELACRUZ", "ESPARZA", "FINLEY", "GARROWAY", "HOLLOWAY",
        "IVERSEN", "JUAREZ", "KESTREL", "LINDQVIST", "MORROW", "NAKAMURA", "OYELARAN"]
BUSINESSES = ["NORTHWIND SUPPLY LLC", "BLUE HERON DENTAL", "ACME PARTS CO"]
STREETS = ["HOLLY LN N", "69TH AVE N", "EAGLE LAKE BLVD N", "70TH PL N", "80TH AVE N",
           "CENTRAL PARK BLVD N", "OAKVIEW DR N", "MAIN ST N", "KIRKWOOD LN N", "82ND AVE N",
           "NIAGARA LN N", "ORCHID LN N", "WEAVER LAKE RD N", "ELM CREEK BLVD N"]


def build_stops() -> list[dict]:
    rng = random.Random(20261124)
    stops = []
    sid = 6000
    for n in range(1, STOP_COUNT + 1):
        # SIDs advance in steps but repeat sometimes (SID is a shelf, not unique).
        if n not in (7, 20, 21):
            sid += rng.choice([7, 13, 20, 33])
        name = rng.choice(BUSINESSES) if n in (1, 18, 33) else f"{rng.choice(FIRST)} {rng.choice(LAST)}"
        line2 = None
        if n in (6, 7, 12, 27):
            line2 = rng.choice(["APT 219", "APT 1425", "# 114", "UNIT 3B"])
        if n == 14:
            line2 = "MS A220"
        stops.append({
            "stopNumber": n,
            "stopType": "pickup" if n in (18, 33) else "delivery",
            "shelfId": str(sid),
            "packageCount": rng.choice([1, 1, 1, 1, 2, 2, 3, 5]),
            "customerName": name,
            "addressRaw": f"{rng.randint(1000, 12999)} {rng.choice(STREETS)}",
            "addressLine2": line2,
            "completed": n in (1, 2, 3, 5),
        })
    return stops


def status_text(stop: dict) -> str:
    n = stop["stopNumber"]
    if n == 5:
        return "Attempted 11/24 @ 09:34"
    if stop["completed"]:
        return f"Delivered 11/24 @ 09:{10 + n * 3:02d}"
    return ""


def footer(text: str):
    def on_page(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.grey)
        canvas.drawString(0.5 * inch, 0.35 * inch, text)
        canvas.drawRightString(10.5 * inch, 0.35 * inch, f"Page {doc.page}")
        canvas.restoreState()

    return on_page


def write_pdf(
    stops: list[dict],
    path: Path,
    title: str = f"Manifest - Route 812 - {ROUTE_DATE}",
    status=status_text,
    footer_text: str = "SYNTHETIC SAMPLE - invented data for parser tests",
) -> None:
    styles = getSampleStyleSheet()
    doc = SimpleDocTemplate(str(path), pagesize=landscape(letter),
                            leftMargin=0.5 * inch, rightMargin=0.5 * inch,
                            topMargin=0.5 * inch, bottomMargin=0.6 * inch,
                            title="Manifest (synthetic sample)")
    header = ["#", "D/P", "SID", "Pkgs", "Name", "Address", "Address 2", "Status"]
    rows = [header] + [
        [str(s["stopNumber"]), "P" if s["stopType"] == "pickup" else "D", s["shelfId"],
         str(s["packageCount"]), s["customerName"], s["addressRaw"], s["addressLine2"] or "",
         status(s)]
        for s in stops
    ]
    table = Table(rows, repeatRows=1,
                  colWidths=[0.4 * inch, 0.45 * inch, 0.6 * inch, 0.5 * inch, 2.3 * inch,
                             2.6 * inch, 1.0 * inch, 2.15 * inch])
    table.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
        ("FONT", (0, 1), (-1, -1), "Helvetica", 9),
        ("LINEBELOW", (0, 0), (-1, 0), 0.8, colors.black),
        ("LINEBELOW", (0, 1), (-1, -1), 0.25, colors.lightgrey),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
    ]))
    story = [
        Paragraph(title, styles["Heading2"]),
        Paragraph(f"{len(stops)} stops - {sum(s['packageCount'] for s in stops)} packages", styles["Normal"]),
        Spacer(1, 8),
        table,
    ]
    on_page = footer(footer_text)
    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stops = build_stops()
    write_pdf(stops, OUT_DIR / f"{NAME}.pdf")
    expected = {"routeDate": "2026-11-24", "stops": stops}
    (OUT_DIR / f"{NAME}.expected.json").write_text(json.dumps(expected, indent=2) + "\n")
    print(f"wrote {OUT_DIR / NAME}.pdf and .expected.json ({len(stops)} stops)")


if __name__ == "__main__":
    main()
