#!/bin/bash
set -e

cd /home/site/wwwroot

# Download GTFS data if not present
if [ ! -f data/gtfs.db ]; then
    echo "Downloading MTA GTFS data..."
    python gtfs_loader.py
fi

# Start with gunicorn (App Service uses this)
gunicorn main:app --worker-class uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000 --timeout 120
