# SideGPS — Degoogled NYC Transit

A privacy-respecting NYC subway, Citi Bike, and transit directions app designed for the [Sidephone SP-01](https://docs.sidephone.com) (480×640, degoogled Android). Zero Google dependencies, zero API keys, zero tracking.

## Features

- **Real-time subway arrivals** — live data from MTA GTFS-RT feeds (8 route groups)
- **Nearby stations** — GPS-based, shows walking distance + next trains
- **Citi Bike** — real-time bike, eBike, and dock availability at nearby stations
- **Directions** — multi-modal transit routing (🚇 transit, 🚶 walk, 🚲 bike) via Transitous
- **Service alerts** — current MTA disruptions and delays
- **Map links** — tap 📍 to open any station or bike dock in Organic Maps / HERE Maps via `geo:` URI
- **Offline-capable** — PWA with service worker caching; works in subway tunnels
- **Tiny screen optimized** — designed for 480×640 displays
- **No tracking** — no cookies, analytics, or third-party scripts
- **No data stored** — your location is never logged or persisted server-side; `localStorage` is used only on-device for offline caching

## Architecture

```
Frontend (PWA)          Backend (FastAPI)              External APIs
index.html  ──────►  /api/nearby        ──────►  MTA GTFS-RT feeds
style.css             /api/arrivals               MTA Service Alerts
app.js                /api/alerts
sw.js                 /api/citibike      ──────►  Citi Bike GBFS
manifest.json         /api/directions    ──────►  Transitous (MOTIS)
                      /api/search-places ──────►  Nominatim (OSM)
                      /api/stations               GTFS static (SQLite)
```

## Quick Start

```bash
# 1. Set up backend
cd backend
uv sync

# 2. Download MTA GTFS data
uv run python gtfs_loader.py

# 3. Run server (serves both API + frontend)
uv run uvicorn main:app --host 127.0.0.1 --port 8000

# 4. Open in browser
open http://127.0.0.1:8000
```

## Data Sources

All APIs are free and require no authentication.

| Service | Purpose | URL |
|---------|---------|-----|
| MTA GTFS (static) | Station/route data | `rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip` |
| MTA GTFS-RT | Real-time arrivals | `api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-*` |
| MTA Alerts | Service disruptions | `api-endpoint.mta.info/.../camsys%2Fsubway-alerts` |
| Citi Bike GBFS | Bike/dock availability | `gbfs.citibikenyc.com/gbfs/en/station_*.json` |
| Transitous (MOTIS) | Transit routing | `api.transitous.org/api/v1/plan` |
| Nominatim (OSM) | Address search | `nominatim.openstreetmap.org/search` |

## Deployment

Deployed to **Azure App Service** (F1 free tier) via GitHub Actions.

- **CI/CD** — `.github/workflows/deploy.yml` deploys on every push to `main`
- **GTFS updates** — `.github/workflows/update-gtfs.yml` rebuilds the station database monthly and auto-deploys if changed

## License

MIT
