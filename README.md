# ABOUT BROWSERS RESEARCH - TOOLS

## What this is

A small toolkit to **generate image variants** (baseline/progressive encodings), **run cross-browser progressive-render benchmarks** (Chromium, Firefox, WebKit), and **visualize results** in an interactive dashboard.

Use it to:

* Validate assumptions about progressive rendering (JPEG, WebP, AVIF, JXL, PNG Adam7).
* Compare engines (Chromium/Firefox/WebKit) on the same assets.
* Produce **reproducible metrics** (t85 / t95 / Visual Index) with **multiple runs**, medians, and distribution box-plots.
* Capture **hardware/OS/browser versions** for comparability.

# Example output
  <img width="1209" height="1141" alt="Screenshot 2025-10-16 at 22 49 20" src="https://github.com/user-attachments/assets/0ae212e6-a77f-4d9d-90d4-11bd779a4b7e" />



---

## What it measures

* **t85 / t95** — Time to reach 85% / 95% visual similarity to the final frame (ms).
* **Visual Index** — The average “incompleteness” over load time (0–1, **lower is better**).
* Metrics are computed over **N runs** (default 5) with **median + p10/p90** and per-run distributions.

The runner:

* Drives headed Playwright (Chromium, Firefox, WebKit).
* Shows a single `<img>` on a neutral page; screenshots the **image area only** at ~100–120 ms cadence.
* Computes similarity via `pixelmatch(current, final)`.
* Uses an **internal chunked server** to trigger progressive paint; optional **Chromium CDP throttling**.
* Records server byte/timestamp traces.

---

## Components

* **`make-variants-config.sh`**
  Encodes one source image into:

  * JPEG **baseline** & **progressive**
  * WebP
  * AVIF (+ **progressive/layered**)
  * JPEG XL (+ **progressive**, if `cjxl` installed)
  * PNG Adam7 (interlaced)
    Then writes a matching **`bench.config.json`** pointing at the generated files.

