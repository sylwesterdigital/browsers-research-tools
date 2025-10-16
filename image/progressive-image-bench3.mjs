#!/usr/bin/env node
/**
 * progressive-image-bench-ui.mjs
 *
 * One-command UX:
 *  - Launches an internal throttled HTTP server (chunked streaming) so images render progressively.
 *  - Runs headed Playwright across Chromium, Firefox, WebKit so you can watch the loads.
 *  - Captures multiple runs per test, clips to the <img> region, computes t85/t95 and Visual Index,
 *    aggregates with median and percentiles, records server byte/timestamp traces.
 *  - Generates an interactive Plotly dashboard and opens it.
 *    IMPORTANT: the top row shows 3× grouped BAR charts (median t85, median t95, median Visual Index)
 *    so you always see exactly three bars per test (one per browser). Box-plots are grouped below.
 *
 * Usage:
 *   node progressive-image-bench-ui.mjs bench.config.json --root /path/to/assets [--runs 7]
 *
 * Deps:
 *   npm i -D playwright pixelmatch pngjs fs-extra date-fns
 *   npx playwright install
 *   (no need for the 'open' package; uses OS open fallback)
 *
 * Config (bench.config.json) supports:
 *   {
 *     "render": { "bg": "#ffffff", "fit": "contain" },
 *     "network": {
 *       "throttle": true, "latency": 200, "downKbps": 750, "upKbps": 250,
 *       "server": { "chunkBytes": 16384, "chunkDelayMs": 60 }
 *     },
 *     "runs": 5,
 *     "tests": [ { "id": "...", "label": "...", "format": "jpeg|webp|avif|jxl|png", "url": "...", "notes": "" } ]
 *   }
 *
 * Runs precedence (highest wins): CLI --runs  →  RUNS env var  →  config.runs  →  default (5)
 */

import http from "http";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { chromium, firefox, webkit } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { formatISO } from "date-fns";
import { execFile } from "node:child_process";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------ CLI & Paths ------------------------ */
const [, , cfgPath, ...argvRest] = process.argv;
if (!cfgPath) {
  console.log("Usage:\n  node progressive-image-bench-ui.mjs bench.config.json --root /path/to/assets [--runs 7]");
  process.exit(1);
}
const args = Object.fromEntries(
  argvRest.reduce((acc, v, i, a) => {
    if (v.startsWith("--")) acc.push([v.replace(/^--/, ""), a[i + 1]?.startsWith("--") ? true : a[i + 1]]);
    return acc;
  }, [])
);
const ASSET_ROOT = path.resolve(args.root || process.cwd());

const BROWSERS = [
  { name: "chromium", launcher: chromium },
  { name: "firefox", launcher: firefox },
  { name: "webkit", launcher: webkit },
];

const DEFAULT_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };
const SNAPSHOT_INTERVAL_MS = 100;
const MAX_CAPTURE_MS = 12000;
const QUIET_PERIOD_MS = 700;
const OUT_DIR = path.resolve(process.cwd(), "bench-results");

/* ------------------------ Throttled HTTP Server ------------------------ */
function startThrottledServer({ port = 0, chunkBytes = 16 * 1024, chunkDelayMs = 60 } = {}) {
  const traces = [];
  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const record = { path: (req.url || "/").replace(/\?.*$/, ""), startedAt, chunks: [], totalBytes: 0 };
    try {
      const clean = record.path;
      if (clean === "/" || clean === "/favicon.ico") { res.statusCode = 204; res.end(); return; }

      const urlPath = decodeURIComponent(clean);
      const filePath = path.normalize(path.join(ASSET_ROOT, urlPath));
      if (!filePath.startsWith(ASSET_ROOT)) { res.statusCode = 403; res.end("Forbidden"); return; }
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat || !stat.isFile()) { res.statusCode = 404; res.end("Not found"); return; }

      res.statusCode = 200;
      res.setHeader("Content-Type", guessContentType(filePath));
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "HEAD") { res.end(); return; }
      res.flushHeaders?.();

      const stream = fs.createReadStream(filePath, { highWaterMark: chunkBytes });
      stream.on("data", chunk => {
        record.totalBytes += chunk.length;
        record.chunks.push({ t: Date.now() - startedAt, n: chunk.length });
        res.write(chunk);
        stream.pause();
        setTimeout(() => stream.resume(), chunkDelayMs);
      });
      stream.on("end", () => { res.end(); traces.push(record); });
      stream.on("error", () => {
        if (!res.headersSent) { res.statusCode = 500; res.end("Error"); }
        else { try { res.end(); } catch {} }
        traces.push(record);
      });
    } catch {
      if (!res.headersSent) { res.statusCode = 500; res.end("Error"); }
      else { try { res.end(); } catch {} }
      traces.push(record);
    }
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, traces })));
}

