"""Shoebox - a tiny shoe catalog.

FastAPI backend: stores metadata in SQLite, photos in <PHOTO_DIR>/<size>/,
thumbnails in <DATA_DIR>/thumbs/, and serves the static web UI.
"""
import io
import os
import re
import shutil
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel

from .color import COLORS, detect_color

PHOTO_DIR = Path(os.environ.get("PHOTO_DIR", "/photos")).resolve()
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data")).resolve()
THUMB_DIR = DATA_DIR / "thumbs"
DB_PATH = DATA_DIR / "shoebox.db"
STATIC_DIR = Path(__file__).parent / "static"
CATEGORIES = ("kids", "adult")
THUMB_SIZE = 480

for d in (PHOTO_DIR, DATA_DIR, THUMB_DIR):
    d.mkdir(parents=True, exist_ok=True)


@contextmanager
def db():
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    try:
        yield con
        con.commit()
    finally:
        con.close()


with db() as con:
    con.execute(
        """CREATE TABLE IF NOT EXISTS shoes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            category    TEXT NOT NULL,
            size        TEXT NOT NULL,
            comment     TEXT NOT NULL DEFAULT '',
            photo_path  TEXT NOT NULL DEFAULT '',
            color       TEXT NOT NULL DEFAULT '',
            boxed       INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        )"""
    )
    cols = {r["name"] for r in con.execute("PRAGMA table_info(shoes)")}
    if "color" not in cols:
        con.execute("ALTER TABLE shoes ADD COLUMN color TEXT NOT NULL DEFAULT ''")
    if "boxed" not in cols:
        con.execute("ALTER TABLE shoes ADD COLUMN boxed INTEGER NOT NULL DEFAULT 0")
    # name the color of shoes added before color detection existed
    for r in con.execute("SELECT id FROM shoes WHERE color = ''").fetchall():
        try:
            with Image.open(THUMB_DIR / f"{r['id']}.jpg") as im:
                con.execute("UPDATE shoes SET color = ? WHERE id = ?", (detect_color(im), r["id"]))
        except OSError:
            pass  # missing or unreadable thumbnail, leave it uncolored

app = FastAPI(title="Shoebox", docs_url="/api/docs", redoc_url=None)


# ---------- helpers ----------

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def clean_category(raw: Optional[str]) -> str:
    c = (raw or "").strip().lower()
    if c not in CATEGORIES:
        raise HTTPException(400, "Category must be 'kids' or 'adult'")
    return c


def clean_color(raw: Optional[str]) -> str:
    c = (raw or "").strip().lower()
    if c not in COLORS:
        raise HTTPException(400, "Color must be one of: " + ", ".join(COLORS))
    return c


def clean_size(raw: Optional[str]) -> str:
    s = (raw or "").strip().replace(",", ".")
    s = re.sub(r"[^0-9A-Za-z. _-]", "", s).strip(" .")
    if not s:
        raise HTTPException(400, "Size is required")
    return s[:20]


def rel_photo_path(shoe_id: int, category: str, size: str) -> str:
    folder = size.replace(" ", "_")
    return f"{folder}/{shoe_id:05d}_{category}.jpg"


def remove_empty_dir(p: Path) -> None:
    try:
        p = p.resolve()
        if p != PHOTO_DIR and PHOTO_DIR in p.parents:
            p.rmdir()  # only succeeds when empty
    except OSError:
        pass


def save_image(data: bytes, dest: Path, thumb: Path) -> str:
    """Store photo and thumbnail, return the detected color."""
    try:
        img = Image.open(io.BytesIO(data))
        fmt = img.format
        orientation = img.getexif().get(0x0112, 1)
        img = ImageOps.exif_transpose(img)
        if img.mode != "RGB":
            img = img.convert("RGB")
    except Exception:
        raise HTTPException(400, "The uploaded file is not a readable image")

    dest.parent.mkdir(parents=True, exist_ok=True)
    if fmt == "JPEG" and orientation == 1:
        dest.write_bytes(data)  # already a correctly oriented JPEG, keep as is
    else:
        img.save(dest, "JPEG", quality=90)

    t = img.copy()
    t.thumbnail((THUMB_SIZE, THUMB_SIZE))
    t.save(thumb, "JPEG", quality=80)
    return detect_color(t)


