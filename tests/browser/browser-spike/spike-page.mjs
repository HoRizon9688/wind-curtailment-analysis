/**
 * Browser evidence page for the table adapter, run under the repository
 * sub-path so loading matches the GitHub Pages shape. Results are POSTed back
 * to the harness; that POST is a local test channel and is declared as such in
 * the report (`localTestChannel`).
 *
 * The repository prefix is never hardcoded: it comes from the `prefix` query
 * parameter the harness supplies, and otherwise falls back to the served first
 * path segment. A checkout directory with a different name therefore works.
 *
 * There is no curtailment rule here. The per-minute pass is a plain blocking
 * proxy used only to decide whether a Worker is justified.
 */
import { readTable } from "../../../dashboard/src/content/calculation/table-reader.mjs";

const MARKER = "T0-R-SYNTHETIC-MARKER-6f2a91";
const PARAMS = new URLSearchParams(globalThis.location?.search ?? "");
const PREFIX = (PARAMS.get("prefix") ?? `/${globalThis.location.pathname.split("/")[1] ?? ""}`).replace(/\/$/u, "");
const FIXTURE_BASE = `${PREFIX}/tests/fixtures/browser/spike`;
// The harness passes the bundled Worker URL, because the page is bundled by Vite
// and a relative `import.meta.url` would point at the build output, not a module
// the browser can load directly.
const WORKER_URL = PARAMS.get("worker")
  ? new URL(PARAMS.get("worker"), globalThis.location.href)
  : new URL("./spike-worker.mjs", import.meta.url);
const RESULT_ENDPOINT = "/__result";
const checks = [];
const outbound = [];

function check(name, passed, detail = "") {
  checks.push({ name, passed: Boolean(passed), detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
}

function describeBody(body) {
  if (body === undefined || body === null) return { kind: "none" };
  if (typeof body === "string") return { kind: "string", chars: body.length, text: body.slice(0, 300) };
  if (body instanceof URLSearchParams) return { kind: "urlsearchparams", text: body.toString().slice(0, 300) };
  if (typeof Blob !== "undefined" && body instanceof Blob) return { kind: "blob", chars: body.size };
  return { kind: typeof body };
}

// ------------------------------------------------------- egress instrumentation
function instrument() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const target = typeof input === "string" ? input : input?.url;
    outbound.push({
      api: "fetch",
      target: String(target),
      method: init?.method ?? "GET",
      // Recording the body is what catches a same-origin POST carrying file
      // content; the URL alone cannot show it.
      body: describeBody(init?.body),
    });
    return originalFetch(input, init);
  };
  const OriginalXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = class extends OriginalXhr {
    open(method, url, ...rest) {
      this.__probe = { api: "xhr", target: String(url), method, body: { kind: "pending" } };
      outbound.push(this.__probe);
      return super.open(method, url, ...rest);
    }
    send(body) {
      if (this.__probe) this.__probe.body = describeBody(body);
      return super.send(body);
    }
  };
  if (globalThis.navigator?.sendBeacon) {
    const original = globalThis.navigator.sendBeacon.bind(globalThis.navigator);
    globalThis.navigator.sendBeacon = (url, data) => {
      outbound.push({ api: "sendBeacon", target: String(url), method: "POST", body: describeBody(data) });
      return original(url, data);
    };
  }
  for (const name of ["WebSocket", "EventSource"]) {
    const Original = globalThis[name];
    if (!Original) continue;
    globalThis[name] = new Proxy(Original, {
      construct(target, args) {
        outbound.push({ api: name, target: String(args[0]), method: name, body: { kind: "none" } });
        return Reflect.construct(target, args);
      },
    });
  }
}

// -------------------------------------------------------------- storage probe
async function storageReport() {
  const report = { localStorage: [], sessionStorage: [], indexedDb: [], caches: [] };
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      report.localStorage.push([key, localStorage.getItem(key)?.slice(0, 200)]);
    }
  } catch { /* storage may be unavailable */ }
  try {
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      report.sessionStorage.push([key, sessionStorage.getItem(key)?.slice(0, 200)]);
    }
  } catch { /* ignore */ }
  try {
    report.indexedDb = (await indexedDB.databases()).map((entry) => entry.name);
  } catch { /* ignore */ }
  try {
    report.caches = await caches.keys();
  } catch { /* ignore */ }
  return report;
}

// ------------------------------------------------------------- 31-day fixture
function syntheticThirtyOneDays() {
  const lines = ["时间,可用功率,理论功率,全站总有功_集电线有功之和,AGC有功设定值,备注"];
  for (let minute = 0; minute < 31 * 1440; minute += 1) {
    const day = String(Math.floor(minute / 1440) + 1).padStart(2, "0");
    const hour = String(Math.floor((minute % 1440) / 60)).padStart(2, "0");
    const rest = String(minute % 60).padStart(2, "0");
    const a = (29.5 + Math.sin(minute / 190) * 9).toFixed(4);
    const g = (21 + Math.sin(minute / 43) * 3).toFixed(4);
    const p = (Number(a) * 0.99).toFixed(4);
    lines.push(`2026-08-${day} ${hour}:${rest},${a},${(Number(a) + 0.1).toFixed(4)},${p},${g},${MARKER}`);
  }
  return lines.join("\r\n");
}