function guessContentType(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".avif") return "image/avif";
  if (ext === ".jxl") return "image/jxl";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

/* ------------------------ Visual Metrics ------------------------ */
function similarity(bufA, bufB) {
  const imgA = PNG.sync.read(bufA);
  const imgB = PNG.sync.read(bufB);
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) throw new Error("Dimension mismatch");
  const { width, height } = imgA;
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(imgA.data, imgB.data, diff.data, width, height, { threshold: 0.1, includeAA: true });
  const total = width * height;
  return 1 - mismatched / total;
}

function computeVisualProgress(timeline) {
  if (!timeline?.length) return { samples: [], t85: null, t95: null, visIndex: 0 };
  if (timeline.length === 1) return { samples: [{ t: 0, completeness: 1 }], t85: 0, t95: 0, visIndex: 0 };

  const finalFrame = timeline[timeline.length - 1].png;
  const samples = timeline.map(({ t, png }) => {
    const sim = similarity(png, finalFrame);
    const c = Math.min(1, Math.max(0, sim));
    return { t, completeness: +c.toFixed(4) };
  });

  const t0 = samples[0].t;
  const tEnd = samples[samples.length - 1].t;
  if (tEnd <= t0) return { samples, t85: 0, t95: 0, visIndex: 0 };

  let area = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    area += (1 - samples[i - 1].completeness) * dt;
  }
  const visIndex = area / (tEnd - t0);

  const t85 = samples.find(s => s.completeness >= 0.85)?.t ?? null;
  const t95 = samples.find(s => s.completeness >= 0.95)?.t ?? null;

  return { samples, t85, t95, visIndex: +visIndex.toFixed(4) };
}

