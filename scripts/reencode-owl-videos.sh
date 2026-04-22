#!/bin/sh
# Build owl retrace + launcher clips from QuickTime sources (Chrome-friendly H.264).
# - Left flight: encode once; rightward retrace mirrors this clip in content.js.
# - Away: used when travel is primarily up the page (see pickOwlRetraceVideoPath).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IC="$ROOT/icons"
OUT="$ROOT/videos"

if ! command -v avconvert >/dev/null 2>&1; then
  echo "macOS avconvert not found." >&2
  exit 1
fi

# Source filename has a space before ".mov" on disk.
avconvert --source "$IC/Owl - flying left .mov" --preset PresetAppleM4V720pHD --output "$OUT/owl-flying-left.m4v" --replace --progress
echo "Wrote $OUT/owl-flying-left.m4v"

avconvert --source "$IC/Owl - flying away.mov" --preset PresetAppleM4V720pHD --output "$OUT/owl-flying-away.m4v" --replace --progress
echo "Wrote $OUT/owl-flying-away.m4v"

avconvert --source "$IC/Owl - eating.mov" --preset PresetAppleM4V720pHD --output "$OUT/owl-eating.m4v" --replace --progress
echo "Wrote $OUT/owl-eating.m4v"
