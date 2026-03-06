"""Download MTA subway GTFS static data and load into SQLite."""

import csv
import io
import os
import sqlite3
import ssl
import urllib.request
import zipfile

GTFS_URL = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip"
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "gtfs.db")


def download_gtfs() -> bytes:
    print(f"Downloading GTFS from {GTFS_URL} ...")
    ctx = ssl.create_default_context()
    try:
        import certifi
        ctx.load_verify_locations(certifi.where())
    except ImportError:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(GTFS_URL, timeout=60, context=ctx) as resp:
        data = resp.read()
    print(f"Downloaded {len(data)} bytes")
    return data


def parse_csv(zip_bytes: bytes, filename: str) -> list[dict]:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        with zf.open(filename) as f:
            reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
            return list(reader)


def create_db(zip_bytes: bytes) -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # Create tables
    cur.execute("""
        CREATE TABLE stops (
            stop_id TEXT PRIMARY KEY,
            stop_name TEXT,
            stop_lat REAL,
            stop_lon REAL,
            parent_station TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE routes (
            route_id TEXT PRIMARY KEY,
            route_short_name TEXT,
            route_long_name TEXT,
            route_color TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE trips (
            trip_id TEXT PRIMARY KEY,
            route_id TEXT,
            direction_id INTEGER,
            trip_headsign TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE stop_times (
            trip_id TEXT,
            stop_id TEXT,
            arrival_time TEXT,
            departure_time TEXT,
            stop_sequence INTEGER
        )
    """)

    # Load stops
    rows = parse_csv(zip_bytes, "stops.txt")
    cur.executemany(
        "INSERT OR IGNORE INTO stops VALUES (?, ?, ?, ?, ?)",
        [
            (
                r["stop_id"],
                r["stop_name"],
                float(r["stop_lat"]) if r["stop_lat"] else None,
                float(r["stop_lon"]) if r["stop_lon"] else None,
                r.get("parent_station", ""),
            )
            for r in rows
        ],
    )
    print(f"Loaded {len(rows)} stops")

    # Load routes
    rows = parse_csv(zip_bytes, "routes.txt")
    cur.executemany(
        "INSERT OR IGNORE INTO routes VALUES (?, ?, ?, ?)",
        [
            (
                r["route_id"],
                r.get("route_short_name", ""),
                r.get("route_long_name", ""),
                r.get("route_color", ""),
            )
            for r in rows
        ],
    )
    print(f"Loaded {len(rows)} routes")

    # Load trips
    rows = parse_csv(zip_bytes, "trips.txt")
    cur.executemany(
        "INSERT OR IGNORE INTO trips VALUES (?, ?, ?, ?)",
        [
            (
                r["trip_id"],
                r["route_id"],
                int(r["direction_id"]) if r.get("direction_id") else 0,
                r.get("trip_headsign", ""),
            )
            for r in rows
        ],
    )
    print(f"Loaded {len(rows)} trips")

    # Load stop_times
    rows = parse_csv(zip_bytes, "stop_times.txt")
    cur.executemany(
        "INSERT INTO stop_times VALUES (?, ?, ?, ?, ?)",
        [
            (
                r["trip_id"],
                r["stop_id"],
                r["arrival_time"],
                r["departure_time"],
                int(r["stop_sequence"]) if r.get("stop_sequence") else 0,
            )
            for r in rows
        ],
    )
    print(f"Loaded {len(rows)} stop_times")

    # Create indexes
    cur.execute("CREATE INDEX idx_stops_latlon ON stops (stop_lat, stop_lon)")
    cur.execute("CREATE INDEX idx_stop_times_stop_id ON stop_times (stop_id)")
    cur.execute("CREATE INDEX idx_stop_times_trip_id ON stop_times (trip_id)")
    cur.execute("CREATE INDEX idx_trips_route_id ON trips (route_id)")
    cur.execute("CREATE INDEX idx_stops_parent ON stops (parent_station)")

    conn.commit()
    conn.close()
    print(f"Database created at {DB_PATH}")


LITE_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "gtfs_lite.db")


