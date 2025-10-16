# ABOUT

## What this is

A compact toolkit to **generate image variants**, **run cross-browser progressive-render benchmarks** (Chromium, Firefox, WebKit), and **visualize** results (t85, t95, Visual Index) in an interactive dashboard. It uses an **internal throttled Node HTTP server** (chunked streaming) to reveal progressive decoding behavior consistently across engines.

# Example Report
<img width="1209" height="1141" alt="Screenshot 2025-10-16 at 22 49 20" src="https://github.com/user-attachments/assets/5ddb21ed-543d-4c46-87f3-14c3a36a7d18" />

---

## Components

* **`make-variants-config.sh`**
  Encodes a source image into:

  * JPEG **baseline** and **progressive**
  * **WebP**
  * **AVIF** (+ **progressive/layered**)
  * **JPEG XL** (+ **progressive**, if `cjxl` installed)
  * **PNG Adam7** (interlaced)
    Then writes a matching **`bench.config.json`** for the runner.

* **`progressive-image-bench-ui.mjs`**
  One Node script that:

  * Starts an **internal throttled server** (chunked streaming; no `Content-Length`) so images can paint progressively.
  * Runs **headed Playwright** across Chromium, Firefox, WebKit.
  * Captures only the **image region** at ~100–120 ms cadence.
  * Computes **t85**, **t95**, **Visual Index** per run.
  * Repeats tests for **N runs** (config/env/CLI controlled), aggregates median and p10/p90.
  * Records **server chunk traces** (timestamp + bytes).
  * Writes results to `bench-results/<timestamp>/` and opens a **Plotly** dashboard:

    * **Top row**: grouped **bar charts** (median t85, median t95, median Visual Index) — exactly **three bars per test** (one per browser).
    * **Bottom row**: **box-plots** (per-run distributions) for t85/t95/Visual Index.
    * Header shows **OS/CPU/RAM/Node**, **browser versions**, and **#runs**.

---

## Requirements

Install system tools, then Node deps inside the repo:

**macOS (Homebrew)**

```bash
brew install imagemagick webp libavif jpeg-xl jq
npm init -y
npm i -D playwright pixelmatch pngjs fs-extra date-fns
npx playwright install
```

> `jpeg-xl` is optional; if missing, JXL outputs/tests are skipped.
> Linux/Windows: install equivalents for ImageMagick (`magick`), `cwebp`, `avifenc`, `cjxl`, `jq`, and Node 18+.

---

## Quick start

### 1) Generate variants + config

```bash
./make-variants-config.sh ./image/files/source.png out bench.config.json
```

Optional encoder knobs and labels:

```bash
QJPEG=82 QWEBP=82 QAVIF=40 QJXL=1.2 LABEL_PREFIX="[test] " \
  ./make-variants-config.sh ./image/files/source.png out bench.config.json
```

This creates files in `out/` and a ready-to-run `bench.config.json`.

### 2) Run the benchmark + dashboard (internal server)

```bash
node progressive-image-bench-ui.mjs bench.config.json --root /absolute/path/to/repo
```

Control **run count** (overrides `runs` in config):

```bash
node progressive-image-bench-ui.mjs bench.config.json --root "$(pwd)" --runs 5
# or:
RUNS=5 node progressive-image-bench-ui.mjs bench.config.json --root "$(pwd)"
```

Artifacts appear under `bench-results/<timestamp>/` and the dashboard opens automatically.

---

## Config reference (matches current code)

**Example `bench.config.json`:**

```json
{
  "render": {
    "bg": "#ffffff",
    "fit": "contain"
  },
  "network": {
    "throttle": true,
    "latency": 200,
    "downKbps": 750,
    "upKbps": 250,
    "server": {
      "chunkBytes": 16384,
      "chunkDelayMs": 60
    }
  },
  "runs": 1,
  "tests": [
    {
      "id": "jpeg-baseline",
      "label": "JPEG Baseline",
      "format": "jpeg",
      "url": "out/source.baseline.jpg",
      "notes": ""
    },
    {
      "id": "jpeg-progressive",
      "label": "JPEG Progressive",
      "format": "jpeg",
      "url": "out/source.progressive.jpg",
      "notes": ""
    },
    {
      "id": "webp",
      "label": "WebP",
      "format": "webp",
      "url": "out/source.webp",
      "notes": ""
    },
    {
      "id": "avif",
      "label": "AVIF",
      "format": "avif",
      "url": "out/source.avif",
      "notes": ""
    },
    {
      "id": "avif-progressive",
      "label": "AVIF (progressive)",
      "format": "avif",
      "url": "out/source.progressive.avif",
      "notes": "single-input progressive"
    },
    {
      "id": "jxl",
      "label": "JPEG XL",
      "format": "jxl",
      "url": "out/source.jxl",
      "notes": ""
    },
    {
      "id": "jxl-progressive",
      "label": "JPEG XL (progressive)",
      "format": "jxl",
      "url": "out/source.progressive.jxl",
      "notes": ""
    },
    {
      "id": "png-interlaced",
      "label": "PNG (Adam7)",
      "format": "png",
      "url": "out/source.interlaced.png",
      "notes": ""
    }
  ]
}
```

