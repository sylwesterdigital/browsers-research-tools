#!/usr/bin/env node
/**
 * progressive-image-bench-ui.mjs
 *
 * One-command UX:
 *  - Launches an internal throttled HTTP server (chunked streaming) so images render progressively.
 *  - Runs headed Playwright across Chromium, Firefox, WebKit so you can watch the loads.
 *  - Generates an interactive Plotly dashboard (bars + table) and opens it.
 *
 * Usage:
 *   node progressive-image-bench-ui.mjs bench.config.json --root /path/to/assets
 *
 * Deps:
 *   npm i -D playwright pixelmatch pngjs fs-extra date-fns
 *   npx playwright install
 *   (no need for the 'open' package; uses OS open fallback)
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
import os from "os"; // NEW: capture hardware/OS metadata

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------ CLI & Paths ------------------------ */
const [, , cfgPath, ...argvRest] = process.argv;
if (!cfgPath) {
  console.log("Usage:\n  node progressive-image-bench-ui.mjs bench.config.json --root /path/to/assets");
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
  { name: "webkit", launcher: webkit }, // Safari engine
];

const DEFAULT_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };
const SNAPSHOT_INTERVAL_MS = 120;
const MAX_CAPTURE_MS = 8000;
const QUIET_PERIOD_MS = 600;
const OUT_DIR = path.resolve(process.cwd(), "bench-results");

/* ------------------------ Throttled HTTP Server ------------------------
   Serves files from ASSET_ROOT with chunked transfer and artificial delay.
   IMPORTANT: Sends headers ONCE; never calls writeHead twice.
------------------------------------------------------------------------- */
function startThrottledServer({ port = 0, chunkBytes = 16 * 1024, chunkDelayMs = 60 } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const clean = (req.url || "/").replace(/\?.*$/, "");
      if (clean === "/" || clean === "/favicon.ico") {
        res.statusCode = 204; res.end(); return;
      }

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
        res.write(chunk);
        stream.pause();
        setTimeout(() => stream.resume(), chunkDelayMs);
      });
      stream.on("end", () => res.end());
      stream.on("error", () => {
        if (!res.headersSent) { res.statusCode = 500; res.end("Error"); }
        else { try { res.end(); } catch {} }
      });
    } catch {
      if (!res.headersSent) { res.statusCode = 500; res.end("Error"); }
      else { try { res.end(); } catch {} }
    }
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port })));
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

function computeVisualProgress(timeline) {
  const finalFrame = timeline[timeline.length - 1].png;
  const samples = timeline.map(({ t, png }) => {
    const sim = similarity(png, finalFrame);
    return { t, completeness: +sim.toFixed(4) };
  });

  const t0 = samples[0].t;
  const tEnd = samples[samples.length - 1].t;
  let area = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    area += (1 - samples[i - 1].completeness) * dt;
  }
  const visIndex = +(area / (tEnd - t0)).toFixed(4);
  const t85 = samples.find(s => s.completeness >= 0.85)?.t ?? null;
  const t95 = samples.find(s => s.completeness >= 0.95)?.t ?? null;
  return { samples, t85, t95, visIndex };
}

/* ------------------------ Page Harness ------------------------ */
const HARNESS_HTML = ({ url, bg = "#ffffff", fit = "contain" }) => `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  html, body { height: 100%; margin: 0; background: ${bg}; }
  .wrap { display:flex; align-items:center; justify-content:center; height:100%; }
  img { max-width:95vw; max-height:95vh; object-fit:${fit}; image-rendering:auto; }
  .tip { position:fixed; top:8px; left:12px; font:14px/1.4 system-ui; color:#444; background:rgba(255,255,255,.8); padding:6px 10px; border-radius:8px; }
</style></head>
<body>
<div class="wrap">
  <img id="tgt" src="${url}" decoding="auto" loading="eager" />
</div>
<div class="tip">Loading: ${url}</div>
</body></html>`;

/* ------------------------ Bench Runner ------------------------ */
async function runOne(page, url, opts) {
  const html = HARNESS_HTML({ url, ...opts });
  const tStart = Date.now();
  await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30000 });

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

