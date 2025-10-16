# browsers-research-tools
Tools to test the browsers

<img width="723" height="563" alt="Screenshot 2025-10-16 at 15 41 05" src="https://github.com/user-attachments/assets/c245f176-8e4c-49aa-b756-25e77206217a" />
<img width="714" height="504" alt="Screenshot 2025-10-16 at 15 41 12" src="https://github.com/user-attachments/assets/accec264-3ac9-4928-9bad-c81defce75b5" />
<img width="707" height="497" alt="Screenshot 2025-10-16 at 15 41 17" src="https://github.com/user-attachments/assets/3952f6c2-a7ab-4bb6-b33e-65d402343a5e" />
<img width="710" height="1101" alt="Screenshot 2025-10-16 at 15 41 26" src="https://github.com/user-attachments/assets/4a30dbd0-a635-4aae-a0a4-438389746c27" />




Single-file, cross-browser Playwright script that:

* loads your image test cases in **Chromium, Firefox, and WebKit (Safari engine)**
* captures a **timeline of screenshots** while the image loads
* computes **visual completeness over time** (Speed-Index-style) with `pixelmatch`
* writes a **Markdown + CSV summary** you can paste into research notes

> Works headless on Ubuntu CI/servers. WebKit ≈ Safari; for true Safari on macOS, see note at the end.

---

### 1) Save as `progressive-image-bench.mjs`

```js
#!/usr/bin/env node
/* progressive-image-bench.mjs
 * Automated progressive-image benchmarks across Chromium, Firefox, WebKit.
 * Captures visual progress over time and writes CSV + Markdown summary.
 *
 * Usage:
 *   1) node progressive-image-bench.mjs init             # creates bench.config.json
 *   2) node progressive-image-bench.mjs run bench.config.json
 *
 * Requires:
 *   npm i -D playwright pixelmatch pngjs fs-extra date-fns
 *   npx playwright install  # installs all 3 browser engines
 */

import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { chromium, firefox, webkit, devices } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { formatISO } from "date-fns";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BROWSERS = [
  { name: "chromium", launcher: chromium },
  { name: "firefox", launcher: firefox },
  { name: "webkit", launcher: webkit }, // Safari engine
];

const DEFAULT_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };
const SNAPSHOT_INTERVAL_MS = 120;       // capture cadence
const MAX_CAPTURE_MS = 8000;            // budget per test (tweak if needed)
const QUIET_PERIOD_MS = 600;            // time with no change considered "done"
const OUT_DIR = path.resolve(process.cwd(), "bench-results");

// Basic HTML harness that paints a single <img>, centered.
// Disables CSS filtering etc. to keep comparisons clean.
const HARNESS_HTML = ({ url, bg = "#ffffff", fit = "contain" }) => `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate, max-age=0">
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  html, body { height: 100%; margin: 0; background: ${bg}; }
  .wrap { display:flex; align-items:center; justify-content:center; height:100%; }
  img { max-width:95vw; max-height:95vh; object-fit:${fit}; image-rendering:auto; }
</style>
</head><body>
<div class="wrap">
  <img id="tgt" src="${url}" decoding="auto" loading="eager" />
</div>
<script>
  const img = document.getElementById('tgt');
  // Signal when the image finishes decoding (best-effort cross-browser)
  let done = false;
  function markDone(){ if(!done){ done = true; } }
  img.addEventListener('load', markDone);
  img.addEventListener('error', markDone);
  // Keep the page alive for the test runner; nothing else to do here.
