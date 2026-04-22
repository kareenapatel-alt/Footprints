#!/bin/sh
# Rebuild videos/raccoon-eating.m4v from the QuickTime source so Chrome can play it in <video>.
# Chrome often cannot decode .mov; H.264 in .m4v/.mp4 works everywhere.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/icons/Raccoon - eating.mov"
OUT="$ROOT/videos/raccoon-eating.m4v"

if ! test -f "$SRC"; then
  echo "Missing source: $SRC" >&2
  exit 1
fi

if command -v avconvert >/dev/null 2>&1; then
  avconvert --source "$SRC" --preset PresetAppleM4V720pHD --output "$OUT" --replace --progress
  echo "Wrote $OUT"
  exit 0
fi

if command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -y -i "$SRC" -an -c:v libx264 -crf 22 -preset fast -pix_fmt yuv420p -movflags +faststart "$ROOT/videos/raccoon-eating.mp4"
  echo "Wrote $ROOT/videos/raccoon-eating.mp4 — update manifest + FP_RACCOON_LAUNCHER_EATING to use .mp4" >&2
  exit 0
fi

echo "Install ffmpeg (brew install ffmpeg) or use macOS avconvert (built in)." >&2
exit 1
