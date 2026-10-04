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
import { gunzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SERVE_ROOT = resolve(REPO_ROOT, "..");
const PREFIX = `/${REPO_ROOT.split(sep).pop()}`;
const REPORT_DIR = join(REPO_ROOT, "reports", "browser-review", "T0");

// The B fixture, loaded once so the export comparison below compares the
// download against the very object the shell committed.
const FIXTURE_B = JSON.parse(gunzipSync(readFileSync(join(REPO_ROOT, "tests", "fixtures", "browser", "analysis-b.json.gz"))));

/**
 * CSV column -> fixture row field, mirroring `csvText` in wind-model.mjs.
 * Number fields compare with a tolerance; everything else compares as text.
 */
const EXPORT_FIELD_MAP = {
  "时间": "timestamp",
  "可用_MW": "a",
  "理论_MW": "theory",
  "实发_MW": "p",
  "AGC_MW": "g",
  "预测_线性插值_MW": "f",
  "调度限电_MWh": "dispatch",
  "预测限电_MWh": "prediction",
  "待核实_MWh": "other",
  "指令以上待核实_MWh": "above",
  "指令以下待核实_MWh": "below",
  "正差额_MWh": "gap",
  "状态": "status",
  "左端预测版本": "version",
  "右端预测版本": "rightVersion",
  "左端目标时间": "target",
  "右端目标时间": "rightTarget",
  "左端预测_MW": "leftF",
  "右端预测_MW": "rightF",
  "插值权重": "weight",
  "参与计算": "included",
  "说明或排除原因": "note",
  "分钟功率来源": "powerSource",
  "左端预测来源": "forecastSource",
  "右端预测来源": "rightForecastSource",
  "场站指令以下未发_MWh": "operationalBelow",
  "指令以上原因未明_MWh": "unexplainedAbove",
  "指令以上小偏差_MWh": "noiseAbove",
  "指令以下小偏差_MWh": "noiseBelow",
  "调度状态": "dispatchState",
  "预测低估状态": "predictionState",
  "预测跟随状态": "following",
  "AGC下限跟随状态": "floorFollowing",
  "跟随比较基准_MW": "trackingReference",
};
const NUMERIC_EXPORT_FIELDS = new Set(["a", "theory", "p", "g", "f", "dispatch", "prediction", "other", "above", "below", "gap", "leftF", "rightF", "weight", "operationalBelow", "unexplainedAbove", "noiseAbove", "noiseBelow", "trackingReference"]);

/** RFC 4180 parser for the exported file (BOM stripped, CRLF aware). */
function parseCsv(text) {
  const rows = [[]];
  let cell = "";
  let quoted = false;
  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { cell += '"'; index += 1; }
        else quoted = false;
      } else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { rows.at(-1).push(cell); cell = ""; }
    else if (character === "\r" && text[index + 1] === "\n") { rows.at(-1).push(cell); cell = ""; rows.push([]); index += 1; }
    else if (character === "\n") { rows.at(-1).push(cell); cell = ""; rows.push([]); }
    else cell += character;
  }
  rows.at(-1).push(cell);
  const header = rows.shift();
  if (rows.length && rows.at(-1).length === 1 && rows.at(-1)[0] === "") rows.pop();
  return { header, data: rows.map((row) => Object.fromEntries(header.map((name, column) => [name, row[column] ?? ""]))) };
}

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

    // ------------------------------------------------ illegal commits keep A
    // (Synchronous refusal only. Cancelling an in-flight job and dropping late
    // results is T4 scope and is NOT claimed here.)
    for (const [name, expression] of [
      ["a commit without rows", "window.__T0__.commitWithoutRows()"],
      ["a commit naming an unreviewed query", "window.__T0__.commitUnknownQuery()"],
      ["a commit targeting a shell-owned field", "window.__T0__.commitReservedNamespace()"],
      ["a commit targeting the shell-read `report` field (T0-R2 S1)", "window.__T0__.commitReportNamespace()"],
      ["a commit targeting the shell-read `visibleReportFilters` field (T0-R2 S1)", "window.__T0__.commitVisibleReportFiltersNamespace()"],
      ["a commit naming an unregistered namespace (T0-R2 S1)", "window.__T0__.commitUnknownNamespace()"],
      ['an unknown namespace with no analysis payload', 'window.__T0__.commitUnknownNamespaceWithoutAnalysis()'],
    ]) {
      let failed = null;
      try {
        await evaluate(expression);
      } catch (error) {
        failed = String(error.message);
      }
      check(`${name} is refused by the shell`, failed !== null, failed ?? "no error raised");
      check(`${name} preserves A immediately`,
        JSON.stringify(await evaluate('window.__T0__.state()')) === JSON.stringify(stateA)
        && JSON.stringify(await evaluate(dom)) === JSON.stringify(domA));
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

    // ------------------------------------------- source panel (T0-R2, real UI)
    // Open the shell's own source inspector for a reviewed component through
    // its real UI (component menu -> "View data source"), then read back what
    // the sidebar actually rendered: the reviewed query's source metadata and
    // its row content. This is more than reading the test hook's fields.
    const sourcePanel = await evaluate(`(() => {
      const select = [...document.querySelectorAll('select[aria-label$="actions"]')]
        .find((node) => node.getAttribute('aria-label').startsWith('功率曲线与限电面积'));
      if (!select) return { opened: false, reason: "no component action menu" };
      const option = [...select.options].find((o) => o.textContent === "View data source");
      if (!option) return { opened: false, reason: "no View data source item" };
      option.selected = true;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return { opened: true };
    })()`);
    // The sidebar paints its header first and fills the query sections
    // asynchronously, so wait for real content, not merely the container.
    await waitFor(() => evaluate(
      "(() => { const p = document.querySelector('.source-sidebar'); return Boolean(p && p.textContent.length > 60); })()",
    ), { label: "the source sidebar to fill in", timeout: 15_000 }).catch(() => null);
    const sourceContent = await evaluate(`(() => {
      const panel = document.querySelector(".source-sidebar");
      if (!panel) return { rendered: false };
      const text = panel.textContent;
      return {
        rendered: true,
        text: text.slice(0, 6000),
        rows: [...panel.querySelectorAll("tbody tr")].length,
      };
    })()`);
    report.sourcePanel = { trigger: sourcePanel, content: sourceContent };
    check("the component menu exposes View data source", sourcePanel.opened === true, sourcePanel);
    check("the source sidebar actually renders for B", sourceContent.rendered === true, sourceContent.rendered);
    if (sourceContent.rendered) {
      // The sidebar's own surface for a reviewed query's source metadata is
      // its file list and caveats (station name and period are rendered by the
      // dashboard header, asserted separately in domB). Commit B replaced this
      // source, so exactly B's provenance has to appear in the panel.
      const sourceText = sourceContent.text ?? "";
      check("the source sidebar lists B's two synthetic input files",
        sourceText.includes("synthetic-SYNTHETIC_B-minute-power.csv")
          && sourceText.includes("synthetic-SYNTHETIC_B-forecast.csv"),
        { power: sourceText.includes("synthetic-SYNTHETIC_B-minute-power.csv"), forecast: sourceText.includes("synthetic-SYNTHETIC_B-forecast.csv") });
      check("the source sidebar shows B's caveat text and never A's files",
        sourceText.includes("全部为合成数据") && !sourceText.includes("SYNTHETIC_A"),
        { caveat: sourceText.includes("全部为合成数据"), leakedA: sourceText.includes("SYNTHETIC_A") });
    }
    const dataTabClicked = await evaluate(`(() => {
      const tab = [...document.querySelectorAll('.source-sidebar [role="tab"]')]
        .find((node) => node.textContent === 'Data preview');
      tab?.click();
      return Boolean(tab);
    })()`);
    await waitFor(() => evaluate("Boolean(document.querySelector('.source-sidebar [role=tabpanel]:not([hidden]) tbody tr'))"),
      { label: 'B source data preview', timeout: 15_000 });
    const preview = await evaluate(`(() => {
      const table = document.querySelector('.source-sidebar [role="tabpanel"]:not([hidden]) table');
      return { headers: [...table.querySelectorAll('thead th')].map((node) => node.textContent.trim()),
        rows: [...table.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim())) };
    })()`);
    report.sourcePanel.preview = preview;
    const expectedDates = await evaluate(`(${JSON.stringify(FIXTURE_B.rows.slice(0, preview.rows.length).map((row) => row.date))})
      .map((date) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
        .format(new Date(date + 'T00:00:00Z'))) `);
    check('B source preview opens and displays B business dates and minute clocks',
      dataTabClicked && preview.rows.length > 0 && preview.rows.every((row, index) =>
        row[preview.headers.indexOf('Date')] === expectedDates[index]
        && row[preview.headers.indexOf('Time')] === FIXTURE_B.rows[index].time),
      { visibleRows: preview.rows.length, firstBusinessDate: preview.rows[0]?.[1], firstClock: preview.rows[0]?.[2] });
    // DataTable displays numbers to two decimal places. Verify all four input
    // powers at each actually visible row, using the same documented display precision.
    const headerLabel = (field) => field.replace(/([a-z\d])([A-Z])/gu, '$1 $2').replaceAll('_', ' ')
      .split(' ').map((word, index) => index ? word.toLowerCase() : word[0].toUpperCase() + word.slice(1)).join(' ');
    let previewMismatches = 0;
    for (let index = 0; index < preview.rows.length; index += 1) {
      for (const field of ['a', 'p', 'g', 'f']) {
        const column = preview.headers.indexOf(headerLabel(field));
        const expected = FIXTURE_B.rows[index][field];
        const cell = preview.rows[index][column];
        const same = field === 'timestamp' ? cell === expected
          : expected == null ? cell === '—' : Math.abs(Number(cell?.replaceAll(',', '')) - expected) <= 0.0051;
        if (column < 0 || !same) previewMismatches += 1;
      }
    }
    check('B source preview power values match B at every visible minute', previewMismatches === 0,
      { previewMismatches, visibleRows: preview.rows.length });
    // Close the sidebar so later screenshots/exports are unaffected.
    await evaluate("document.querySelector('button[aria-label=\"Close data source\"]')?.click() ?? true");

    // ------------------------------------------------------------- CSV export
    await evaluate("[...document.querySelectorAll('.wind-period-heading button')].find((b) => b.textContent.includes('导出整期分钟明细'))?.click() ?? true");
    const exported = await waitFor(() => {
      const files = readdirSync(downloadDir).filter((name) => name.endsWith(".csv"));
      return files.length ? files : null;
    }, { label: "the exported CSV", timeout: 30_000 });
    const exportText = readFileSync(join(downloadDir, exported[0]), "utf8");
    report.export = { name: exported[0], bytes: exportText.length, head: exportText.slice(0, 200) };
    check("the CSV export is named for analysis B", exported[0].includes("合成乙场站") && exported[0].includes("2026-02-01"), exported[0]);

    // T0-R2: parse the downloaded CSV and compare field by field against the B
    // fixture's own rows, instead of only asserting that B's date appears.
    const parsedExport = parseCsv(exportText);
    const fixtureRows = FIXTURE_B.rows;
    report.export.columns = parsedExport.header.length;
    check("the export header carries every csvText column",
      JSON.stringify(Object.keys(EXPORT_FIELD_MAP)) === JSON.stringify(parsedExport.header),
      parsedExport.header);
    check("the exported CSV has a UTF-8 BOM and exactly one row per minute",
      exportText.charCodeAt(0) === 0xfeff && parsedExport.data.length === fixtureRows.length,
      { exportedRows: parsedExport.data.length, fixtureRows: fixtureRows.length });
    let fieldMismatches = 0;
    const firstMismatch = { row: null, field: null, exported: null, fixture: null };
    for (let index = 0; index < Math.min(parsedExport.data.length, fixtureRows.length); index += 1) {
      const exportedRow = parsedExport.data[index];
      const fixtureRow = fixtureRows[index];
      for (const [column, field] of Object.entries(EXPORT_FIELD_MAP)) {
        const actual = exportedRow[column];
        const want = fixtureRow[field];
        const safeText = typeof want === 'string' && /^[\s]*[=+@-]/u.test(want) ? "'" + want : String(want ?? '');
        const same = want == null ? actual === '' : NUMERIC_EXPORT_FIELDS.has(field)
          ? actual !== '' && Number.isFinite(Number(actual)) && Math.abs(Number(actual) - want) < 1e-6
          : actual === safeText;
        if (!same) {
          fieldMismatches += 1;
          if (firstMismatch.row === null) {
            Object.assign(firstMismatch, { row: index, field: column, exported: actual, fixture: want });
          }
        }
      }
    }
    check("every exported field matches the B fixture row by row",
      fieldMismatches === 0, { fieldMismatches, firstMismatch });
    check("the export carries B's date and never A's",
      exportText.includes("2026-02-01") && !exportText.includes("2026-01-01"), exportText.slice(0, 300));

    // ---------------------------------------------------------------- privacy
    const storageSnapshot = `(async () => ({
      localStorage: Object.entries({ ...localStorage }),
      sessionStorage: Object.entries({ ...sessionStorage }),
      indexedDb: await indexedDB.databases().then((d) => d.map((e) => e.name)),
      caches: await caches.keys()
    }))()`;
    // Storage detector positive control FIRST: prove the detector can see
    // synthetic data written on purpose, so an empty report means "no data was
    // written", not "the detector is blind".
    const controlWrite = await evaluate(`(async () => {
      const marker = ${JSON.stringify(MARKER)};
      localStorage.setItem("t0r2-control", marker);
      sessionStorage.setItem("t0r2-control", marker);
      const request = indexedDB.open("t0r2-control-db", 1);
      await new Promise((resolve, reject) => {
        request.onupgradeneeded = () => request.result.createObjectStore("c");
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
      });
      const write = request.result.transaction("c", "readwrite").objectStore("c").put(marker, "k");
      await new Promise((resolve, reject) => { write.onsuccess = resolve; write.onerror = () => reject(write.error); });
      request.result.close();
      const cache = await caches.open("t0r2-control-cache");
      await cache.put("/t0r2-control", new Response(marker));
      return true;
    })()`);
    const controlSeen = await evaluate(`(async () => ({
      localStorage: localStorage.getItem("t0r2-control"),
      indexedDb: await new Promise((resolve) => {
        const request = indexedDB.open("t0r2-control-db", 1);
        request.onsuccess = () => {
          const read = request.result.transaction("c").objectStore("c").get("k");
          read.onsuccess = () => { request.result.close(); resolve(read.result); };
          read.onerror = () => resolve(null);
        };
        request.onerror = () => resolve(null);
      }),
      cache: await caches.open("t0r2-control-cache").then((c) => c.match("/t0r2-control")).then((r) => r && r.text()),
    }))()`);
    check("the storage detector sees deliberately written synthetic data",
      controlWrite === true
        && controlSeen.localStorage === MARKER
        && controlSeen.indexedDb === MARKER
        && controlSeen.cache === MARKER, controlSeen);
    const controlInventory = await evaluate(storageSnapshot);
    check('the SAME storage inventory detects all four positive controls',
      controlInventory.localStorage.some(([key, value]) => key === 't0r2-control' && value === MARKER)
      && controlInventory.sessionStorage.some(([key, value]) => key === 't0r2-control' && value === MARKER)
      && controlInventory.indexedDb.includes('t0r2-control-db')
      && controlInventory.caches.includes('t0r2-control-cache'), controlInventory);
    // Clean the control up so the real assertions below see the app's own state.
    await evaluate(`(async () => {
      localStorage.removeItem("t0r2-control");
      sessionStorage.removeItem("t0r2-control");
      const request = indexedDB.deleteDatabase("t0r2-control-db");
      await new Promise((resolve) => { request.onsuccess = resolve; request.onerror = resolve; request.onblocked = resolve; });
      await caches.delete("t0r2-control-cache");
      return true;
    })()`);

    const storage = await evaluate(storageSnapshot);
    report.storage = storage;
    check("the shell writes no analysis data to browser storage",
      !JSON.stringify(storage).includes("合成") && !JSON.stringify(storage).includes(MARKER), storage);
    // T0-R2: an empty expectation is asserted as empty, not merely enumerated.
    check("the app creates no IndexedDB databases of its own",
      Array.isArray(storage.indexedDb) && storage.indexedDb.length === 0, storage.indexedDb);
    check("the app creates no Cache Storage entries of its own",
      Array.isArray(storage.caches) && storage.caches.length === 0, storage.caches);
    check('only the known presentation record is persisted, with no session storage',
      storage.localStorage.length === 1 && storage.localStorage.every(([key]) => key.startsWith('data-app:presentation:v1:'))
      && storage.sessionStorage.length === 0, { keys: storage.localStorage.map(([key]) => key), session: storage.sessionStorage });
    // The shell does autosave presentation preferences. Record exactly which
    // fields persist so a later change that starts storing analysis data in them
    // is visible rather than assumed.
    const presentationKeys = Object.keys(JSON.parse(storage.localStorage[0]?.[1] ?? "{}").presentation ?? {});
    report.autosavedPresentationKeys = presentationKeys;
    const analysisKeys = ["rows", "summary", "daily", "gaps", "meta", "sha256", "files", "stationName", "capacity"];
    const preferenceKeys = new Set(['theme', 'appearance', 'title', 'hiddenBlocks', 'componentTitles', 'textEdits',
      'chartOverrides', 'filters', 'assumptions', 'tabs', 'blockLayouts']);
    check("the autosaved presentation holds preferences only, never analysis data",
      presentationKeys.length > 0 && presentationKeys.every((key) => preferenceKeys.has(key))
      && !presentationKeys.some((key) => analysisKeys.includes(key)), presentationKeys);
    check("the autosaved presentation names no station, file or hash",
      !/(?:合成|\.csv|\.xls|sha256)/u.test(storage.localStorage[0]?.[1] ?? ""), (storage.localStorage[0]?.[1] ?? "").slice(0, 160));

    // T0-R2: the file input exists on the upload panel; what must not happen is
    // any request carrying file content, which the request-body checks below
    // cover (the marker exists in the synthetic CSV fixtures).
    const upload = await evaluate("Boolean(document.querySelector('input[type=file]'))");
    check("the upload panel renders its file input", upload === true, upload);

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
  // The CDP WebSocket and keep-alive sockets keep the event loop alive after
  // the report is written; the run itself is done.
  process.exit(process.exitCode);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