</script>
</body></html>`;

function ensureDir(p) { return fs.mkdirp(p); }

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// Compare two PNG buffers; returns number 0..1 of visual similarity.
function similarity(bufA, bufB) {
  const imgA = PNG.sync.read(bufA);
  const imgB = PNG.sync.read(bufB);
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    throw new Error("Dimension mismatch between screenshots");
  }
  const { width, height } = imgA;
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(imgA.data, imgB.data, diff.data, width, height, {
    threshold: 0.1, includeAA: true,
  });
  const total = width * height;
  return 1 - mismatched / total;
}

// Convert a sequence of screenshots to visual progress vs time.
// Returns { samples: [{t, completeness}], t85, t95, visIndex }
function computeVisualProgress(timeline) {
  // Use last frame as “final”
  const finalFrame = timeline[timeline.length - 1].png;
  const samples = timeline.map(({ t, png }) => {
    const sim = similarity(png, finalFrame); // 0..1
    return { t, completeness: +sim.toFixed(4) };
  });

  // Visual Index (discrete approximation, lower is better)
  // Sum over (1 - completeness) * dt normalized to total time
  const t0 = samples[0].t;
  const tEnd = samples[samples.length - 1].t;
  let area = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    // left Riemann sum
    area += (1 - samples[i - 1].completeness) * dt;
  }
  const visIndex = +(area / (tEnd - t0)).toFixed(4);

  const t85 = samples.find(s => s.completeness >= 0.85)?.t ?? null;
  const t95 = samples.find(s => s.completeness >= 0.95)?.t ?? null;

  return { samples, t85, t95, visIndex };
}

async function runOne(page, url, opts) {
  // Build a data: URL for the harness to avoid external servers for HTML.
  const html = HARNESS_HTML({ url, ...opts });
  const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(html);

  const tStart = Date.now();
  await page.goto(dataUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Aggressive: disable cache and enable request interception to bust caches.
  await page.context().route("**/*", (route) => {
    const headers = { ...route.request().headers(), "Cache-Control": "no-cache" };
    route.continue({ headers }).catch(() => {});
  });

  // Snapshot loop
  const timeline = [];
  let lastChangeAt = Date.now();
  let lastPng = null;

  while (Date.now() - tStart < MAX_CAPTURE_MS) {
    const png = await page.screenshot({ fullPage: true });
    if (!lastPng || similarity(png, lastPng) < 0.999) {
      lastChangeAt = Date.now();
      lastPng = png;
    }
    timeline.push({ t: Date.now() - tStart, png });

    // Heuristic exit: quiet for some time and image is complete
    const isImgComplete = await page.evaluate(() => {
      const img = document.getElementById('tgt');
      return !!img && img.complete && img.naturalWidth > 0;
    });

    if (isImgComplete && Date.now() - lastChangeAt > QUIET_PERIOD_MS) break;
    await sleep(SNAPSHOT_INTERVAL_MS);
  }

  return computeVisualProgress(timeline);
}

async function runSuite(configPath) {
  const config = await fs.readJson(configPath);
  const stamp = formatISO(new Date()).replace(/[:]/g, "-");
  const runDir = path.join(OUT_DIR, stamp);
  await ensureDir(runDir);

  // Write a copy of the config used
  await fs.writeJson(path.join(runDir, "config.used.json"), config, { spaces: 2 });

  const results = [];
  for (const browser of BROWSERS) {
    const browserName = browser.name;
    console.log(`\n==> ${browserName.toUpperCase()} ===================`);
    const b = await browser.launcher.launch({ headless: true });
    const ctx = await b.newContext({
      viewport: DEFAULT_VIEWPORT,
      deviceScaleFactor: DEFAULT_VIEWPORT.deviceScaleFactor,
      bypassCSP: true,
    });
    const page = await ctx.newPage();

    // Optional: network throttling (Chromium only via CDP)
    if (browserName === "chromium" && config.network?.throttle) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: config.network.latency ?? 150,           // ms
        downloadThroughput: config.network.downKbps ? config.network.downKbps * 1024 / 8 : 200 * 1024 / 8,
        uploadThroughput: config.network.upKbps ? config.network.upKbps * 1024 / 8 : 50 * 1024 / 8,
        connectionType: "cellular3g",
      });
    }

    for (const tc of config.tests) {
      // Each test case should include: id, url, label, format, notes
      const { id, url, label = "", format = "", notes = "" } = tc;
      console.log(`  • ${id} – ${label || url}`);

      const r = { browser: browserName, id, label, format, notes };
      try {
        const res = await runOne(page, url, config.render || {});
        Object.assign(r, res);
      } catch (err) {
        r.error = String(err && err.message ? err.message : err);
      }

      // Save per-test JSON and sparklines data
      const testDir = path.join(runDir, `${browserName}-${id}`);
      await ensureDir(testDir);
      await fs.writeJson(path.join(testDir, "result.json"), r, { spaces: 2 });
      results.push(r);
    }

    await ctx.close();
    await b.close();
  }

  // Write CSV + Markdown
  const csvPath = path.join(runDir, "summary.csv");
  const mdPath = path.join(runDir, "summary.md");

  const headers = [
    "browser","id","label","format","t85_ms","t95_ms","visual_index","notes","error"
  ];
  const rows = [headers.join(",")];
  for (const r of results) {
    const row = [
      r.browser, r.id, q(r.label), r.format,
      n(r.t85), n(r.t95), n(r.visIndex), q(r.notes), q(r.error || "")
    ].join(",");
    rows.push(row);
  }
  await fs.writeFile(csvPath, rows.join("\n"), "utf8");

  const md = [
    `# Progressive Image Bench – ${stamp}\n`,
    `Config: \`${path.basename(configPath)}\`\n`,
    `\n| Browser | ID | Label | Format | t85 (ms) | t95 (ms) | VisualIdx | Notes |`,
    `|---|---|---|---:|---:|---:|---:|---|`,
    ...results.map(r => `| ${r.browser} | ${r.id} | ${esc(r.label)} | ${r.format} | ${n(r.t85)} | ${n(r.t95)} | ${n(r.visIndex)} | ${esc(r.notes)} |`)
  ].join("\n");
  await fs.writeFile(mdPath, md, "utf8");

  console.log(`\nWrote:\n  ${csvPath}\n  ${mdPath}\n  ${runDir}/<browser>-<id>/result.json`);
}

