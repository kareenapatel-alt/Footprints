#!/bin/sh
# Build raccoon retrace walk clips from QuickTime sources (Chrome-friendly H.264 for retrace).
# - raccoon-walk-right.m4v (primary clip; mirrored for leftward travel)
# - raccoon-walk-away.m4v (optional dedicated upward travel clip)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IC="$ROOT/icons"
OUT="$ROOT/videos"

if ! command -v avconvert >/dev/null 2>&1; then
  echo "macOS avconvert not found." >&2
  exit 1
fi

avconvert --source "$IC/Raccoon - Walking Right.mov" --preset PresetAppleM4V720pHD --output "$OUT/raccoon-walk-right.m4v" --replace --progress
echo "Wrote $OUT/raccoon-walk-right.m4v"

if [ -f "$IC/Raccoon - Walking away.mov" ]; then
  avconvert --source "$IC/Raccoon - Walking away.mov" --preset PresetAppleM4V720pHD --output "$OUT/raccoon-walk-away.m4v" --replace --progress
  echo "Wrote $OUT/raccoon-walk-away.m4v"
else
  echo "Skipping optional away clip: $IC/Raccoon - Walking away.mov not found"
fi
