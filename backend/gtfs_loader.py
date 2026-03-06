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


if __name__ == "__main__":
    data = download_gtfs()
    create_db(data)