* **`progressive-image-bench3.mjs`**
  One Node script that:

  * Starts an **internal throttled HTTP server** (chunked streaming).
  * Runs **headed** Chromium, Firefox, WebKit.
  * Captures visual timelines, computes **t85/t95/Visual Index**.
  * Repeats each test for **N runs** (CLI/config/env selectable).
  * Aggregates (median/p10/p90), writes CSV + JSON artifacts.
  * Opens an interactive **Plotly** dashboard with:

    * **Top row**: 3 grouped **bar** charts (median t85, t95, Visual Index) — exactly **three bars per test** (one per browser).
    * **Bottom row**: 3 **box-plots** (per-run distributions) for t85, t95, Visual Index.
    * **Environment banner** (OS/CPU/RAM/Node + browser versions + #runs).

---

## Requirements

### macOS (Homebrew)

```bash
brew install imagemagick webp libavif jpeg-xl jq
# Node & Playwright deps inside the repo folder:
npm init -y
npm i -D playwright pixelmatch pngjs fs-extra date-fns
npx playwright install
```

> `jpeg-xl` is optional — if missing, JXL outputs/tests are skipped.

Linux/Windows work too; install the equivalent packages (ImageMagick, libwebp/cwebp, libavif/avifenc, cjxl, jq, Node 18+).

---

## Quick start

### 1) Generate variants + config

From the repo root (the folder containing your source image):

```bash
./make-variants-config.sh ./image/files/source.png out bench.config.json
```

Optional encoders/labels:

```bash
QJPEG=82 QWEBP=82 QAVIF=40 QJXL=1.2 LABEL_PREFIX="[test] " \
  ./make-variants-config.sh ./image/files/source.png out bench.config.json
```

Outputs go to `out/` (e.g., `source.baseline.jpg`, `source.progressive.jpg`, `source.webp`, `source.avif`, `source.progressive.avif`, `source.jxl`, `source.progressive.jxl`, `source.interlaced.png`).
`bench.config.json` references those files.

**Absolute URLs instead of relative:** start your own server and set `BASE_URL`:

```bash
python3 -m http.server 5173   # serve the repo folder
BASE_URL="http://127.0.0.1:5173" ./make-variants-config.sh ./image/files/source.png out bench.config.json
```

### 2) Run the benchmarks with the UI dashboard

Using the built-in server (recommended):

```bash
node progressive-image-bench3.mjs bench.config.json --root /absolute/path/to/repo
```

Control run count:

```bash
node progressive-image-bench3.mjs bench.config.json --root "$(pwd)" --runs 7
# or: RUNS=7 node progressive-image-bench3.mjs bench.config.json --root "$(pwd)"
# or: set "runs": 7 in bench.config.json
```

Using external absolute URLs:

```bash
node progressive-image-bench3.mjs bench.config.json
```

The script opens `bench-results/<timestamp>/dashboard.html` automatically.
All artifacts are saved under that timestamped folder.

---

## Config reference (`bench.config.json`)

```json
{
  "render": { "bg": "#ffffff", "fit": "contain" },
  "network": {
    "throttle": true,
    "latency": 200,
    "downKbps": 750,
    "upKbps": 250,
    "server": { "chunkBytes": 16384, "chunkDelayMs": 60 }
  },
  "runs": 5,
  "tests": [
    { "id": "jpeg-baseline",     "label": "JPEG Baseline",            "format": "jpeg", "url": "out/source.baseline.jpg",        "notes": "" },
    { "id": "jpeg-progressive",  "label": "JPEG Progressive",         "format": "jpeg", "url": "out/source.progressive.jpg",     "notes": "" },
    { "id": "webp",              "label": "WebP",                      "format": "webp", "url": "out/source.webp",                "notes": "" },
    { "id": "avif",              "label": "AVIF",                      "format": "avif", "url": "out/source.avif",                "notes": "" },
    { "id": "avif-progressive",  "label": "AVIF (progressive)",        "format": "avif", "url": "out/source.progressive.avif",    "notes": "single-input progressive" },
    { "id": "jxl",               "label": "JPEG XL",                   "format": "jxl",  "url": "out/source.jxl",                 "notes": "" },
    { "id": "jxl-progressive",   "label": "JPEG XL (progressive)",     "format": "jxl",  "url": "out/source.progressive.jxl",     "notes": "" },
    { "id": "png-interlaced",    "label": "PNG (Adam7)",               "format": "png",  "url": "out/source.interlaced.png",      "notes": "" }
  ]
}
```

**Runs precedence:** CLI `--runs` → env `RUNS` → `config.runs` → default `5`.
**Server:** `server.chunkBytes` + `server.chunkDelayMs` control chunk size and pacing; the server omits `Content-Length` and streams to enable progressive paint.
**Throttling:** Chromium can be further throttled via CDP using `network.throttle/latency/downKbps/upKbps`. Firefox/WebKit rely on the server’s chunking.

---

## Output artifacts

Inside `bench-results/<timestamp>/`:

* `dashboard.html` — interactive Plotly dashboard.
* `summary.csv` — per browser/test aggregated metrics:

  * `median_t85/p10_t85/p90_t85`, `median_t95/p10_t95/p90_t95`, `median_visIndex/p10_visIndex/p90_visIndex`.
* `meta.json` — OS/CPU/RAM/Node, browser versions, `runs`.
* `per-run.json` — every single run’s raw metrics and run number.
* `aggregated.json` — aggregated stats per (browser, test).
* `server.traces.json` — chunk timing/byte counts per request.
* Per-run JSON files like `chromium-jpeg-progressive-run3.json`.

---

## How to read the charts

* **Top row (bars)** — medians across runs. You should always see **three bars** per test (Chromium, Firefox, WebKit).
  Lower bars are better for all three charts (t85, t95, Visual Index).
* **Bottom row (box-plots)** — distributions of all runs per browser/test.
  Boxes show quartiles; the line is median; whiskers approximate range; dots are outliers.
  Box-plots are **not “from zero” bars** — they sit at the measured values.

---

## Methods (details)

1. Load a page that centers the test image on a neutral background.
2. Capture **image-area screenshots** repeatedly (~100–120 ms).
3. For each frame, compute similarity to the final frame using `pixelmatch` and treat that as **visual completeness**.
4. Derive:

   * **t85** / **t95** — first timestamps where completeness ≥ 0.85 / 0.95.
   * **Visual Index** — time-normalized area above the completeness curve (lower = faster convergence).
5. Repeat for **N runs**, aggregate medians and p10/p90, and chart both **medians** and **distributions**.

---

## Repro tips

* Use the **same source image** across formats and keep dimensions equal.
* Caching is disabled by injected `Cache-Control: no-cache`.
* Keep server **chunk settings** stable between experiments.
* Prefer the built-in server; many static servers buffer and defeat progressive paint.
* Share `meta.json` alongside charts so others can compare devices/browsers.

---

## Troubleshooting

* **Charts look overlapped or vanish on resize**
  The dashboard sets explicit heights and resizes plots on container changes. If you embed it elsewhere, keep the `.card`/`.plot` structure intact.

* **No progressive effect**
  Ensure responses are **chunked** (no `Content-Length`) and your CDN/proxy isn’t buffering.

* **Dashboard didn’t open**
  Open `bench-results/<timestamp>/dashboard.html` manually.

* **WebKit vs Safari**
  Playwright WebKit ≈ Safari but not identical. For strict Safari, use safaridriver on macOS.

---

## Example end-to-end

```bash
# 1) Generate
./make-variants-config.sh ./image/files/source.png out bench.config.json

# 2) Run with internal server (relative URLs) and 7 runs
node progressive-image-bench3.mjs bench.config.json --root "$(pwd)" --runs 7

# 3) View results
open bench-results/*/dashboard.html   # macOS
```

---

## License

MIT (or your preferred license).
