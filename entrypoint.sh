#!/bin/sh
# Create folders, hand them to PUID:PGID (Unraid default nobody:users = 99:100), drop root.
set -e
PUID="${PUID:-99}"
PGID="${PGID:-100}"
umask "${UMASK:-002}"

mkdir -p "$DATA_DIR/thumbs" "$PHOTO_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R "$PUID:$PGID" "$DATA_DIR"
  chown "$PUID:$PGID" "$PHOTO_DIR" 2>/dev/null || true
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups -- "$@"
fi
exec "$@"
