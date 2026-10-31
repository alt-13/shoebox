# Shoebox

A tiny self-hosted catalog for the shoes at home: type (kids/adult), EU size, photo and an optional note.
Built for adding shoes fast with a smartphone, deployed as a single Docker container on Unraid.

- **Web UI**: vanilla HTML/CSS/JS, no build step
- **Backend**: Python FastAPI (one file, `app/main.py`)
- **DB**: SQLite in `/data`
- **Photos**: plain JPEGs in `/photos/<size>/<id>_<kids|adult>.jpg`, readable from your shares without the app
- **Thumbnails**: generated server-side into `/data/thumbs`

## How adding works on the phone

1. Tap **Add shoe** – the phone's camera app opens.
2. Take the photo – the details sheet opens with the last used type and size preselected.
3. Tap a size (and **+ ½** if needed), optionally type a note.
4. Tap **Save & next** – the upload runs in the background and the camera opens again immediately.

Photos are downscaled in the browser (max 2048 px, JPEG 85%) before upload, so it stays fast even on weak Wi-Fi.

### About camera permission

The app uses `<input type="file" capture="environment">`, which hands off to the phone's native camera.
This works over plain `http://` on the LAN. The live in-browser camera API (`getUserMedia`) only works on
HTTPS, so it would need a reverse proxy with a certificate. With this approach the browser shows no
permission prompt; the phone may ask once to allow the browser to use the camera.

Tip: use "Add to Home Screen" in Safari/Chrome for an app-like icon.

## Repository setup (Windows)

```powershell
cd C:\Users\atr\IdeaProjects
# extract shoebox.zip here so you get C:\Users\atr\IdeaProjects\shoebox
cd shoebox

# replace the placeholder with your GitHub username in the Unraid template
(Get-Content unraid\shoebox.xml) -replace 'YOUR_GITHUB_USER','<your-github-user>' | Set-Content unraid\shoebox.xml

git init -b main
git add .
git commit -m "Initial commit"

# with GitHub CLI:
gh repo create shoebox --public --source . --push
# or create an empty repo "shoebox" on github.com, then:
# git remote add origin https://github.com/<your-github-user>/shoebox.git
# git push -u origin main
```

Every push to `main` runs `.github/workflows/docker.yml`, which builds the image and publishes it to
`ghcr.io/<your-github-user>/shoebox:latest` (plus a `sha-xxxxxxx` tag; pushing a tag like `v1.0.0` also adds `1.0.0`).

**After the first build**: open GitHub → your profile → Packages → `shoebox` → Package settings →
set visibility to **Public**. New GHCR packages start private, and Unraid can't pull private images without a login.

## Deploy on Unraid

Option A (template repository):
1. Docker tab → scroll to **Template repositories** → add `https://github.com/<your-github-user>/shoebox` → Save.
2. **Add Container** → pick `shoebox` from the template list.

Option B (manual):
1. Copy `unraid/shoebox.xml` to `/boot/config/plugins/dockerMan/templates-user/my-shoebox.xml` on the flash drive.
2. **Add Container** → Template → `shoebox`.

Then set:

| Setting | Container | Default |
|---|---|---|
| Web UI port | 8080 | 8090 |
| Photo path | /photos | /mnt/user/photos/shoes |
| App data | /data | /mnt/user/appdata/shoebox |
| PUID / PGID / UMASK (advanced) | | 99 / 100 / 002 |

Open `http://<unraid-ip>:8090` on your phone.

To update after pushing changes: Docker tab → **Check for updates** → apply.

## Local testing

```powershell
docker compose up --build
```
Then open `http://<your-pc-ip>:8090` on your phone (same Wi-Fi). Data lands in `./_local/`.

Without Docker:
```powershell
pip install -r requirements.txt
$env:PHOTO_DIR="./_local/photos"; $env:DATA_DIR="./_local/data"
uvicorn app.main:app --host 0.0.0.0 --port 8090
```

## Notes

- Changing a shoe's size or type in the app moves its photo to the matching folder; empty size folders are removed.
- Deleting a shoe deletes its photo file too.
- API docs: `http://<server>:8090/api/docs`
- Backup: the photo folder plus `/data/shoebox.db` is everything.
- No authentication by design; keep it on the LAN.
