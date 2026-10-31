# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Shoebox: a tiny self-hosted shoe catalog (category kids/adult, EU size, photo, note), built for fast phone entry and deployed as one Docker container on Unraid. LAN-only, no auth by design. See README.md for deployment details.

## Commands

There are no tests, linter or build step.

```powershell
# run locally with Docker (data in ./_local/), UI at http://localhost:8090
docker compose up --build

# run without Docker
pip install -r requirements.txt
$env:PHOTO_DIR="./_local/photos"; $env:DATA_DIR="./_local/data"
uvicorn app.main:app --host 0.0.0.0 --port 8090 --reload
```

API docs: `/api/docs`. Every push to `main` (and `v*` tags) builds and publishes `ghcr.io/alt-13/shoebox` via `.github/workflows/docker.yml`; the Unraid template in `unraid/shoebox.xml` points at that image.

## Architecture

- **Backend** is the single file `app/main.py` (FastAPI). It creates dirs and the `shoes` SQLite table at import time. There is no migration framework: new columns are added to `CREATE TABLE` and also via a `PRAGMA table_info` check + `ALTER TABLE` for existing DBs (see `color`). `db()` is a context manager that commits on success and closes, so an exception inside the `with` block rolls back — `create_shoe` relies on this when `save_image` fails.
- **Storage layout is a user-facing contract**: photos live at `PHOTO_DIR/<size>/<id:05d>_<category>.jpg` (see `rel_photo_path`) so they are browsable from Unraid shares without the app. `photo_path` in the DB is relative to `PHOTO_DIR`. Changing size/category via PATCH moves the file and removes now-empty size folders (`remove_empty_dir`, guarded to stay inside `PHOTO_DIR`). Delete removes photo and thumbnail.
- **Thumbnails** are `DATA_DIR/thumbs/<id>.jpg` (480 px). `save_image` keeps an already-upright JPEG byte-for-byte; otherwise it EXIF-transposes and re-encodes.
- **Color** is detected server-side by `app/color.py` (no ML: HSV naming of the photo's center, ignoring the floor color found at the edges) from the thumbnail on upload, and backfilled at startup for rows with `color = ''`. The fixed name list `COLORS` is duplicated in `app.js` (with swatch hex values); keep both in sync. Self-check: `python -m app.color`. Users can correct the color in the edit sheet only; the add flow never asks.
- **Static mounts** (`/photos`, `/thumbs`, `/`) are registered last so `/api/*` routes win.
- **Frontend** is vanilla JS in `app/static/` (single IIFE in `app.js`, no framework, no bundler). It downscales photos client-side (max 2048 px, JPEG 0.85) before upload, uses `<input type="file" capture="environment">` (works over plain HTTP, unlike `getUserMedia`), and has an in-memory upload queue (`enqueue`/`pump`) so "Save & next" reopens the camera immediately. Size choices are hard-coded in `SIZES` (kids 16–40, adult 34–50, plus “½”); last-used type/size persist in `localStorage` key `shoebox`.
- **Container**: `entrypoint.sh` chowns `/data` (and `/photos` top dir) to `PUID:PGID` (Unraid default 99:100), applies `UMASK`, then drops root via `setpriv`. The Dockerfile strips CRLF from it, since the repo is edited on Windows.
