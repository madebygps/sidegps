"""FastAPI backend for NYC MTA transit app."""

import math
import os
import time
from contextlib import asynccontextmanager

import aiosqlite
import httpx
from fastapi import FastAPI, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from google.transit import gtfs_realtime_pb2

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "gtfs.db")

# Map route_id -> GTFS-RT feed URL
ROUTE_TO_FEED: dict[str, str] = {}
FEED_URLS = {
    "ace": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
    "bdfm": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
    "g": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",
    "jz": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
    "nqrw": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
    "l": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l",
    "1234567": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
    "sir": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si",
}
_ROUTE_FEED_MAP = {
    "A": "ace", "C": "ace", "E": "ace",
    "B": "bdfm", "D": "bdfm", "F": "bdfm", "M": "bdfm",
    "G": "g",
    "J": "jz", "Z": "jz",
    "N": "nqrw", "Q": "nqrw", "R": "nqrw", "W": "nqrw",
    "L": "l",
    "1": "1234567", "2": "1234567", "3": "1234567",
    "4": "1234567", "5": "1234567", "6": "1234567", "7": "1234567",
    "GS": "1234567", "SS": "sir", "SI": "sir", "SIR": "sir",
    "H": "1234567", "FS": "1234567",
}
for route, feed_key in _ROUTE_FEED_MAP.items():
    ROUTE_TO_FEED[route] = FEED_URLS[feed_key]

ALERTS_URL = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts"

# Simple in-memory cache: url -> (timestamp, data)
_cache: dict[str, tuple[float, bytes]] = {}
CACHE_TTL = 30  # seconds

db: aiosqlite.Connection | None = None
http_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global db, http_client
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    http_client = httpx.AsyncClient(timeout=10.0)
    yield
    await db.close()
    await http_client.aclose()