/* ------------------------ Dashboard HTML ------------------------ */
/* UPDATED: accepts a 'meta' object and displays environment + per-browser versions */
function buildDashboardHTML({ stamp, configName, results, meta }) {
  const data = JSON.stringify(results);
  const env = JSON.stringify(meta);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Progressive Image Bench – ${stamp}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
<style>
body { font: 14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui; margin: 20px; }
h1 { font-size: 20px; margin: 0 0 8px; }
.grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
.card { padding: 12px; border: 1px solid #e3e3e3; border-radius: 10px; background: #fff; }
.table { border-collapse: collapse; width: 100%; font-size: 13px; }
.table th, .table td { border-bottom: 1px solid #eee; padding: 6px 8px; text-align: left; }
.bad { color: #b00; font-weight: 600; }
.small { color:#666; font-size:12px; }
.meta { font-size: 12px; color:#333; white-space: pre-wrap; }
.kv { display:flex; flex-wrap:wrap; gap:10px; }
.kv div { background:#f7f7f7; border-radius:8px; padding:6px 8px; }
</style>
</head>
<body>
<h1>Progressive Image Bench – ${stamp}</h1>
<div class="small">Config: <code>${configName}</code></div>

<div class="card">
  <div id="meta"></div>
</div>

<div class="grid">
  <div class="card"><div id="t85"></div></div>
  <div class="card"><div id="t95"></div></div>
  <div class="card"><div id="vindex"></div></div>
  <div class="card">
    <table class="table" id="summary"></table>
  </div>
</div>

<script>
const results = ${data};
const meta = ${env};

function groupBy(arr, key) {
  return arr.reduce((m, x) => ((m[x[key]] ||= []).push(x), m), {});
}

function renderMeta() {
  const mount = document.getElementById('meta');
  const sys = meta.system;
  const vers = meta.versions;
  const osLine = sys.os_type + " " + sys.os_release + " (" + sys.os_platform + ", " + sys.os_arch + ")";
  const hwLine = sys.cpu_model + " ×" + sys.cpu_cores + " • " + sys.memory_gb + " GB RAM";
  const nodeLine = "Node " + meta.node;
  const browserLines = Object.entries(vers).map(([k,v]) => k + ": " + v).join(" • ");
  mount.innerHTML = '<div class="kv">'
    + '<div><b>OS</b>: ' + osLine + '</div>'
    + '<div><b>HW</b>: ' + hwLine + '</div>'
    + '<div><b>Node</b>: ' + nodeLine + '</div>'
    + '<div><b>Browsers</b>: ' + browserLines + '</div>'
    + '</div>';
}

function drawBars(metricKey, elId, title, yTitle) {
  const groups = groupBy(results, 'browser');
  const traces = [];
  const ids = [...new Set(results.map(r => r.id))];
  for (const [browser, rows] of Object.entries(groups)) {
    const ordered = ids.map(id => rows.find(r => r.id === id) || {});
    traces.push({
      x: ids,
      // Keep visIndex as a float; round integer metrics only. Avoid NaN/null bars.
      y: ordered.map(r => {
        const v = r?.[metricKey];
        if (v == null || Number.isNaN(Number(v))) return null;
        return metricKey === 'visIndex' ? Number(v) : Math.round(Number(v));
      }),
      name: browser,
      type: 'bar'
    });
  }
  const isVI = metricKey === 'visIndex'; // format axis for small floats
  Plotly.newPlot(elId, traces, {
    title, barmode:'group',
    xaxis: { title: 'Test' },
    yaxis: { title: yTitle, rangemode: 'tozero', tickformat: isVI ? '.3f' : undefined },
    margin: { t: 40, r: 10, b: 60, l: 50 },
  }, {displaylogo:false, responsive:true});
}

function drawTable() {
  const headers = ["browser","browser_version","id","label","format","t85","t95","visual_index","notes","error"];
  const tbl = document.getElementById('summary');
  const thead = document.createElement('thead'); const trh = document.createElement('tr');
  headers.forEach(h => { const th = document.createElement('th'); th.textContent = h; trh.appendChild(th); });
  thead.appendChild(trh);
  const tbody = document.createElement('tbody');
  results.forEach(r => {
    const tr = document.createElement('tr');
    headers.forEach(h => {
      const td = document.createElement('td');
      let v = r[h];
      if (h === 't85' || h === 't95') v = (v==null || isNaN(v)) ? "" : Math.round(v);
      if (h === 'visual_index') v = (v==null || isNaN(v)) ? "" : (+v).toFixed(3);
      if (h === 'error' && v) td.className = 'bad';
      td.textContent = v ?? "";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  tbl.appendChild(thead); tbl.appendChild(tbody);
}

renderMeta();
drawBars('t85', 't85', 'Time to 85% (ms)', 'ms');
drawBars('t95', 't95', 'Time to 95% (ms)', 'ms');
drawBars('visIndex', 'vindex', 'Visual Index (lower better)', 'index');
drawTable();
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

  // NEW: collect run metadata (hardware, OS, Node)
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
    versions: {} // filled per-browser below
  };

  // 1) Start internal throttled server
  const { server, port } = await startThrottledServer({
    port: 0,
    chunkBytes: 16 * 1024,
    chunkDelayMs: 60,
  });
  const baseURL = `http://127.0.0.1:${port}`;
  console.log(`[srv] serving ${ASSET_ROOT} at ${baseURL} (chunked)`);

  const results = [];

  // 2) Run headed browsers (route set once per context)
  for (const { name: browserName, launcher } of BROWSERS) {
    console.log(`\n==> ${browserName.toUpperCase()} ===================`);
    const b = await launcher.launch({ headless: false });
    // NEW: capture Playwright browser version string
    const browserVersion = b.version();
    RUN_META.versions[browserName] = browserVersion;

    const ctx = await b.newContext({
      viewport: DEFAULT_VIEWPORT,
      deviceScaleFactor: DEFAULT_VIEWPORT.deviceScaleFactor,
      bypassCSP: true,
    });

    // set no-cache headers ONCE per context
    await ctx.route("**/*", (route) => {
      const headers = { ...route.request().headers(), "Cache-Control": "no-cache" };
      route.continue({ headers }).catch(() => {});
    });

    const page = await ctx.newPage();

    // Chromium throttling (optional)
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
      // http(s) URLs pass through; relative paths are served by our internal server
      const fullURL = /^https?:\/\//i.test(url) ? url : `${baseURL}/${url.replace(/^\//, "")}`;
      console.log(`  • ${id} – ${label || url}`);

      const r = { browser: browserName, browser_version: browserVersion, id, label, format, notes };
      try {
        const res = await runOne(page, fullURL, config.render || {});
        Object.assign(r, res);
      } catch (err) {
        r.error = String(err && err.message ? err.message : err);
      }

      await fs.writeJson(path.join(runDir, `${browserName}-${id}.json`), r, { spaces: 2 });
      results.push(r);
    }

    await ctx.close();
    await b.close();
  }

  // 3) Write CSV and Dashboard, then open dashboard
  const headers = ["browser","browser_version","id","label","format","t85","t95","visIndex","notes","error"];
  const rows = [headers.join(",")].concat(results.map(r =>
    [r.browser, csvQ(r.browser_version), r.id, csvQ(r.label), r.format, n(r.t85), n(r.t95), r.visIndex ?? "", csvQ(r.notes), csvQ(r.error||"")].join(",")
  ));
  const csvPath = path.join(runDir, "summary.csv");
  await fs.writeFile(csvPath, rows.join("\n"), "utf8");

  // NEW: persist meta alongside artifacts
  await fs.writeJson(path.join(runDir, "meta.json"), RUN_META, { spaces: 2 });

  const dashHTML = buildDashboardHTML({ stamp, configName: path.basename(cfgPath), results, meta: RUN_META });
  const dashPath = path.join(runDir, "dashboard.html");
  await fs.writeFile(dashPath, dashHTML, "utf8");

  console.log(`\nWrote:\n  ${csvPath}\n  ${dashPath}`);

  // open with OS defaults (no 'open' npm needed)
  const opener = process.platform === "darwin" ? "open"
               : process.platform === "win32" ? "cmd"
               : "xdg-open";
  const argsOpen = process.platform === "win32" ? ["/c", "start", "", dashPath] : [dashPath];
  execFile(opener, argsOpen, err => { if (err) console.error("Open dashboard error:", err.message); });

  // 4) Stop server
  server.close();
})().catch(e => { console.error(e); process.exit(1); });

function csvQ(s){ return `"${String(s ?? "").replace(/"/g,'""')}"`; }