def to_dict(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "category": r["category"],
        "size": r["size"],
        "comment": r["comment"],
        "color": r["color"],
        "boxed": bool(r["boxed"]),
        "created_at": r["created_at"],
        "updated_at": r["updated_at"],
        "photo_url": "/photos/" + quote(r["photo_path"], safe="/"),
        "thumb_url": f"/thumbs/{r['id']}.jpg",
    }


def get_row(con: sqlite3.Connection, shoe_id: int) -> sqlite3.Row:
    row = con.execute("SELECT * FROM shoes WHERE id = ?", (shoe_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Shoe not found")
    return row


# ---------- API ----------

class ShoeUpdate(BaseModel):
    category: Optional[str] = None
    size: Optional[str] = None
    comment: Optional[str] = None
    color: Optional[str] = None
    boxed: Optional[bool] = None


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/shoes")
def list_shoes():
    with db() as con:
        rows = con.execute("SELECT * FROM shoes ORDER BY id DESC").fetchall()
    return [to_dict(r) for r in rows]


@app.post("/api/shoes", status_code=201)
def create_shoe(
    photo: UploadFile = File(...),
    category: str = Form(...),
    size: str = Form(...),
    comment: str = Form(""),
    boxed: bool = Form(False),
):
    category = clean_category(category)
    size = clean_size(size)
    data = photo.file.read()
    now = now_iso()
    with db() as con:
        cur = con.execute(
            "INSERT INTO shoes (category, size, comment, boxed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (category, size, comment.strip(), boxed, now, now),
        )
        shoe_id = cur.lastrowid
        rel = rel_photo_path(shoe_id, category, size)
        color = save_image(data, PHOTO_DIR / rel, THUMB_DIR / f"{shoe_id}.jpg")  # raises -> rollback
        con.execute("UPDATE shoes SET photo_path = ?, color = ? WHERE id = ?", (rel, color, shoe_id))
        row = get_row(con, shoe_id)
    return to_dict(row)


@app.patch("/api/shoes/{shoe_id}")
def update_shoe(shoe_id: int, upd: ShoeUpdate):
    with db() as con:
        row = get_row(con, shoe_id)
        category = clean_category(upd.category) if upd.category is not None else row["category"]
        size = clean_size(upd.size) if upd.size is not None else row["size"]
        comment = upd.comment.strip() if upd.comment is not None else row["comment"]
        color = clean_color(upd.color) if upd.color is not None else row["color"]
        boxed = upd.boxed if upd.boxed is not None else bool(row["boxed"])

        rel = row["photo_path"]
        new_rel = rel_photo_path(shoe_id, category, size)
        if new_rel != rel:
            old, new = PHOTO_DIR / rel, PHOTO_DIR / new_rel
            if old.is_file():
                new.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(old), str(new))
                remove_empty_dir(old.parent)
            rel = new_rel

        con.execute(
            "UPDATE shoes SET category = ?, size = ?, comment = ?, color = ?, boxed = ?, photo_path = ?, updated_at = ? WHERE id = ?",
            (category, size, comment, color, boxed, rel, now_iso(), shoe_id),
        )
        row = get_row(con, shoe_id)
    return to_dict(row)


@app.delete("/api/shoes/{shoe_id}", status_code=204)
def delete_shoe(shoe_id: int):
    with db() as con:
        row = get_row(con, shoe_id)
        con.execute("DELETE FROM shoes WHERE id = ?", (shoe_id,))
    photo = PHOTO_DIR / row["photo_path"]
    if row["photo_path"] and photo.is_file():
        photo.unlink()
        remove_empty_dir(photo.parent)
    (THUMB_DIR / f"{shoe_id}.jpg").unlink(missing_ok=True)


# ---------- static files (mounted last so /api wins) ----------

app.mount("/photos", StaticFiles(directory=PHOTO_DIR), name="photos")
app.mount("/thumbs", StaticFiles(directory=THUMB_DIR), name="thumbs")
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="ui")
