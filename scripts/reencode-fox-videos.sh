#!/bin/sh
# Build fox retrace + launcher clips from QuickTime sources (Chrome-friendly H.264).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IC="$ROOT/icons"
OUT="$ROOT/videos"

if ! command -v avconvert >/dev/null 2>&1; then
  echo "macOS avconvert not found." >&2
  exit 1
fi

avconvert --source "$IC/Fox - walking straight.mov" --preset PresetAppleM4V720pHD --output "$OUT/fox-walk-straight.m4v" --replace --progress
echo "Wrote $OUT/fox-walk-straight.m4v"

avconvert --source "$IC/Fox - walking left .mov" --preset PresetAppleM4V720pHD --output "$OUT/fox-walk-left.m4v" --replace --progress
echo "Wrote $OUT/fox-walk-left.m4v"

avconvert --source "$IC/Fox - Walking away left.mov" --preset PresetAppleM4V720pHD --output "$OUT/fox-walk-away-left.m4v" --replace --progress
echo "Wrote $OUT/fox-walk-away-left.m4v"

avconvert --source "$IC/Fox - walking away right.mov" --preset PresetAppleM4V720pHD --output "$OUT/fox-walk-away-right.m4v" --replace --progress
echo "Wrote $OUT/fox-walk-away-right.m4v"

avconvert --source "$IC/Fox - eating.mov" --preset PresetAppleM4V720pHD --output "$OUT/fox-eating.m4v" --replace --progress
echo "Wrote $OUT/fox-eating.m4v"
