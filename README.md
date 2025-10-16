# ABOUT

## What this is

A small toolkit to **generate image variants** (baseline/progressive encodings), **run cross-browser progressive-render benchmarks** (Chromium, Firefox, WebKit), and **visualize results** in an interactive dashboard.

Use cases:

* Validate assumptions about progressive rendering (JPEG, WebP, AVIF, JXL).
* Compare engines (Chromium/Firefox/WebKit) on the same assets.
* Produce reproducible metrics (t85/t95/Visual Index) and a human-readable report.

Example Results

#image/

<img width="723" height="563" alt="Screenshot 2025-10-16 at 15 41 05" src="https://github.com/user-attachments/assets/c245f176-8e4c-49aa-b756-25e77206217a" />
<img width="714" height="504" alt="Screenshot 2025-10-16 at 15 41 12" src="https://github.com/user-attachments/assets/accec264-3ac9-4928-9bad-c81defce75b5" />
<img width="707" height="497" alt="Screenshot 2025-10-16 at 15 41 17" src="https://github.com/user-attachments/assets/3952f6c2-a7ab-4bb6-b33e-65d402343a5e" />
<img width="710" height="1101" alt="Screenshot 2025-10-16 at 15 41 26" src="https://github.com/user-attachments/assets/4a30dbd0-a635-4aae-a0a4-438389746c27" />

---

## Components

* `make-variants-config.sh`
  Bash script that encodes one source image into:

  * JPEG **baseline** & **progressive**
  * WebP
  * AVIF (+ **progressive**/layered)
  * JPEG XL (+ **progressive**, if `cjxl` installed)
  * PNG Adam7 (interlaced)
    It then **writes a matching `bench.config.json`** pointing at the generated files.

* `progressive-image-bench-ui.mjs`
  Single Node script that:

  * starts an **internal throttled HTTP server** (chunked streaming) to trigger progressive paint,
  * runs **headed Playwright** across Chromium, Firefox, and WebKit,
  * measures **visual completeness over time** and computes **t85 / t95 / Visual Index**,
  * writes `bench-results/<timestamp>/{summary.csv,dashboard.html,...}`,
  * opens an interactive **Plotly** dashboard.

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

> `jpeg-xl` is optional—if missing, JXL outputs/tests are skipped.

---

## Quick start

### 1) Generate variants + config

From the repo root (the folder containing `image/files/source.png` for example):

```bash
./make-variants-config.sh ./image/files/source.png out bench.config.json
```

Environment knobs (optional):

```bash
QJPEG=82 QWEBP=82 QAVIF=40 QJXL=1.2 LABEL_PREFIX="[test] " ./make-variants-config.sh ./image/files/source.png out bench.config.json
```

* Outputs go to `out/` (e.g., `source.baseline.jpg`, `source.progressive.jpg`, `source.webp`, `source.avif`, `source.progressive.avif`, `source.jxl`, `source.progressive.jxl`, `source.interlaced.png`).
* `bench.config.json` is created to reference those files.

**Absolute URLs instead of relative:**
Start an external server and set `BASE_URL`, e.g.:

```bash
python3 -m http.server 5173  # serve the repo folder
BASE_URL="http://127.0.0.1:5173" ./make-variants-config.sh ./image/files/source.png out bench.config.json
```

### 2) Run the benchmarks with UI and dashboard

**Single-terminal run** using the script’s internal server (recommended):

```bash
node progressive-image-bench-ui.mjs bench.config.json --root /absolute/path/to/repo
```

* Three headed browser windows will load each image (watch the progressive stages).
* Results are saved under `bench-results/<timestamp>/`.
* A Plotly **dashboard** opens automatically.

**Using absolute URLs (external server):**

```bash
node progressive-image-bench-ui.mjs bench.config.json
```

---

## Methods (how metrics are computed)

* The page shows a single `<img>` centered on a neutral background.
* A **timeline of full-page screenshots** is captured at ~120 ms cadence.
* **Visual completeness** per frame = similarity(current, final) via `pixelmatch`.
* Metrics:

  * **t85**: time to reach 85% visual completeness.
  * **t95**: time to reach 95% visual completeness.
  * **Visual Index**: area under the curve of “incompleteness” over time (lower is better).
* Network:

  * An internal Node server **streams chunked responses** without `Content-Length` and with a small per-chunk delay to enable progressive paint.
  * Optional **Chromium CDP throttling** simulates constrained bandwidth/latency; WebKit/Firefox rely on server chunking.

---

## Reading results

* `bench-results/<timestamp>/dashboard.html` — interactive chart:

  * Grouped bar charts for **t85**, **t95**, and **Visual Index** by browser and test id.
  * A summary table with **browser, id, label, format, t85, t95, visual_index, notes, error**.
* `bench-results/<timestamp>/summary.csv` — same data in CSV form.
* Per-test JSON dumps for downstream analysis: `bench-results/<timestamp>/<browser>-<id>.json`.

---

## Typical findings to validate

These reflect common observations the suite is designed to verify—actual outcomes depend on encodes, servers, and browser versions:

* **JPEG progressive vs baseline**: progressive usually shows earlier perceived detail; verify **lower t85/VisualIndex** for progressive.
* **WebP**: no “progressive flag”, but **incremental decoding** can still show early paint if data arrives in chunks.
* **AVIF**: **progressive/layered** encodes can reduce t85 in supporting engines; compare `avif` vs `avif-progressive`.
* **JPEG XL**: supports progressive DC/AC refinement; confirm with `jxl` vs `jxl-progressive` if the decoder enables progressive display.

---

## Repro tips

* Use the **same source image** across formats and the **same pixel dimensions**.
* Turn off caches by default (the runner injects `Cache-Control: no-cache`).
* Keep server **chunk sizes** and delays consistent across runs.
* For “over-the-wire” realism, prefer the built-in server; external static servers often buffer and defeat progressive paint.

---

## Troubleshooting

* **Dashboard didn’t open**: open `bench-results/<timestamp>/dashboard.html` manually.
* **ERR_HTTP_HEADERS_SENT**: use the provided `startThrottledServer` (sends headers once).
* **No progressive effect**: ensure images are served without `Content-Length` and with chunked streaming; avoid CDN buffering.
* **WebKit vs Safari differences**: Playwright WebKit ≈ Safari, but not identical. For strict Safari results, run a companion safaridriver/WebDriver harness on macOS.

---

## Folder layout (suggested)

```
.
├─ make-variants-config.sh
├─ progressive-image-bench-ui.mjs
├─ bench.config.json                # generated or hand-edited
├─ out/                              # generated image variants
└─ bench-results/
   └─ 2025-10-16T14-53-24+01-00/
      ├─ config.used.json
      ├─ summary.csv
      ├─ dashboard.html
      ├─ chromium-jpeg-progressive.json
      └─ ...
```

---

## Example end-to-end

```bash
# 1) Generate
./make-variants-config.sh ./image/files/source.png out bench.config.json

# 2) Run with internal server (relative URLs)
node progressive-image-bench-ui.mjs bench.config.json --root "$(pwd)"

# 3) View results
open bench-results/*/dashboard.html  # macOS
```

---

## Extending

* Add more test cases to `bench.config.json` (e.g., different qualities, dimensions).
* Pin server knobs by editing `progressive-image-bench-ui.mjs`:

  * `chunkBytes` (default 16 KiB), `chunkDelayMs` (default 60 ms).
* Export more metrics (e.g., **t50**, **first-render**) by extending `computeVisualProgress`.
* Integrate into CI by running headless and archiving `bench-results/` artifacts (dashboard still opens locally when run headed).

---

## License

MIT (or add your preferred license).

