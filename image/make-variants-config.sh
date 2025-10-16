#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./make-variants-config.sh input_image [out_dir] [config_path]
#
# Env knobs:
#   QJPEG=80 QWEBP=80 QAVIF=45 QJXL=1.5
#   BASE_URL=            # e.g. BASE_URL="http://127.0.0.1:5173"
#   LABEL_PREFIX=        # optional, prepended to labels

IN="${1:?Usage: $0 input_image [out_dir] [config_path]}"
OUTDIR="${2:-out}"
CFG="${3:-bench.config.json}"

QJPEG="${QJPEG:-80}"
QWEBP="${QWEBP:-80}"
QAVIF="${QAVIF:-45}"   # 0..100 (higher=better)
QJXL="${QJXL:-1.5}"    # distance (lower=better)
BASE_URL="${BASE_URL:-}"  # if set, used as prefix for URLs
LABEL_PREFIX="${LABEL_PREFIX:-}"

# deps (force jq so JSON building is clean)
need() { command -v "$1" >/dev/null || { echo "Missing: $1"; exit 1; }; }
need bash
need magick
need cwebp
need avifenc
need jq
command -v cjxl >/dev/null || echo "Note: cjxl not found — JXL variants will be skipped"

mkdir -p "$OUTDIR"

fname="$(basename "$IN")"
stem_noext="${fname%.*}"
base="${OUTDIR}/${stem_noext}"

# --- Generate variants -------------------------------------------------------
magick "$IN" -strip -quality "$QJPEG" -interlace None  "${base}.baseline.jpg"
magick "$IN" -strip -quality "$QJPEG" -interlace Plane "${base}.progressive.jpg"

cwebp -quiet -q "$QWEBP" "$IN" -o "${base}.webp"

avifenc -q "$QAVIF" -s 6 "$IN" "${base}.avif" >/dev/null
avifenc --progressive -q "$QAVIF" -s 6 "$IN" "${base}.progressive.avif" >/dev/null

# --- JPEG XL (cjxl) ---
if command -v cjxl >/dev/null; then
  # Pick the right flag: newer cjxl uses -e/--effort, older used -s (speed)
  if cjxl -h 2>&1 | grep -qE '(^|\s)-e,?\s|--effort'; then
    CJXL_EFFORT_FLAG=(-e "${JXL_EFFORT:-7}")
  elif cjxl -h 2>&1 | grep -qE '(^|\s)-s[ ,]'; then
    CJXL_EFFORT_FLAG=(-s "${JXL_SPEED:-7}")
  else
    CJXL_EFFORT_FLAG=()
  fi

  cjxl "$IN" "${base}.jxl" -d "$QJXL" "${CJXL_EFFORT_FLAG[@]}" >/dev/null
  cjxl "$IN" "${base}.progressive.jxl" -d "$QJXL" "${CJXL_EFFORT_FLAG[@]}" \
       --progressive_ac --progressive_dc=1 >/dev/null
fi


magick "$IN" -define png:interlace=true "${base}.interlaced.png"

echo "Images written to: $OUTDIR"

# --- Build tests array (only include files that exist) -----------------------
tests_json="[]"
add_test() {
  local id="$1" label="$2" fmt="$3" relpath="$4" notes="${5:-}"
  local url
  if [[ -n "$BASE_URL" ]]; then
    url="${BASE_URL%/}/$relpath"
  else
    url="$relpath"
  fi
  tests_json="$(jq -c --arg id "$id" \
                     --arg label "$label" \
                     --arg format "$fmt" \
                     --arg url "$url" \
                     --arg notes "$notes" \
                     '. += [{id:$id,label:$label,format:$format,url:$url,notes:$notes}]' \
                     <<<"$tests_json")"
}

relpath() { # make path relative to $PWD
  local p="$1"; p="${p#./}"; echo "${p#"$PWD/"}"
}

maybe_add() {
  local file="$1" id="$2" label="$3" fmt="$4" notes="${5:-}"
  [[ -f "$file" ]] || return 0
  add_test "$id" "$label" "$fmt" "$(relpath "$file")" "$notes"
}

maybe_add "${base}.baseline.jpg"     "jpeg-baseline"    "${LABEL_PREFIX}JPEG Baseline"      "jpeg"
maybe_add "${base}.progressive.jpg"  "jpeg-progressive" "${LABEL_PREFIX}JPEG Progressive"   "jpeg"
maybe_add "${base}.webp"             "webp"             "${LABEL_PREFIX}WebP"               "webp"
maybe_add "${base}.avif"             "avif"             "${LABEL_PREFIX}AVIF"               "avif"
maybe_add "${base}.progressive.avif" "avif-progressive" "${LABEL_PREFIX}AVIF (progressive)" "avif" "single-input progressive"
if command -v cjxl >/dev/null; then
  maybe_add "${base}.jxl"               "jxl"             "${LABEL_PREFIX}JPEG XL"              "jxl"
  maybe_add "${base}.progressive.jxl"   "jxl-progressive" "${LABEL_PREFIX}JPEG XL (progressive)" "jxl"
fi
maybe_add "${base}.interlaced.png"   "png-interlaced"   "${LABEL_PREFIX}PNG (Adam7)"        "png"

# --- Write config JSON -------------------------------------------------------
jq -n \
  --arg bg "#ffffff" \
  --arg fit "contain" \
  --argjson latency 200 \
  --argjson down 750 \
  --argjson up 250 \
  --argjson tests "$tests_json" '
  {
    render: { bg: $bg, fit: $fit },
    network: { throttle: true, latency: $latency, downKbps: $down, upKbps: $up },
    tests: $tests
  }' > "$CFG"

echo "Config written to: $CFG"

if [[ -z "$BASE_URL" ]]; then
  echo "Run the UI bench with the built-in server:"
  echo "  node progressive-image-bench-ui.mjs $CFG --root $(pwd)"
else
  echo "Using absolute URLs (BASE_URL=$BASE_URL). Start your own server, then:"
  echo "  node progressive-image-bench-ui.mjs $CFG"
fi
