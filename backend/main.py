"""FastAPI backend for NYC MTA transit app."""

import math
import os
import sys
import time
from contextlib import asynccontextmanager

import aiosqlite
import httpx
from fastapi import FastAPI, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from google.transit import gtfs_realtime_pb2

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "gtfs_lite.db")

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

# Citi Bike GBFS feeds (free, no key)
CITIBIKE_INFO_URL = "https://gbfs.citibikenyc.com/gbfs/en/station_information.json"
CITIBIKE_STATUS_URL = "https://gbfs.citibikenyc.com/gbfs/en/station_status.json"

# Simple in-memory cache: url -> (timestamp, data)
_cache: dict[str, tuple[float, bytes]] = {}
_json_cache: dict[str, tuple[float, dict]] = {}
CACHE_TTL = 30  # seconds

db: aiosqlite.Connection | None = None
http_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global db, http_client
    # Auto-build lite DB if missing
    if not os.path.exists(DB_PATH):
        import subprocess
        loader = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gtfs_loader.py")
        subprocess.run([sys.executable, loader, "--lite"], check=True)
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
    """Return list of routes serving a parent station (precomputed)."""
    result = await _get_routes_for_stations([stop_id])
    return result.get(stop_id, [])


async def _get_routes_for_stations(stop_ids: list[str]) -> dict[str, list[dict]]:
    """Return routes for multiple stations in a single query."""
    if not stop_ids:
        return {}
    placeholders = ",".join("?" for _ in stop_ids)
    async with db.execute(
        "SELECT station_id, route_id, route_short_name, route_long_name, route_color "
        f"FROM route_stops WHERE station_id IN ({placeholders})",
        stop_ids,
    ) as cursor:
        rows = await cursor.fetchall()

    route_map: dict[str, list[dict]] = {}
    for row in rows:
        route_map.setdefault(row[0], []).append(
            {
                "route_id": row[1],
                "short_name": row[2],
                "long_name": row[3],
                "color": row[4],
            }
        )
    return route_map


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

    station_ids = [row[0] for row in rows]
    route_map = await _get_routes_for_stations(station_ids)

    stations = []
    for row in rows:
        stations.append(
            {
                "id": row[0],
                "name": row[1],
                "lat": row[2],
                "lon": row[3],
                "routes": route_map.get(row[0], []),
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
    top_ids = [row[0] for _, row in scored[:limit]]
    route_map = await _get_routes_for_stations(top_ids)

    for dist, row in scored[:limit]:
        stop_id = row[0]
        routes = route_map.get(stop_id, [])
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


# ---------------------------------------------------------------------------
# Citi Bike (GBFS — free, real-time bike/dock availability)
# ---------------------------------------------------------------------------

async def _fetch_json_cached(url: str, ttl: int = 60) -> dict:
    """Fetch JSON with in-memory caching."""
    now = time.time()
    cached = _json_cache.get(url)
    if cached and now - cached[0] < ttl:
        return cached[1]
    resp = await http_client.get(url, timeout=10.0)
    resp.raise_for_status()
    data = resp.json()
    _json_cache[url] = (now, data)
    return data


@app.get("/api/citibike")
async def nearby_citibike(
    response: Response,
    lat: float = Query(...),
    lon: float = Query(...),
    limit: int = Query(5, ge=1, le=20),
):
    """Return nearest Citi Bike stations with real-time availability."""
    response.headers["Cache-Control"] = "public, max-age=30"

    try:
        info_data = await _fetch_json_cached(CITIBIKE_INFO_URL, ttl=300)
        status_data = await _fetch_json_cached(CITIBIKE_STATUS_URL, ttl=30)
    except Exception as e:
        return {"error": str(e), "stations": []}

    # Build status lookup
    status_map = {}
    for s in status_data.get("data", {}).get("stations", []):
        status_map[s["station_id"]] = s

    # Find nearest stations
    scored = []
    for station in info_data.get("data", {}).get("stations", []):
        dist = haversine(lat, lon, station["lat"], station["lon"])
        scored.append((dist, station))
    scored.sort(key=lambda x: x[0])

    results = []
    for dist, station in scored[:limit]:
        sid = station["station_id"]
        status = status_map.get(sid, {})
        results.append({
            "name": station.get("name", ""),
            "lat": station["lat"],
            "lon": station["lon"],
            "distance_m": round(dist, 1),
            "bikes": status.get("num_bikes_available", 0),
            "ebikes": status.get("num_ebikes_available", 0),
            "docks": status.get("num_docks_available", 0),
            "active": status.get("is_renting", 0) == 1,
        })

    return {"stations": results}


# ---------------------------------------------------------------------------
# Directions (via Transitous / MOTIS API — free, open-source transit routing)
# ---------------------------------------------------------------------------

TRANSITOUS_URL = "https://api.transitous.org/api/v1/plan"


NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
# Bounding box for NYC area
NYC_VIEWBOX = "-74.3,40.4,-73.7,40.95"


@app.get("/api/search-places")
async def search_places(q: str = Query(..., min_length=2), limit: int = Query(8, ge=1, le=20)):
    """Search stations + addresses/landmarks via Nominatim. Returns mixed results."""
    results = []

    # 1. Search local GTFS stations first
    async with db.execute(
        "SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops "
        "WHERE (parent_station IS NULL OR parent_station = '') "
        "AND stop_name LIKE ? COLLATE NOCASE "
        "ORDER BY stop_name LIMIT ?",
        (f"%{q}%", min(limit, 5)),
    ) as cursor:
        rows = await cursor.fetchall()
    for r in rows:
        results.append({"name": "🚇 " + r[1], "lat": r[2], "lon": r[3], "type": "station"})

    # 2. Geocode via Nominatim for addresses/landmarks
    try:
        resp = await http_client.get(
            NOMINATIM_URL,
            params={
                "q": q,
                "format": "json",
                "limit": min(limit, 4),
                "viewbox": NYC_VIEWBOX,
                "bounded": "1",
            },
            headers={"User-Agent": "SideGPS/1.0 (NYC transit PWA)"},
            timeout=5.0,
        )
        if resp.status_code == 200:
            for place in resp.json():
                name = place.get("display_name", "")
                # Shorten: take first 2-3 parts of the address
                parts = name.split(", ")
                short = ", ".join(parts[:3])
                results.append({
                    "name": "📍 " + short,
                    "lat": float(place["lat"]),
                    "lon": float(place["lon"]),
                    "type": "place",
                })
    except Exception:
        pass  # Nominatim failure is non-fatal; station results still work

    return results[:limit]


@app.get("/api/directions")
async def get_directions(
    response: Response,
    from_lat: float = Query(...),
    from_lon: float = Query(...),
    to_lat: float = Query(...),
    to_lon: float = Query(...),
):
    """Proxy transit directions from Transitous (MOTIS) API."""
    response.headers["Cache-Control"] = "public, max-age=60"

    params = {
        "fromPlace": f"{from_lat},{from_lon}",
        "toPlace": f"{to_lat},{to_lon}",
    }
    try:
        resp = await http_client.get(
            TRANSITOUS_URL,
            params=params,
            headers={"User-Agent": "SideGPS/1.0 (NYC transit PWA)"},
            timeout=15.0,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        return {"error": str(e), "itineraries": []}

    # Simplify the Transitous response for our lightweight frontend
    itineraries = []
    for itin in data.get("itineraries", [])[:5]:
        legs = []
        for leg in itin.get("legs", []):
            simplified = {
                "mode": leg.get("mode", "WALK"),
                "from_name": leg.get("from", {}).get("name", ""),
                "to_name": leg.get("to", {}).get("name", ""),
                "duration": leg.get("duration", 0),
                "distance": leg.get("distance", 0),
                "start_time": leg.get("startTime", ""),
                "end_time": leg.get("endTime", ""),
            }
            if leg.get("mode") != "WALK":
                simplified["route"] = leg.get("routeShortName", "")
                simplified["route_long"] = leg.get("routeLongName", "")
                simplified["headsign"] = leg.get("tripHeadsign", "")
                simplified["agency"] = leg.get("agencyName", "")
                simplified["num_stops"] = len(leg.get("intermediateStops", []))
            legs.append(simplified)
        itineraries.append({
            "duration": itin.get("duration", 0),
            "transfers": itin.get("transfers", 0),
            "start_time": itin.get("startTime", ""),
            "end_time": itin.get("endTime", ""),
            "legs": legs,
        })

    return {"itineraries": itineraries}


# Serve frontend static files (mount AFTER API routes)
from fastapi.staticfiles import StaticFiles  # noqa: E402

_base = os.path.dirname(os.path.abspath(__file__))
_frontend_dir = os.path.join(_base, "static")
if not os.path.isdir(_frontend_dir):
    _frontend_dir = os.path.join(_base, "..", "frontend")
if os.path.isdir(_frontend_dir):
    app.mount("/", StaticFiles(directory=_frontend_dir, html=True), name="frontend")
