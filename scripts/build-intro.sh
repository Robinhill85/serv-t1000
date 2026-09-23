#!/usr/bin/env bash
# Stitch the intro shots into the web cold open. Each shot ends on the next shot's first frame
# (A ends on B's portrait, B ends on C's macro eye), so hard cuts are seamless.
#   scripts/build-intro.sh [shotA.mp4 shotB.mp4 shotC.mp4]   (defaults: assets/intro-src/shot{A,B,C}.mp4)
# Output: public/intro/t1000-intro.mp4 (H.264, no audio, faststart) + public/intro/t1000-intro-poster.jpg
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
A="${1:-$ROOT/assets/intro-src/shotA.mp4}"
B="${2:-$ROOT/assets/intro-src/shotB.mp4}"
C="${3:-$ROOT/assets/intro-src/shotC.mp4}"
OUT_DIR="$ROOT/public/intro"
mkdir -p "$OUT_DIR"
NORM="scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,fps=24,format=yuv420p"

ffmpeg -y -v error -i "$A" -i "$B" -i "$C" -filter_complex \
  "[0:v]$NORM,fade=t=in:st=0:d=0.5[a];[1:v]$NORM[b];[2:v]$NORM[c];[a][b][c]concat=n=3:v=1:a=0[v]" \
  -map "[v]" -an -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p -movflags +faststart \
  "$OUT_DIR/t1000-intro.mp4"

ffmpeg -y -v error -ss 0.6 -i "$A" -frames:v 1 -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080" -q:v 4 "$OUT_DIR/t1000-intro-poster.jpg"
ls -lh "$OUT_DIR"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT_DIR/t1000-intro.mp4"