/* ------------------------ Page Harness ------------------------ */
const HARNESS_HTML = ({ url, bg = "#ffffff", fit = "contain" }) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  html, body { height: 100%; margin: 0; background: ${bg}; }
  .wrap { display:flex; align-items:center; justify-content:center; height:100%; }
  img { max-width:95vw; max-height:95vh; object-fit:${fit}; image-rendering:auto; }
  .tip { position:fixed; top:8px; left:12px; font:14px/1.4 system-ui; color:#444; background:rgba(255,255,255,.8); padding:6px 10px; border-radius:8px; }
</style></head>
<body>
<div class="wrap"><img id="tgt" src="${url}" decoding="auto" loading="eager" /></div>
<div class="tip">Loading: ${url}</div>
</body></html>`;

/* ------------------------ Bench Runner ------------------------ */
async function runOne(page, url, opts) {
  const html = HARNESS_HTML({ url, ...opts });
  const tStart = Date.now();
  await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Clip to the <img> region so we measure only image progress
  const bbox = await page.evaluate(() => {
    const el = document.getElementById('tgt');
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: r.width, height: r.height, dpr: window.devicePixelRatio || 1 };
  });
  const clip = {
    x: Math.floor(bbox.x * bbox.dpr),
    y: Math.floor(bbox.y * bbox.dpr),
    width: Math.max(1, Math.ceil(bbox.width * bbox.dpr)),
    height: Math.max(1, Math.ceil(bbox.height * bbox.dpr))
  };

  const timeline = [];
  let lastChangeAt = Date.now();
  let lastPng = null;
  await new Promise(r => setTimeout(r, 50));

  while (Date.now() - tStart < MAX_CAPTURE_MS) {
    const png = await page.screenshot({ clip });
    if (!lastPng || similarity(png, lastPng) < 0.999) { lastChangeAt = Date.now(); lastPng = png; }
    timeline.push({ t: Date.now() - tStart, png });

    const isImgComplete = await page.evaluate(() => {
      const img = document.getElementById('tgt');
      return !!img && img.complete && img.naturalWidth > 0;
    });

    if (isImgComplete && Date.now() - lastChangeAt > QUIET_PERIOD_MS) break;
    await new Promise(r => setTimeout(r, SNAPSHOT_INTERVAL_MS));
  }

  return computeVisualProgress(timeline);
}

function n(v){ return (v==null || Number.isNaN(v)) ? "" : Math.round(Number(v)); }
function median(arr){ const a = arr.slice().sort((x,y)=>x-y); const m = a.length; return m? (m%2?a[(m-1)/2]:(a[m/2-1]+a[m/2])/2):null; }
function percentile(arr, p){ if(!arr.length) return null; const a = arr.slice().sort((x,y)=>x-y); const idx = (p/100)*(a.length-1); const lo = Math.floor(idx), hi = Math.ceil(idx); if(lo===hi) return a[lo]; const w = idx-lo; return a[lo]*(1-w)+a[hi]*w; }

/* ------------------------ Dashboard HTML ------------------------ */
function buildDashboardHTML({ stamp, configName, aggregated, meta }) {
  const dataAgg = JSON.stringify(aggregated);
  const env = JSON.stringify(meta);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Progressive Image Bench – ${stamp}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
<style>
  :root { --card-min-h: 340px; }
  html, body { height: 100%; }
  body { font: 14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui; margin: 16px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  .grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
  .card { padding: 12px; border: 1px solid #e3e3e3; border-radius: 10px; background: #fff; }
  .plot { width: 100%; min-height: var(--card-min-h); }
  .table { border-collapse: collapse; width: 100%; font-size: 13px; }
  .table th, .table td { border-bottom: 1px solid #eee; padding: 6px 8px; text-align: left; }
  .small { color:#666; font-size:12px; }
  .kv { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:10px; }
  .kv div { background:#f7f7f7; border-radius:8px; padding:6px 8px; }
  @media (min-width: 1100px) { .grid { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<h1>Progressive Image Bench – ${stamp}</h1>
<div class="small">Config: <code>${configName}</code></div>

<div class="card" id="meta"></div>

<div class="grid">
  <div class="card"><div id="bar_t85" class="plot"></div></div>
  <div class="card"><div id="bar_t95" class="plot"></div></div>
  <div class="card"><div id="bar_vi"  class="plot"></div></div>
  <div class="card"><div id="box_t85" class="plot"></div></div>
  <div class="card"><div id="box_t95" class="plot"></div></div>
  <div class="card"><div id="box_vi"  class="plot"></div></div>
  <div class="card">
    <table class="table" id="summary"></table>
  </div>
</div>

<script>
const aggregated = ${dataAgg};
const meta = ${env};
const testOrder = [...new Set(aggregated.map(r => r.id))];

function renderMeta() {
  const m = document.getElementById('meta');
  const sys = meta.system;
  const vers = meta.versions;
  const osLine = sys.os_type + " " + sys.os_release + " (" + sys.os_platform + ", " + sys.os_arch + ")";
  const hwLine = sys.cpu_model + " ×" + sys.cpu_cores + " • " + sys.memory_gb + " GB RAM";
  const nodeLine = "Node " + meta.node + (meta.runs ? " • runs=" + meta.runs : "");
  const browsers = Object.entries(vers).map(([k,v]) => k + ": " + v).join(" • ");
  m.innerHTML = '<div class="kv">'
    + '<div><b>OS</b>: ' + osLine + '</div>'
    + '<div><b>HW</b>: ' + hwLine + '</div>'
    + '<div><b>Node</b>: ' + nodeLine + '</div>'
    + '<div><b>Browsers</b>: ' + browsers + '</div>'
    + '</div>';
}

/* -------- Grouped BAR charts (exactly three bars per test) -------- */
function barsFor(metricKey, elId, title, yTitle, isFloat=false) {
  const browsers = [...new Set(aggregated.map(r => r.browser))];
  const traces = browsers.map(b => {
    const rows = aggregated.filter(r => r.browser === b);
    const y = testOrder.map(id => {
      const row = rows.find(r => r.id === id);
      const v = row?.median?.[metricKey];
      if (v==null || Number.isNaN(Number(v))) return null;
      return isFloat ? Number(v) : Math.round(Number(v));
    });
    return {
      x: testOrder,
      y,
      name: b,
      type: 'bar',
      offsetgroup: b,
      hovertemplate: 'Browser: ' + b + '<br>Test: %{x}<br>' + title + ': %{y}' + (isFloat ? '' : ' ms') + '<extra></extra>'
    };
  });
  const layout = {
    title,
    barmode:'group',
    bargap: 0.15,
    bargroupgap: 0.08,
    xaxis:{ title:'Test', categoryarray: testOrder, categoryorder:'array' },
    yaxis:{ title:yTitle, rangemode:'tozero', tickformat: isFloat ? '.3f' : undefined },
    margin:{ t:40, r:10, b:60, l:50 }
  };
  Plotly.newPlot(elId, traces, layout, {displaylogo:false, responsive:true, useResizeHandler:true});
}

/* ---------------- Box-plots for full run distributions ----------------
 * FIX: Explicitly create a separate box trace PER (browser, testId) pair.
 *      This guarantees three side-by-side boxes for each category (no overlap).
 */
  
/* ---------------- Box-plots for full run distributions ----------------
 * One trace per browser. Each trace contains values for all tests with
 * x repeated per value so Plotly renders 3 side-by-side boxes per test.
 * This removes legend spam and prevents overlapping boxes.
 */
function boxPlot(metric, elId, title) {
  const browsers = [...new Set(aggregated.map(r => r.browser))];
  const traces = browsers.map(b => {
    const rows = aggregated.filter(r => r.browser === b);

    // Build x/y arrays: for each test ID, append that ID once per sample value
    const x = [];
    const y = [];
    for (const id of testOrder) {
      const row = rows.find(r => r.id === id);
      const vals = (row && row.dist && row.dist[metric]) ? row.dist[metric] : [];
      for (let i = 0; i < vals.length; i++) {
        x.push(id);
        y.push(vals[i]);
      }
    }

    return {
      x,
      y,
      name: b,
      type: 'box',
      boxpoints: 'outliers',
      offsetgroup: b,     // align groups consistently across categories
      legendgroup: b,
      showlegend: true,
      hovertemplate: 'Browser: ' + b + '<br>Test: %{x}<br>' + metric + ': %{y}<extra></extra>'
    };
  });

  const isVI = metric === 'visIndex';
  const layout = {
    title,
    boxmode: 'group',      // <- key for side-by-side per category
    xaxis: {
      title: 'Test ID',
      type: 'category',
      categoryarray: testOrder,
      categoryorder: 'array'
    },
    yaxis: {
      title: isVI ? 'index' : 'ms',
      rangemode: 'tozero',
      tickformat: isVI ? '.3f' : undefined
    },
    margin: { t: 40, r: 10, b: 60, l: 50 }
  };

  Plotly.newPlot(elId, traces, layout, {
    displaylogo: false,
    responsive: true,
    useResizeHandler: true
  });
}


  const isVI = metric === 'visIndex';
  const layout = {
    title,
    boxmode: 'group',            // side-by-side per x category
    xaxis: { title: 'Test ID', categoryarray: testOrder, categoryorder: 'array', type: 'category' },
    yaxis: { title: isVI ? 'index' : 'ms', rangemode:'tozero', tickformat: isVI ? '.3f' : undefined },
    margin: { t: 40, r: 10, b: 60, l: 50 }
  };
  Plotly.newPlot(elId, traces, layout, {displaylogo:false, responsive:true, useResizeHandler:true});
}

function drawTable() {
  const headers = ["browser","browser_version","id","label","format",
                   "median_t85","p10_t85","p90_t85",
                   "median_t95","p10_t95","p90_t95",
                   "median_visIndex","p10_visIndex","p90_visIndex",
                   "notes","n_runs","errors"];
  const tbl = document.getElementById('summary');
  const thead = document.createElement('thead'); const trh = document.createElement('tr');
  headers.forEach(h => { const th = document.createElement('th'); th.textContent = h; trh.appendChild(th); });
  thead.appendChild(trh);
  const tbody = document.createElement('tbody');

  const byBrowser = {};
  aggregated.forEach(r => { (byBrowser[r.browser] ||= []).push(r); });
  Object.keys(byBrowser).sort().forEach(b => {
    const rows = byBrowser[b].slice().sort((a,b) => testOrder.indexOf(a.id) - testOrder.indexOf(b.id));
    rows.forEach(r => {
      const tr = document.createElement('tr');
      const row = [
        r.browser, r.browser_version, r.id, r.label, r.format,
        round(r.median.t85), round(r.p10.t85), round(r.p90.t85),
        round(r.median.t95), round(r.p10.t95), round(r.p90.t95),
        fmt3(r.median.visIndex), fmt3(r.p10.visIndex), fmt3(r.p90.visIndex),
        r.notes || "", r.dist.count, (r.errors||[]).join(" | ")
      ];
      row.forEach(v => { const td = document.createElement('td'); td.textContent = v ?? ""; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
  });

  tbl.appendChild(thead); tbl.appendChild(tbody);

  function round(v){ return (v==null||isNaN(v)) ? "" : Math.round(v); }
  function fmt3(v){ return (v==null||isNaN(v)) ? "" : (+v).toFixed(3); }
}

function attachResize() {
  const ids = ['bar_t85','bar_t95','bar_vi','box_t85','box_t95','box_vi'];
  window.addEventListener('resize', () => { ids.forEach(id => { const el = document.getElementById(id); if (el) Plotly.Plots.resize(el); }); });
}

/* --------- Render all charts --------- */
renderMeta();
barsFor('t85', 'bar_t85', 'Time to 85% (median)', 'ms', false);
barsFor('t95', 'bar_t95', 'Time to 95% (median)', 'ms', false);
barsFor('visIndex', 'bar_vi', 'Visual Index (median, lower is better)', 'index', true);
boxPlot('t85', 'box_t85', 't85 distribution (lower is better)');
boxPlot('t95', 'box_t95', 't95 distribution (lower is better)');
boxPlot('visIndex', 'box_vi', 'Visual Index distribution (lower is better)');
drawTable();
attachResize();
</script>
</body>
</html>`;
}