function n(v){ return (v==null || Number.isNaN(v)) ? "" : Math.round(Number(v)); }
function q(s){ return `"${String(s ?? "").replace(/"/g,'""')}"`; }
function esc(s){ return String(s ?? "").replace(/\|/g,"\\|"); }

async function main() {
  const [,, cmd, arg] = process.argv;
  if (cmd === "init") {
    const sample = {
      render: { bg: "#ffffff", fit: "contain" },
      network: {
        throttle: true,      // Chromium-only CDP throttling
        latency: 200,        // ms
        downKbps: 750,       // approximate 3G Fast
        upKbps: 250
      },
      tests: [
        // Replace these with your assets. Ensure each URL points to the EXACT encoding variant.
        { id: "jpeg-baseline", label: "JPEG Baseline", format: "jpeg", url: "https://example.com/path/baseline.jpg", notes: "" },
        { id: "jpeg-progressive", label: "JPEG Progressive", format: "jpeg", url: "https://example.com/path/progressive.jpg", notes: "" },
        { id: "webp", label: "WebP", format: "webp", url: "https://example.com/path/image.webp", notes: "" },
        { id: "avif", label: "AVIF (layered)", format: "avif", url: "https://example.com/path/image.avif", notes: "layered/tiling if available" },
        { id: "jxl", label: "JPEG XL", format: "jxl", url: "https://example.com/path/image.jxl", notes: "Safari-only if supported" }
      ]
    };
    const p = path.join(process.cwd(), "bench.config.json");
    await fs.writeJson(p, sample, { spaces: 2 });
    console.log(`Created ${p}. Edit the URLs, then run:\n  node ${path.basename(process.argv[1])} run bench.config.json`);
    return;
  }
  if (cmd === "run" && arg) {
    await ensureDir(OUT_DIR);
    await runSuite(arg);
    return;
  }
  console.log(`Usage:
  node ${path.basename(process.argv[1])} init
  node ${path.basename(process.argv[1])} run bench.config.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

---

### 2) Install deps

```bash
npm init -y
npm i -D playwright pixelmatch pngjs fs-extra date-fns
npx playwright install
```

### 3) Create and edit config

```bash
node progressive-image-bench.mjs init
# edit bench.config.json — point URLs at:
#  • a baseline JPEG
#  • a progressive JPEG of the same image
#  • WebP, AVIF (prefer layered/tiled variant), and JXL (if your Safari build supports it)
```

> Tip: host these assets yourself so you control exact encodings. For JPEG/WebP, explicitly create progressive vs baseline encodes; for AVIF, export a layered encode if your encoder supports it.

### 4) Run

```bash
node progressive-image-bench.mjs run bench.config.json
```

Outputs:

* `bench-results/<timestamp>/summary.csv`
* `bench-results/<timestamp>/summary.md`
* Per-test JSON in `bench-results/<timestamp>/<browser>-<id>/result.json`

### What the metrics mean

* **t85 / t95**: time to reach 85% / 95% visual completeness vs the final frame.
* **VisualIdx**: lower is better; integral of “how incomplete” the page looks over time (Speed-Index-like).

### How this maps to your research notes

* “JPEG & WebP progressive renders worse in Safari” → expect **higher t85/t95 and VisualIdx** on **WebKit** for the progressive variants compared to Chromium/Firefox.
* “AVIF *does* support progressive” → if the AVIF is layered/tiling, WebKit/Chromium showing **lower t85** than baseline/one-shot encodes supports the claim.
* “JPEG XL in Safari” → include a JXL asset and see WebKit’s times; if unsupported it will error—kept in the CSV with an `error` column.

---

### Safari (real) on macOS

WebKit in Playwright is close, but if policy requires **Safari proper**:

* Use **safaridriver** + WebDriver and a similar harness to grab screenshots.
* Or run this same script on macOS with `webkit` to approximate Safari Tech Preview.

---

### Notes / limitations

* True progressive perception depends on **server transfer** behavior (chunking). Host images with HTTP/2 and no `Content-Length` to encourage early paint, or simulate constrained bandwidth via Chromium CDP throttling (already included).
* For **apples-to-apples**, test the **same pixel dimensions** across encodes.
* If images are cached upstream, append a cache-buster query (e.g., `?r=${Date.now()}`) in your config URLs.

This gives a reproducible, cross-engine harness that turns what you observed into numbers you can publish in a concise table.