def create_lite_db(zip_bytes: bytes) -> None:
    """Build the lightweight DB (256KB) with precomputed route-station mappings."""
    os.makedirs(os.path.dirname(LITE_DB_PATH), exist_ok=True)
    if os.path.exists(LITE_DB_PATH):
        os.remove(LITE_DB_PATH)

    # First build full DB in memory to compute the join
    mem = sqlite3.connect(":memory:")
    mc = mem.cursor()

    mc.execute("CREATE TABLE stops (stop_id TEXT PRIMARY KEY, stop_name TEXT, stop_lat REAL, stop_lon REAL, parent_station TEXT)")
    mc.execute("CREATE TABLE routes (route_id TEXT PRIMARY KEY, route_short_name TEXT, route_long_name TEXT, route_color TEXT)")
    mc.execute("CREATE TABLE trips (trip_id TEXT, route_id TEXT)")
    mc.execute("CREATE TABLE stop_times (trip_id TEXT, stop_id TEXT)")

    for table, filename, cols in [
        ("stops", "stops.txt", lambda r: (r["stop_id"], r["stop_name"], float(r["stop_lat"]) if r["stop_lat"] else None, float(r["stop_lon"]) if r["stop_lon"] else None, r.get("parent_station", ""))),
        ("routes", "routes.txt", lambda r: (r["route_id"], r.get("route_short_name", ""), r.get("route_long_name", ""), r.get("route_color", ""))),
        ("trips", "trips.txt", lambda r: (r["trip_id"], r["route_id"])),
        ("stop_times", "stop_times.txt", lambda r: (r["trip_id"], r["stop_id"])),
    ]:
        rows = parse_csv(zip_bytes, filename)
        mc.executemany(f"INSERT OR IGNORE INTO {table} VALUES ({','.join('?' for _ in range(len(cols(rows[0]))))})", [cols(r) for r in rows])
        print(f"Parsed {len(rows)} {table}")

    # Precompute route_stops
    route_stops = mc.execute("""
        SELECT DISTINCT
            CASE WHEN s.parent_station != '' THEN s.parent_station ELSE s.stop_id END,
            r.route_id, r.route_short_name, r.route_long_name, r.route_color
        FROM stop_times st
        JOIN trips t ON st.trip_id = t.trip_id
        JOIN routes r ON t.route_id = r.route_id
        JOIN stops s ON st.stop_id = s.stop_id
    """).fetchall()
    print(f"Precomputed {len(route_stops)} route-station mappings")
    mem.close()

    # Write the lite DB
    lite = sqlite3.connect(LITE_DB_PATH)
    lc = lite.cursor()
    lc.execute("CREATE TABLE stops (stop_id TEXT PRIMARY KEY, stop_name TEXT, stop_lat REAL, stop_lon REAL, parent_station TEXT)")
    lc.execute("CREATE TABLE routes (route_id TEXT PRIMARY KEY, route_short_name TEXT, route_long_name TEXT, route_color TEXT)")
    lc.execute("CREATE TABLE route_stops (station_id TEXT, route_id TEXT, route_short_name TEXT, route_long_name TEXT, route_color TEXT, PRIMARY KEY (station_id, route_id))")

    stops = parse_csv(zip_bytes, "stops.txt")
    lc.executemany("INSERT OR IGNORE INTO stops VALUES (?,?,?,?,?)",
        [(r["stop_id"], r["stop_name"], float(r["stop_lat"]) if r["stop_lat"] else None, float(r["stop_lon"]) if r["stop_lon"] else None, r.get("parent_station", "")) for r in stops])
    routes = parse_csv(zip_bytes, "routes.txt")
    lc.executemany("INSERT OR IGNORE INTO routes VALUES (?,?,?,?)",
        [(r["route_id"], r.get("route_short_name", ""), r.get("route_long_name", ""), r.get("route_color", "")) for r in routes])
    lc.executemany("INSERT OR IGNORE INTO route_stops VALUES (?,?,?,?,?)", route_stops)

    lc.execute("CREATE INDEX idx_stops_parent ON stops(parent_station)")
    lc.execute("CREATE INDEX idx_stops_latlon ON stops(stop_lat, stop_lon)")
    lc.execute("CREATE INDEX idx_route_stops_station ON route_stops(station_id)")
    lite.commit()
    lite.close()
    print(f"Lite database created at {LITE_DB_PATH} ({os.path.getsize(LITE_DB_PATH) // 1024} KB)")


if __name__ == "__main__":
    import sys
    data = download_gtfs()
    if "--lite" in sys.argv:
        create_lite_db(data)
    else:
        create_db(data)
        create_lite_db(data)
