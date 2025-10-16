#!/usr/bin/env bash
set -euo pipefail

IN="${1:?Usage: $0 input_image}"
OUTDIR="${2:-out}"
QJPEG="${QJPEG:-80}"   # JPEG quality
QWEBP="${QWEBP:-80}"   # WebP quality
QAVIF="${QAVIF:-45}"   # AVIF quality (0..100; higher=better)
QJXL="${QJXL:-1.5}"    # JXL distance (lower=better, ~1-2 good)

mkdir -p "$OUTDIR"

base="${OUTDIR}/$(basename "${IN%.*}")"

# --- JPEG baseline & progressive (ImageMagick) ---
# baseline:
magick "$IN" -strip -quality "$QJPEG" -interlace None  "${base}.baseline.jpg"
# progressive (scan-based):
magick "$IN" -strip -quality "$QJPEG" -interlace Plane "${base}.progressive.jpg"

# --- WebP (cwebp) ---
# NOTE: WebP has *incremental decoding*, not an interlace/progressive flag.
cwebp -q "$QWEBP" "$IN" -o "${base}.webp"

# --- AVIF (avifenc) ---
# Regular AVIF:
avifenc -q "$QAVIF" -s 6 "$IN" "${base}.avif"
# Progressive AVIF (layered from single input; EXPERIMENTAL flag):
avifenc --progressive -q "$QAVIF" -s 6 "$IN" "${base}.progressive.avif"

# Optional: explicit layered AVIF using multiple layers (same image),
# viewers can render progressively. Example 2 layers:
# avifenc --layered --scaling-mode 1/1 "$IN" --scaling-mode 1/2 "$IN" -q "$QAVIF" -s 6 "${base}.layered.avif"

# --- JPEG XL (cjxl) ---
# Regular JXL:
cjxl "$IN" "${base}.jxl" -d "$QJXL" -s 7
# Force progressive features (AC/DC progression):
cjxl "$IN" "${base}.progressive.jxl" -d "$QJXL" -s 7 --progressive_ac --progressive_dc=1

# --- PNG (Adam7 interlaced) ---
magick "$IN" -define png:interlace=true "${base}.interlaced.png"

echo "Done. Outputs in: $OUTDIR"