app = FastAPI(title="NYC MTA Transit", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return distance in meters between two lat/lon points."""
    R = 6_371_000  # Earth radius in meters
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


async def fetch_feed(url: str) -> bytes:
    """Fetch a GTFS-RT feed with 30-second caching."""
    now = time.time()
    cached = _cache.get(url)
    if cached and now - cached[0] < CACHE_TTL:
        return cached[1]
    resp = await http_client.get(url)
    resp.raise_for_status()
    data = resp.content
    _cache[url] = (now, data)
    return data


async def get_routes_for_station(stop_id: str) -> list[dict]:
    """Return list of routes serving a parent station."""
    # Get child stop IDs (and the parent itself)
    async with db.execute(
        "SELECT stop_id FROM stops WHERE stop_id = ? OR parent_station = ?",
        (stop_id, stop_id),
    ) as cursor:
        child_ids = [row[0] for row in await cursor.fetchall()]

    if not child_ids:
        return []

    placeholders = ",".join("?" for _ in child_ids)
    query = f"""
        SELECT DISTINCT r.route_id, r.route_short_name, r.route_long_name, r.route_color
        FROM stop_times st
        JOIN trips t ON st.trip_id = t.trip_id
        JOIN routes r ON t.route_id = r.route_id
        WHERE st.stop_id IN ({placeholders})
    """
    async with db.execute(query, child_ids) as cursor:
        rows = await cursor.fetchall()

    return [
        {
            "route_id": row[0],
            "short_name": row[1],
            "long_name": row[2],
            "color": row[3],
        }
        for row in rows
    ]


async def _get_arrivals_for_station(
    stop_id: str, routes: list[dict] | None = None
) -> list[dict]:
    """Fetch real-time arrivals for a parent station. Reusable helper."""
    async with db.execute(
        "SELECT stop_id FROM stops WHERE stop_id = ? OR parent_station = ?",
        (stop_id, stop_id),
    ) as cursor:
        child_ids = set(row[0] for row in await cursor.fetchall())

    if not child_ids:
        return []

    if routes is None:
        routes = await get_routes_for_station(stop_id)

    feed_urls = set()
    for r in routes:
        url = ROUTE_TO_FEED.get(r["route_id"])
        if url:
            feed_urls.add(url)
    if not feed_urls:
        feed_urls = set(FEED_URLS.values())

    now = time.time()
    arrivals = []

    for url in feed_urls:
        try:
            data = await fetch_feed(url)
        except Exception:
            continue

        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(data)

        for entity in feed.entity:
            if not entity.HasField("trip_update"):
                continue
            trip = entity.trip_update
            route_id = trip.trip.route_id
            direction = (
                trip.trip.direction_id
                if trip.trip.HasField("direction_id")
                else None
            )

            for stu in trip.stop_time_update:
                if stu.stop_id not in child_ids:
                    continue
                arr_time = (
                    stu.arrival.time
                    if stu.HasField("arrival") and stu.arrival.time
                    else None
                )
                if arr_time is None or arr_time <= now:
                    continue

                inferred_dir = direction
                if inferred_dir is None:
                    if stu.stop_id.endswith("N"):
                        inferred_dir = 0
                    elif stu.stop_id.endswith("S"):
                        inferred_dir = 1

                arrivals.append(
                    {
                        "route_id": route_id,
                        "direction": inferred_dir,
                        "arrival_time": int(arr_time),
                        "minutes_away": round((arr_time - now) / 60, 1),
                    }
                )

    arrivals.sort(key=lambda a: a["arrival_time"])
    return arrivals


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/stations")
async def list_stations():
    """Return all parent stations with route info."""
    async with db.execute(
        "SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops "
        "WHERE parent_station IS NULL OR parent_station = ''"
    ) as cursor:
        rows = await cursor.fetchall()

    stations = []
    for row in rows:
        routes = await get_routes_for_station(row[0])
        stations.append(
            {
                "id": row[0],
                "name": row[1],
                "lat": row[2],
                "lon": row[3],
                "routes": routes,
            }
        )
    return stations


@app.get("/api/nearby")
async def nearby_stations(
    response: Response,
    lat: float = Query(...),
    lon: float = Query(...),
    limit: int = Query(5, ge=1, le=50),
):
    """Return nearest N parent stations by haversine distance, with arrivals."""
    response.headers["Cache-Control"] = "public, max-age=30"

    async with db.execute(
        "SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops "
        "WHERE (parent_station IS NULL OR parent_station = '') "
        "AND stop_lat IS NOT NULL AND stop_lon IS NOT NULL"
    ) as cursor:
        rows = await cursor.fetchall()

    scored = []
    for row in rows:
        dist = haversine(lat, lon, row[2], row[3])
        scored.append((dist, row))
    scored.sort(key=lambda x: x[0])

    results = []
    for dist, row in scored[:limit]:
        stop_id = row[0]
        routes = await get_routes_for_station(stop_id)
        arrivals = await _get_arrivals_for_station(stop_id, routes)
        results.append(
            {
                "id": stop_id,
                "name": row[1],
                "lat": row[2],
                "lon": row[3],
                "distance_m": round(dist, 1),
                "routes": routes,
                "arrivals": arrivals[:6],
            }
        )
    return results


@app.get("/api/arrivals/{stop_id}")
async def get_arrivals(stop_id: str, response: Response):
    """Fetch real-time arrivals for a station (parent or child)."""
    response.headers["Cache-Control"] = "public, max-age=30"
    arrivals = await _get_arrivals_for_station(stop_id)
    if not arrivals:
        return {"arrivals": [], "station_id": stop_id}
    return {"arrivals": arrivals, "station_id": stop_id}


@app.get("/api/alerts")
async def get_alerts(response: Response):
    """Fetch current MTA service alerts."""
    response.headers["Cache-Control"] = "public, max-age=30"

    try:
        data = await fetch_feed(ALERTS_URL)
    except Exception as e:
        return {"alerts": [], "error": str(e)}

    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(data)

    alerts = []
    for entity in feed.entity:
        if not entity.HasField("alert"):
            continue
        alert = entity.alert

        header = ""
        if alert.header_text and alert.header_text.translation:
            header = alert.header_text.translation[0].text

        description = ""
        if alert.description_text and alert.description_text.translation:
            description = alert.description_text.translation[0].text

        affected_routes = []
        for ie in alert.informed_entity:
            if ie.route_id:
                affected_routes.append(ie.route_id)

        active_periods = []
        for ap in alert.active_period:
            active_periods.append(
                {
                    "start": ap.start if ap.start else None,
                    "end": ap.end if ap.end else None,
                }
            )

        alerts.append(
            {
                "alert_id": entity.id,
                "header_text": header,
                "description_text": description,
                "affected_routes": list(set(affected_routes)),
                "active_period": active_periods,
            }
        )

    return {"alerts": alerts}


# Serve frontend static files (mount AFTER API routes)
from fastapi.staticfiles import StaticFiles  # noqa: E402

_frontend_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")
if os.path.isdir(_frontend_dir):
    app.mount("/", StaticFiles(directory=_frontend_dir, html=True), name="frontend")
