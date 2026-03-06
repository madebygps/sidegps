# SideGPS — Degoogled NYC Transit

A privacy-respecting NYC subway & bus tracker designed for the [Sidephone SP-01](https://docs.sidephone.com) (480×640, degoogled Android). Zero Google dependencies.

## Features

- **Real-time subway arrivals** — live data from MTA GTFS-RT feeds
- **Nearby stations** — GPS-based, shows walking distance + next trains
- **Service alerts** — current MTA disruptions and delays
- **Offline-capable** — PWA with service worker caching
- **Tiny screen optimized** — designed for 480×640 displays
- **No tracking** — no cookies, analytics, or third-party scripts

## Architecture

```
Frontend (PWA)          Backend (FastAPI)         MTA
index.html  ──────►  /api/nearby      ──────►  GTFS-RT feeds
style.css             /api/arrivals             (real-time)
app.js                /api/alerts
sw.js                 /api/stations            GTFS static
                                               (SQLite DB)
```

## Quick Start

```bash
# 1. Set up backend
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 2. Download MTA GTFS data
python gtfs_loader.py

# 3. Run server (serves both API + frontend)
uvicorn main:app --host 127.0.0.1 --port 8000

# 4. Open in browser
open http://127.0.0.1:8000
```

## MTA Data Sources

| Feed | URL | Auth |
|------|-----|------|
| Subway GTFS (static) | `rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip` | None |
| Subway GTFS-RT | `api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-*` | None |
| Service Alerts | `api-endpoint.mta.info/.../camsys%2Fsubway-alerts` | None |

## License

MIT