/** Sequential walk used only to compare main thread against Worker blocking. */
function sequentialPass(rows) {
  let finite = 0;
  let sum = 0;
  for (const row of rows) {
    const a = Number(row[1]);
    const p = Number(row[3]);
    const g = Number(row[4]);
    if (Number.isFinite(a) && Number.isFinite(p) && Number.isFinite(g)) {
      finite += 1;
      sum += p - Math.min(a, g);
    }
  }
  return { finite, sum };
}

/**
 * Long-task monitor. Entries are delivered asynchronously, so `stop()` waits a
 * settle period before disconnecting: disconnecting immediately after the work
 * drops the tail record and can make a blocking operation look free.
 */
function longTaskMonitor() {
  const entries = [];
  let observer = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        entries.push({ duration: Math.round(entry.duration), startTime: Math.round(entry.startTime) });
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    observer = null;
  }
  return {
    async stop({ settleMs = 400 } = {}) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      observer?.disconnect();
      return {
        supported: observer !== null,
        entries,
        durations: entries.map((entry) => entry.duration),
        worstMs: entries.length ? Math.max(...entries.map((entry) => entry.duration)) : 0,
      };
    },
  };
}

function runWorker(payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { type: "module" });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error("worker timeout"));
    }, 60_000);
    worker.onmessage = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(event.message ?? "worker error"));
    };
    worker.postMessage(payload);
  });
}