**Fields**

* `render.bg`, `render.fit` — page background and `<img>` object-fit.
* `network.throttle` — if `true`, applies **Chromium CDP throttling** (latency/bw). Firefox/WebKit rely on the chunked server behavior.
* `network.latency`, `downKbps`, `upKbps` — Chromium network emulation when `throttle: true`.
* `network.server.chunkBytes`, `network.server.chunkDelayMs` — internal server’s **chunk size** and **delay per chunk** (controls progressive staging).
* `runs` — number of repetitions per test (can be overridden by `--runs` or `RUNS`).
* `tests[].{id,label,format,url,notes}` — test cases. Relative `url` paths are served by the internal server under `--root`.

---

## How it works (methods)

* Minimal harness page with a single centered `<img>`.
* Capture a **timeline of screenshots of just the image box** at ~100–120 ms.
* **Visual completeness** = similarity(current frame, final frame) via `pixelmatch`.
* Metrics:

  * **t85** — time to reach 85% completeness (lower is better).
  * **t95** — time to reach 95% completeness (lower is better).
  * **Visual Index** — normalized area above the completeness curve (0..1; lower is better). Reflects overall speed to converge, not only a threshold.
* Internal Node server serves images **chunked** with a fixed cadence to force incremental decode/paint without buffering or `Content-Length`.

---

## Reading results

* `bench-results/<timestamp>/dashboard.html` — interactive dashboard:

  * **Grouped bars** (median t85/t95/VI): exactly three bars per test (Chromium/Firefox/WebKit).
  * **Box-plots**: per-run distributions per browser/test.
  * **Meta** header: OS/CPU/RAM/Node, **browser versions**, run count.
* `bench-results/<timestamp>/summary.csv` — aggregated stats per (browser, test).
* `bench-results/<timestamp>/aggregated.json` — same as CSV with arrays and percentiles.
* `bench-results/<timestamp>/per-run.json` — raw per-run metrics.
* `bench-results/<timestamp>/server.traces.json` — streamed chunk timings/bytes.
* Per-run JSONs: `bench-results/<timestamp>/<browser>-<id>-runN.json`.

---

## Repro & tuning tips

* Keep **source dimensions identical** across formats.
* Prefer the **internal server** for consistent progressive delivery.
* Adjust `network.server.chunkBytes/chunkDelayMs` to create more/less visible stages.
* Disable caches (the runner injects `Cache-Control: no-cache`).
* Use `--runs` (or `RUNS`) ≥ 5 for stable medians and clean box-plots.

---

## Troubleshooting

* **Charts overlap or resize oddly**: the dashboard sets explicit heights, uses `ResizeObserver` and `IntersectionObserver`, and resizes on orientation change; open the HTML directly if your default browser blocks scripts.
* **No progressive effect**: verify chunked responses (no `Content-Length`), non-buffering path, and adequate `chunkDelayMs`.
* **Headers already sent**: the provided server writes headers exactly once; avoid custom middleware that re-writes them.

---

## Example end-to-end

```bash
# 1) Generate
./make-variants-config.sh ./image/files/source.png out bench.config.json

# 2) Run (internal server)
node progressive-image-bench-ui.mjs bench.config.json --root "$(pwd)" --runs 5

# 3) View results
open bench-results/*/dashboard.html   # macOS
```

# Example Run
<img width="1075" height="805" alt="Screenshot 2025-10-16 at 22 51 00" src="https://github.com/user-attachments/assets/bfb15573-b8b0-4bdd-853d-aaec411873d3" />


---

## License

MIT (or your preferred license).
