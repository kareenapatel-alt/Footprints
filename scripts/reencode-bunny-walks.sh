#!/bin/sh
# Build bunny retrace walk clips from QuickTime sources (Chrome-friendly H.264).
# - horizontal: bunny-walk-right.m4v (mirrored for leftward travel)
# - steep down: bunny-walk-straight.m4v
# - steep up: bunny-walk-away.m4v
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IC="$ROOT/icons"
OUT="$ROOT/videos"

if ! command -v avconvert >/dev/null 2>&1; then
  echo "macOS avconvert not found." >&2
  exit 1
fi

avconvert --source "$IC/Bunny - walking right.mov" --preset PresetAppleM4V720pHD --output "$OUT/bunny-walk-right.m4v" --replace --progress
echo "Wrote $OUT/bunny-walk-right.m4v"

avconvert --source "$IC/Bunny - walking straight.mov" --preset PresetAppleM4V720pHD --output "$OUT/bunny-walk-straight.m4v" --replace --progress
echo "Wrote $OUT/bunny-walk-straight.m4v"

avconvert --source "$IC/Bunny - walking away.mov" --preset PresetAppleM4V720pHD --output "$OUT/bunny-walk-away.m4v" --replace --progress
echo "Wrote $OUT/bunny-walk-away.m4v"
