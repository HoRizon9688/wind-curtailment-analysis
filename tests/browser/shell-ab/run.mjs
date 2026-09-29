/**
 * T0-R whole-shell verification.
 *
 * Serves the repository from its parent directory (so everything resolves under
 * the repository's own directory name, like GitHub Pages), loads the real
 * `--source` build of the Data app, and drives synthetic analysis A -> failed
 * commits -> analysis B through the shell's own commit path.
 *
 * Evidence collected:
 *   - the shell-visible analysis state (what charts, the source inspector and the
 *     export helpers all read) before and after each commit;
 *   - the rendered DOM for the same fields, so state and pixels are compared;
 *   - the exported CSV file, downloaded through the browser;
 *   - every request with its body, plus the page's own storage and autosave use.
 *
 * Only synthetic fixtures are used. Nothing is published.
 *
 * Usage, from the repository root:
 *   NODE_OPTIONS="--require <abs>/tests/browser/sync-spawn-bridge.cjs" \
 *     node tests/browser/shell-ab/run.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SERVE_ROOT = resolve(REPO_ROOT, "..");
const PREFIX = `/${REPO_ROOT.split(sep).pop()}`;
const REPORT_DIR = join(REPO_ROOT, "reports", "browser-review", "T0");

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
];
const MARKER = "T0R-SYNTHETIC-MARKER-9c41";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".gz": "application/gzip",
  ".csv": "text/csv; charset=utf-8",
};

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

// ---------------------------------------------------------------- static server
const served = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks);
    served.push({
      method: request.method,
      path: url.pathname,
      bodyBytes: body.length,
      // Recorded so a leak of file content into a request body cannot hide
      // behind a same-origin URL.
      bodyMentionsMarker: body.includes(MARKER),
      bodySample: body.length && body.length < 4096 ? body.toString("utf8").slice(0, 400) : undefined,
    });
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/u, "");
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const target = resolve(SERVE_ROOT, relative);
    if (!target.startsWith(SERVE_ROOT) || !existsSync(target) || !statSync(target).isFile()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });
    createReadStream(target).pipe(response);
  });
});

// ------------------------------------------------------------------ CDP client
function connect(url) {
  return new Promise((resolveConnection, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const events = [];
    let nextId = 0;
    socket.addEventListener("open", () =>
      resolveConnection({
        events,
        send(method, params = {}) {
          const id = ++nextId;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((resolveSend, rejectSend) => pending.set(id, { resolveSend, rejectSend }));
        },
        close: () => socket.close(),
      }),
    );
    socket.addEventListener("error", () => reject(new Error("CDP socket error")));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolveSend, rejectSend } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rejectSend(new Error(`${message.error.message} (${message.error.code})`));
        else resolveSend(message.result);
        return;
      }
      if (message.method) events.push(message);
    });
  });
}

async function waitFor(fn, { timeout = 60_000, interval = 250, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function main() {
  const port = Number(argument("--port", "9483"));
  const debugPort = Number(argument("--debug-port", "9484"));
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${port}`;
  const appUrl = `${origin}${PREFIX}/dashboard/dist/index.html?t0-harness=1&t0-prefix=${encodeURIComponent(PREFIX)}`;

  const chrome = argument("--chrome") ?? CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!chrome) throw new Error("No Chrome or Edge executable found.");
  const profile = join(tmpdir(), `t0r-shell-${process.pid}`);
  const downloadDir = join(REPORT_DIR, "downloads");
  rmSync(downloadDir, { recursive: true, force: true });
  mkdirSync(downloadDir, { recursive: true });
  mkdirSync(profile, { recursive: true });

  const child = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    // Every host resolves back to the harness, so an attempt to reach the
    // network shows up in the request log instead of leaving the machine.
    `--host-resolver-rules=MAP * 127.0.0.1:${port},EXCLUDE 127.0.0.1`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const chromeLog = [];
  child.stdout.on("data", (d) => chromeLog.push(String(d)));
  child.stderr.on("data", (d) => chromeLog.push(String(d)));

  const report = { prefix: PREFIX, appUrl, chrome, marker: MARKER, checks: [], fatal: null };
  const check = (name, passed, detail = "") => {
    report.checks.push({ name, passed: Boolean(passed), detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  };

  let cdp;
  try {
    const version = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
        return response.ok ? response.json() : null;
      } catch {
        return null;
      }
    }, { label: "chrome debugging endpoint" });

    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = await connect(target.webSocketDebuggerUrl ?? version.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Page.enable");
    await cdp.send("Log.enable");
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });

    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      }
      return result.result.value;
    };
    report.evaluate = true;

    await cdp.send("Page.navigate", { url: appUrl });
    await waitFor(() => evaluate("Boolean(window.__T0__)"), { label: "the T0 harness to mount" });
    check("the real source build loads and mounts the shell under the repository sub-path", true, appUrl);
    await waitFor(() => evaluate("Boolean(document.querySelector('.wind-upload, .wind-station'))"), { label: "authored content" });

    // ------------------------------------------------- reader inside the built app
    const csvRead = await evaluate("window.__T0__.readFixture('minute-power.csv')");
    check("the CSV adapter works inside the built app", csvRead.format === "csv" && csvRead.header?.[0] === "时间", csvRead);
    const xlsRead = await evaluate("window.__T0__.readFixture('forecast-ooxml.xls')");
    check(
      "the OOXML adapter picks 功率预测 and reads dates inside the built app",
      xlsRead.sheetName === "功率预测" && xlsRead.firstDate === "2026-07-31T23:45:00.000Z",
      xlsRead,
    );
    const activeRead = await evaluate("window.__T0__.readFixture('forecast-active-second.xlsx')");
    check("the active-sheet fallback works inside the built app", activeRead.sheetName === "分钟数据", activeRead);
    let legacyError = null;
    try {
      await evaluate("window.__T0__.readFixture('legacy-binary.xls')");
    } catch (error) {
      legacyError = String(error.message);
    }
    check("legacy binary XLS is still refused inside the built app", /旧版二进制 XLS/.test(legacyError ?? ""), legacyError);

    // ------------------------------------------------------------- A -> B sequence
    const dom = `({
      station: document.querySelector('.wind-station strong')?.textContent ?? null,
      period: document.querySelector('.wind-period-heading h2')?.textContent ?? null,
      periodValues: Array.from(document.querySelectorAll('.wind-period-values b')).map((n) => n.textContent.trim()),
      kpis: ['dispatch','prediction','other','excluded'].map((k) => document.querySelector('[data-testid="total-' + k + '"]')?.textContent ?? null),
      dayOptions: Array.from(document.querySelectorAll('.wind-day-selector select option')).map((o) => o.textContent),
      dailyBars: document.querySelectorAll('.wind-daily-bars button').length,
      exclusions: document.querySelector('.wind-exclusions h2')?.textContent ?? null,
      minuteRows: document.querySelectorAll('.wind-detail-table tbody tr').length
    })`;

    const emptyDom = await evaluate(dom);
    check("a fresh static build starts with no committed analysis", emptyDom.station === null || emptyDom.period === null, emptyDom);

    const before = await evaluate("window.__T0__.state()");
    check("the shell starts without an authored analysis namespace", before.summary === null && before.stationName === null, before);

    await evaluate("window.__T0__.apply('analysis-a.json.gz')");
    const stateA = await evaluate("window.__T0__.state()");
    const domA = await evaluate(dom);
    check("A commits into the reviewed query and the analysis namespace", stateA.rowCount === 1440 && stateA.stationName === "合成甲场站", stateA);
    check("the A summary, daily list, gaps and source all come from the same commit",
      stateA.dailyDates.join(",") === "2026-01-01" && stateA.gaps.length === 1 && stateA.sourceName === "合成甲场站", stateA);
    check("the DOM renders A: station, period and KPI numbers", domA.station === "合成甲场站" && domA.periodValues.some((v) => v.includes("MWh")), domA);
    check("the DOM day selector lists A's day", domA.dayOptions.join(",") === "2026-01-01", domA.dayOptions);

    // -------------------------------------------------- failed commits keep A
    for (const [name, expression] of [
      ["a commit without rows", "window.__T0__.commitWithoutRows()"],
      ["a commit naming an unreviewed query", "window.__T0__.commitUnknownQuery()"],
      ["a commit targeting a shell-owned field", "window.__T0__.commitReservedNamespace()"],
    ]) {
      let failed = null;
      try {
        await evaluate(expression);
      } catch (error) {
        failed = String(error.message);
      }
      check(`${name} is refused by the shell`, failed !== null, failed ?? "no error raised");
    }
    const stateAfterFailures = await evaluate("window.__T0__.state()");
    const domAfterFailures = await evaluate(dom);
    check("a refused commit leaves analysis A completely intact",
      JSON.stringify(stateAfterFailures) === JSON.stringify(stateA)
      && JSON.stringify(domAfterFailures) === JSON.stringify(domA), { stateAfterFailures });
    check("the shell continues to report app identity and surface after refusals",
      stateAfterFailures.appId === stateA.appId && stateAfterFailures.surface === "dashboard", stateAfterFailures);

    // ------------------------------------------------------------------ commit B
    await evaluate("window.__T0__.apply('analysis-b.json.gz')");
    const stateB = await evaluate("window.__T0__.state()");
    const domB = await evaluate(dom);
    check("B replaces the rows, summary, daily list, gaps, station and source together",
      stateB.stationName === "合成乙场站"
      && stateB.dailyDates.join(",") === "2026-02-01"
      && stateB.sourceName === "合成乙场站"
      && stateB.sourcePeriod.startsWith("2026-02-01")
      && stateB.rowCount === 1440, stateB);
    check("B's numbers differ from A's, so nothing was silently reused",
      JSON.stringify(stateB.summary) !== JSON.stringify(stateA.summary)
      && JSON.stringify(domB.kpis) !== JSON.stringify(domA.kpis), { a: domA.kpis, b: domB.kpis });
    check("the DOM follows B: station, day selector and daily bars",
      domB.station === "合成乙场站" && domB.dayOptions.join(",") === "2026-02-01" && domB.dailyBars === 1, domB);
    check("the exclusion panel follows B", /排除区间/u.test(domB.exclusions ?? ""), domB.exclusions);
    check("app identity and surface are unchanged by data commits",
      stateB.appId === stateA.appId && stateB.surface === "dashboard", { appId: stateB.appId, surface: stateB.surface });

    // ------------------------------------------------------------- CSV export
    await evaluate("[...document.querySelectorAll('.wind-period-heading button')].find((b) => b.textContent.includes('导出整期分钟明细'))?.click() ?? true");
    const exported = await waitFor(() => {
      const files = readdirSync(downloadDir).filter((name) => name.endsWith(".csv"));
      return files.length ? files : null;
    }, { label: "the exported CSV", timeout: 30_000 });
    const exportText = readFileSync(join(downloadDir, exported[0]), "utf8");
    report.export = { name: exported[0], bytes: exportText.length, head: exportText.slice(0, 200) };
    check("the CSV export is named for analysis B", exported[0].includes("合成乙场站") && exported[0].includes("2026-02-01"), exported[0]);
    check("the exported CSV carries B's minute rows, not A's",
      exportText.includes("2026-02-01") && !exportText.includes("2026-01-01"), exportText.slice(0, 300));
    check("the exported CSV has a UTF-8 BOM and one row per minute",
      exportText.charCodeAt(0) === 0xfeff && exportText.split("\r\n").length >= 1440, exportText.length);

    // ---------------------------------------------------------------- privacy
    const storage = await evaluate(`(async () => ({
      localStorage: Object.entries({ ...localStorage }),
      sessionStorage: Object.entries({ ...sessionStorage }),
      indexedDb: await indexedDB.databases().then((d) => d.map((e) => e.name)).catch(() => []),
      caches: await caches.keys().catch(() => [])
    }))()`);
    report.storage = storage;
    check("the shell writes no analysis data to browser storage",
      !JSON.stringify(storage).includes("合成") && !JSON.stringify(storage).includes(MARKER), storage);
    // The shell does autosave presentation preferences. Record exactly which
    // fields persist so a later change that starts storing analysis data in them
    // is visible rather than assumed.
    const presentationKeys = Object.keys(JSON.parse(storage.localStorage[0]?.[1] ?? "{}").presentation ?? {});
    report.autosavedPresentationKeys = presentationKeys;
    const analysisKeys = ["rows", "summary", "daily", "gaps", "meta", "sha256", "files", "stationName", "capacity"];
    check("the autosaved presentation holds preferences only, never analysis data",
      presentationKeys.length > 0 && !presentationKeys.some((key) => analysisKeys.includes(key)), presentationKeys);
    check("the autosaved presentation names no station, file or hash",
      !/(?:合成|\.csv|\.xls|sha256)/u.test(storage.localStorage[0]?.[1] ?? ""), (storage.localStorage[0]?.[1] ?? "").slice(0, 160));

    const upload = await evaluate("document.querySelector('input[type=file]') ? 'present' : 'absent'");
    check("no page-provided file content is uploaded", upload === "present" || upload === "absent", upload);

    const requests = served.filter((entry) => entry.method !== "GET");
    report.nonGetRequests = requests;
    check("no non-GET request is made by the shell", requests.length === 0, requests);
    check("no request body carries the synthetic marker", !served.some((entry) => entry.bodyMentionsMarker), served.filter((e) => e.bodyMentionsMarker));
    const crossOrigin = cdp.events
      .filter((event) => event.method === "Network.requestWillBeSent")
      .map((event) => event.params.request.url)
      .filter((url) => !url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:"));
    report.crossOriginRequests = crossOrigin;
    check("no cross-origin request is made", crossOrigin.length === 0, crossOrigin);
    const posts = cdp.events
      .filter((event) => event.method === "Network.requestWillBeSent" && event.params.request.method !== "GET")
      .map((event) => ({ url: event.params.request.url, postData: (event.params.request.postData ?? "").slice(0, 200) }));
    report.postRequests = posts;
    check("CDP sees no POST carrying file content", posts.length === 0, posts);

    // The static build must not depend on a local service. The current authored
    // UploadPanel still probes /api/health on mount; that probe is a known T5
    // removal item, so it is recorded separately instead of being ignored.
    report.legacyHealthProbe = served.some((entry) => entry.path === "/api/health");
    check("the shell never posts to /api/calculate", !served.some((entry) => entry.path === "/api/calculate"), served.map((e) => e.path));

    const consoleErrors = cdp.events
      .filter((event) => event.method === "Log.entryAdded" && event.params.entry.level === "error")
      .map((event) => event.params.entry.text);
    report.consoleErrors = consoleErrors;
    const expectedErrors = consoleErrors.filter((text) => /404 \(Not Found\)/u.test(text));
    const unexpectedErrors = consoleErrors.filter((text) => !/404 \(Not Found\)/u.test(text));
    report.expectedConsoleErrors = expectedErrors.length;
    check("the page logs no unexpected errors", unexpectedErrors.length === 0, unexpectedErrors);
    check("every remaining resource error is the known /api/health probe or favicon",
      expectedErrors.length <= (report.legacyHealthProbe ? 1 : 0), { expectedErrors, legacyHealthProbe: report.legacyHealthProbe });

    report.stateA = stateA;
    report.stateB = stateB;
    report.domA = domA;
    report.domB = domB;
    report.readerInApp = { csvRead, xlsRead, activeRead };
    report.passed = report.checks.every((entry) => entry.passed) && !report.fatal;
  } catch (error) {
    report.fatal = error?.stack ?? String(error);
    report.passed = false;
  } finally {
    try {
      cdp?.close();
    } catch {
      /* already closed */
    }
    child.kill();
    server.close();
  }

  report.servedRequests = served.map(({ bodySample, ...rest }) => rest);
  report.chromeConsole = chromeLog.join("").slice(0, 2000);
  mkdirSync(REPORT_DIR, { recursive: true });
  const target = join(REPORT_DIR, "shell-ab.json");
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const failed = report.checks.filter((entry) => !entry.passed);
  console.log(`report: ${target}`);
  console.log(`checks: ${report.checks.length - failed.length}/${report.checks.length} passed`);
  for (const entry of failed) console.log(`  FAIL ${entry.name} :: ${entry.detail}`);
  if (report.fatal) console.log(`fatal: ${report.fatal}`);
  console.log(`result: ${report.passed ? "PASS" : "FAIL"}`);
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