async function main() {
  instrument();
  const results = {
    marker: MARKER,
    startedAt: new Date().toISOString(),
    prefix: PREFIX,
    // The page posts its own findings to the harness over the same origin. That
    // is a local test channel, not application behaviour, and is declared here
    // so the request log is not mistaken for application egress.
    localTestChannel: { endpoint: RESULT_ENDPOINT, carries: "test results only" },
  };
  results.environment = {
    userAgent: navigator.userAgent,
    href: location.href,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    hasDecompressionStream: typeof DecompressionStream === "function",
    deflateRaw: (() => { try { new DecompressionStream("deflate-raw"); return true; } catch { return false; } })(),
    hasCryptoSubtle: typeof crypto?.subtle === "object",
  };

  async function loadFixture(name) {
    const response = await fetch(`${FIXTURE_BASE}/${name}`);
    return { name, bytes: await response.arrayBuffer() };
  }

  // ------------------------------------------------- reader under the sub-path
  try {
    const csv = await readTable(await loadFixture("minute-power.csv"));
    check("CSV loads under the repository sub-path", csv.rows[0][0] === "时间", csv.rows[0]);
    check("CSV keeps the empty cell", csv.rows[1][1] === "", csv.rows[1]);

    const gb = await readTable(await loadFixture("minute-power-gb18030.csv"));
    check("GB18030 fallback works in the browser", gb.rows[0][0] === "时间" && !JSON.stringify(gb.rows).includes("\uFFFD"));

    const ooxml = await readTable(await loadFixture("forecast-ooxml.xls"));
    check("OOXML .xls is read by content detection", ooxml.format === "ooxml" && ooxml.sheetName === "功率预测", ooxml.sheetName);
    check("cached formula value is used in the browser", ooxml.rows[1][4] === 49, String(ooxml.rows[1][4]));
    check("uncached formula stays missing in the browser", ooxml.rows[1][5] === null, String(ooxml.rows[1][5]));
    check("date cell decodes in the browser",
      String(ooxml.rows[1][2]?.toISOString?.() ?? ooxml.rows[1][2]) === "2026-07-31T23:45:00.000Z", String(ooxml.rows[1][2]));

    const active = await readTable(await loadFixture("forecast-active-second.xlsx"));
    check("the active worksheet fallback works in the browser", active.sheetName === "分钟数据", active.sheetName);

    let legacy = "accepted";
    try { await readTable(await loadFixture("legacy-binary.xls")); } catch (error) { legacy = error.message; }
    check("legacy binary XLS still rejected in the browser", /旧版二进制 XLS/.test(legacy), legacy);
  } catch (error) {
    check("reader fixtures", false, error?.message ?? String(error));
  }

  // --------------------------------------- long-task positive control, first
  const controlMonitor = longTaskMonitor();
  const controlStart = performance.now();
  while (performance.now() - controlStart < 220) {
    /* deliberate synchronous block */
  }
  const control = await controlMonitor.stop();
  results.positiveControl = { blockedMs: Math.round(performance.now() - controlStart), ...control };
  check("the long-task observer detects a known synchronous block",
    control.supported && control.worstMs >= 100, control);

  // -------------------------------------------------- main-thread blocking
  const text = syntheticThirtyOneDays();
  const bytes = new TextEncoder().encode(text).buffer;
  results.volume = { textBytes: text.length, lines: 31 * 1440 + 1 };

  const mainTasks = longTaskMonitor();
  const mainStart = performance.now();
  const mainTable = await readTable({ name: "day-31.csv", bytes: bytes.slice(0) });
  const parseMs = performance.now() - mainStart;
  const passStart = performance.now();
  const mainPass = sequentialPass(mainTable.rows);
  const passMs = performance.now() - passStart;
  const longTasks = await mainTasks.stop();
  results.mainThread = { parseMs, passMs, rows: mainTable.rows.length, finite: mainPass.finite, longTasks };
  check("main-thread blocking during the 31-day read is measured, not assumed",
    longTasks.supported && Array.isArray(longTasks.durations), longTasks);

  // ------------------------------------------------------------ module Worker
  try {
    const transferable = bytes.slice(0);
    const workerStart = performance.now();
    const workerResult = await runWorker({ name: "day-31.csv", bytes: transferable });
    results.worker = { ...workerResult, roundTripMs: performance.now() - workerStart };
    check("module Worker loads under the repository sub-path", workerResult?.ok === true, workerResult?.error ?? null);
    check("Worker result matches the main thread", workerResult?.ok === true
      && workerResult.finite === mainPass.finite
      && Math.abs(workerResult.sum - mainPass.sum) < 1e-6, workerResult);
  } catch (error) {
    check("module Worker loads under the repository sub-path", false, error?.message ?? String(error));
  }

  // ------------------------------------------------------------- cancellation
  try {
    const worker = new Worker(WORKER_URL, { type: "module" });
    let delivered = false;
    worker.onmessage = () => { delivered = true; };
    worker.onerror = () => { delivered = true; };
    const cancelBuffer = bytes.slice(0);
    worker.postMessage({ name: "day-31.csv", bytes: cancelBuffer }, [cancelBuffer]);
    check("a transferred buffer is detached in the sender", cancelBuffer.byteLength === 0, String(cancelBuffer.byteLength));
    const terminatedAt = performance.now();
    worker.terminate();
    const terminateMs = performance.now() - terminatedAt;
    await new Promise((resolve) => setTimeout(resolve, 400));
    check("terminate() cancels before a result is delivered", delivered === false);
    results.cancel = { terminateSynchronousMs: terminateMs, deliveredAfterTerminate: delivered };
  } catch (error) {
    check("terminate() cancels before a result is delivered", false, error?.message ?? String(error));
  }

  // ---------------------------------------------------------------- privacy
  const storage = await storageReport();
  results.storage = storage;
  check("the synthetic marker never reaches browser storage",
    !JSON.stringify(storage).includes(MARKER), JSON.stringify(storage).slice(0, 200));

  // Positive control: the detector must notice a body-bearing request. Without
  // it, "no body was seen" could simply mean the instrumentation never looks.
  const controlBody = `${MARKER}-BODY-CONTROL`;
  try {
    await fetch(`${RESULT_ENDPOINT}?probe=body-control`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: controlBody,
    });
  } catch { /* the harness answers this; an error is not interesting here */ }
  const bodyControlSeen = outbound.some((entry) => entry.body?.text?.includes(controlBody));
  results.bodyControl = { sent: controlBody, detected: bodyControlSeen };
  check("request-body inspection detects a known body-bearing request", bodyControlSeen, results.bodyControl);
  const applicationRequests = outbound.filter((entry) => !entry.target.includes(RESULT_ENDPOINT));

  const bodyBearing = applicationRequests.filter((entry) => entry.body && entry.body.kind !== "none");
  const nonGet = applicationRequests.filter((entry) => String(entry.method).toUpperCase() !== "GET");
  const nonSameOrigin = applicationRequests.filter((entry) => {
    try {
      return new URL(entry.target, location.href).origin !== location.origin;
    } catch {
      return false;
    }
  });
  const markerRequests = applicationRequests.filter((entry) => JSON.stringify(entry).includes(MARKER));
  results.outbound = applicationRequests.map((entry) => ({ ...entry, target: entry.target.slice(0, 160) }));
  results.bodyBearing = bodyBearing;
  check("no application request carries a body", bodyBearing.length === 0, bodyBearing);
  check("no application request is a non-GET", nonGet.length === 0, nonGet);
  check("no cross-origin application request is made", nonSameOrigin.length === 0, nonSameOrigin);
  check("no application request carries the synthetic marker", markerRequests.length === 0, markerRequests);

  results.checks = checks;
  results.passed = checks.every((entry) => entry.passed);
  await fetch(RESULT_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(results),
  }).catch(() => {});
  globalThis.__T0_RESULT__ = results;
  document.title = results.passed ? "T0 spike: PASS" : "T0 spike: FAIL";
  const output = document.getElementById("result");
  if (output) output.textContent = JSON.stringify(results, null, 2);
}

main().catch(async (error) => {
  await fetch(RESULT_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fatal: error?.stack ?? String(error), passed: false, checks }),
  }).catch(() => {});
});