/* ------------------------ Main ------------------------ */
(async () => {
  const config = await fs.readJson(path.resolve(cfgPath));
  const stamp = formatISO(new Date()).replace(/[:]/g, "-");
  const runDir = path.join(OUT_DIR, stamp);
  await fs.mkdirp(runDir);
  await fs.writeJson(path.join(runDir, "config.used.json"), config, { spaces: 2 });

  // Runs setting: CLI --runs → RUNS env → config.runs → 5
  const cliRuns = args.runs && !String(args.runs).startsWith("--") ? Number(args.runs) : NaN;
  const envRuns = process.env.RUNS ? Number(process.env.RUNS) : NaN;
  const cfgRuns = Number(config.runs);
  const runs = [cliRuns, envRuns, cfgRuns, 5].find(v => Number.isFinite(v) && v > 0);

  const RUN_META = {
    system: {
      os_type: os.type(),
      os_platform: os.platform(),
      os_release: os.release(),
      os_arch: os.arch(),
      cpu_model: (os.cpus()?.[0]?.model) || "unknown",
      cpu_cores: (os.cpus()?.length) || 0,
      memory_gb: Math.round(os.totalmem() / 1e9)
    },
    node: process.version,
    versions: {},
    runs
  };

  // Start internal throttled server (allow config override)
  const srvCfg = {
    chunkBytes: config.network?.server?.chunkBytes ?? 16 * 1024,
    chunkDelayMs: config.network?.server?.chunkDelayMs ?? 60
  };
  const { server, port, traces } = await startThrottledServer({ port: 0, ...srvCfg });
  const baseURL = `http://127.0.0.1:${port}`;
  console.log(`[srv] serving ${ASSET_ROOT} at ${baseURL} (chunked, ${srvCfg.chunkBytes} B every ${srvCfg.chunkDelayMs} ms)`);

  const perRunResults = [];

  // Run headed browsers
  for (const { name: browserName, launcher } of BROWSERS) {
    console.log(`\n==> ${browserName.toUpperCase()} ===================`);
    const b = await launcher.launch({ headless: false });
    const browserVersion = b.version();
    RUN_META.versions[browserName] = browserVersion;

    const ctx = await b.newContext({
      viewport: DEFAULT_VIEWPORT,
      deviceScaleFactor: DEFAULT_VIEWPORT.deviceScaleFactor,
      bypassCSP: true,
    });

    await ctx.route("**/*", (route) => {
      const headers = { ...route.request().headers(), "Cache-Control": "no-cache" };
      route.continue({ headers }).catch(() => {});
    });

    const page = await ctx.newPage();

    if (browserName === "chromium" && config.network?.throttle) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: config.network.latency ?? 150,
        downloadThroughput: (config.network.downKbps ?? 200) * 1024 / 8,
        uploadThroughput: (config.network.upKbps ?? 50) * 1024 / 8,
        connectionType: "cellular3g",
      });
    }

    for (const tc of config.tests) {
      const { id, url, label = "", format = "", notes = "" } = tc;
      const fullURL = /^https?:\/\//i.test(url) ? url : `${baseURL}/${url.replace(/^\//, "")}`;
      console.log(`  • ${id} – ${label || url}  (runs=${runs})`);

      for (let k = 0; k < runs; k++) {
        const r = { browser: browserName, browser_version: browserVersion, id, label, format, notes, run: k+1 };
        try {
          const res = await runOne(page, fullURL, config.render || {});
          Object.assign(r, res);
        } catch (err) {
          r.error = String(err && err.message ? err.message : err);
        }
        perRunResults.push(r);
        await fs.writeJson(path.join(runDir, `${browserName}-${id}-run${k+1}.json`), r, { spaces: 2 });
      }
    }

    await ctx.close();
    await b.close();
  }

  await fs.writeJson(path.join(runDir, "server.traces.json"), traces, { spaces: 2 });

  // Aggregate
  const groups = new Map();
  for (const r of perRunResults) {
    const k = `${r.browser}__${r.id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const aggregated = [];
  for (const [, arr] of groups.entries()) {
    const base = arr[0];
    const errs = arr.filter(x => x.error).map(x => x.error);
    const ok = arr.filter(x => !x.error);

    const t85s = ok.map(x => Number(x.t85)).filter(v => Number.isFinite(v));
    const t95s = ok.map(x => Number(x.t95)).filter(v => Number.isFinite(v));
    const vis  = ok.map(x => Number(x.visIndex)).filter(v => typeof v === 'number' && !Number.isNaN(v));

    aggregated.push({
      browser: base.browser,
      browser_version: base.browser_version,
      id: base.id,
      label: base.label,
      format: base.format,
      notes: base.notes,
      dist: { count: arr.length, t85: t85s, t95: t95s, visIndex: vis },
      median: { t85: median(t85s), t95: median(t95s), visIndex: median(vis) },
      p10:    { t85: percentile(t85s, 10), t95: percentile(t95s, 10), visIndex: percentile(vis, 10) },
      p90:    { t85: percentile(t85s, 90), t95: percentile(t95s, 90), visIndex: percentile(vis, 90) },
      errors: errs
    });
  }

  // Write artifacts + dashboard
  const headers = ["browser","browser_version","id","label","format",
                   "median_t85","p10_t85","p90_t85",
                   "median_t95","p10_t95","p90_t95",
                   "median_visIndex","p10_visIndex","p90_visIndex","notes","n_runs","errors"];
  const rows = [headers.join(",")].concat(aggregated.map(r =>
    [
      r.browser, csvQ(r.browser_version), r.id, csvQ(r.label), r.format,
      n(r.median.t85), n(r.p10.t85), n(r.p90.t85),
      n(r.median.t95), n(r.p10.t95), n(r.p90.t95),
      (r.median.visIndex ?? ""), (r.p10.visIndex ?? ""), (r.p90.visIndex ?? ""),
      csvQ(r.notes), r.dist.count, csvQ((r.errors||[]).join(" | "))
    ].join(",")
  ));
  const csvPath = path.join(runDir, "summary.csv");
  await fs.writeFile(csvPath, rows.join("\n"), "utf8");

  await fs.writeJson(path.join(runDir, "meta.json"), RUN_META, { spaces: 2 });
  await fs.writeJson(path.join(runDir, "per-run.json"), perRunResults, { spaces: 2 });
  await fs.writeJson(path.join(runDir, "aggregated.json"), aggregated, { spaces: 2 });

  const dashHTML = buildDashboardHTML({ stamp, configName: path.basename(cfgPath), aggregated, meta: RUN_META });
  const dashPath = path.join(runDir, "dashboard.html");
  await fs.writeFile(dashPath, dashHTML, "utf8");

  console.log(`\nWrote:\n  ${csvPath}\n  ${dashPath}\n  ${path.join(runDir, "aggregated.json")}\n  ${path.join(runDir, "per-run.json")}\n  ${path.join(runDir, "server.traces.json")}`);

  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const argsOpen = process.platform === "win32" ? ["/c", "start", "", dashPath] : [dashPath];
  execFile(opener, argsOpen, err => { if (err) console.error("Open dashboard error:", err.message); });

  server.close();
})().catch(e => { console.error(e); process.exit(1); });

function csvQ(s){ return `"${String(s ?? "").replace(/"/g,'""')}"`; }
