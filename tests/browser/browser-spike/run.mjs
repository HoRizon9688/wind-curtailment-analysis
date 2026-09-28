/**
 * T0 browser harness.
 *
 * Serves the repository from its parent directory so every resource resolves
 * under `/wind-curtailment-analysis/`, exactly like the GitHub Pages path, then
 * drives headless Chrome against the spike page and collects the page's own
 * results plus the server-side request log.
 *
 * Usage, from the repository root:
 *   node tests/browser/browser-spike/run.mjs
 *
 * Optional: --chrome "<path to chrome.exe>", --port <port>, --keep-open.
 * Nothing is published and no measurement file is read.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SERVE_ROOT = resolve(REPO_ROOT, "..");
const SUB_PATH = `/${REPO_ROOT.split(sep).pop()}`;

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
};

const requestLog = [];
let resolveResult;
const resultPromise = new Promise((resolve) => { resolveResult = resolve; });

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  requestLog.push({ method: request.method, path: url.pathname, bytes: Number(request.headers["content-length"] ?? 0) });

  if (url.pathname === "/__result" && request.method === "POST") {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(204).end();
      try {
        resolveResult(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        resolveResult({ fatal: `unparsable result: ${error.message}`, passed: false });
      }
    });
    return;
  }

  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/u, "");
  const target = resolve(SERVE_ROOT, relative);
  if (!target.startsWith(SERVE_ROOT) || !existsSync(target) || !statSync(target).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
    return;
  }
  response.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });
  createReadStream(target).pipe(response);
});

function findChrome() {
  const requested = argument("--chrome");
  if (requested) return requested;
  const found = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("No Chrome or Edge executable found; pass --chrome <path>.");
  return found;
}

async function main() {
  const port = Number(argument("--port", "9471"));
  await new Promise((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
  const origin = `http://127.0.0.1:${port}`;
  const page = `${origin}${SUB_PATH}/tests/browser/browser-spike/index.html`;

  const chrome = findChrome();
  const profile = join(tmpdir(), `t0-spike-${process.pid}`);
  mkdirSync(profile, { recursive: true });
  const child = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    `--user-data-dir=${profile}`,
    // Every host resolves to the harness, so any attempt to reach the network
    // shows up in the request log instead of silently leaving the machine.
    `--host-resolver-rules=MAP * 127.0.0.1:${port},EXCLUDE 127.0.0.1`,
    // Virtual time is deliberately not enabled: it would speed up
    // performance.now() and invalidate the blocking measurement.
    page,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const chromeLog = [];
  child.stdout.on("data", (chunk) => chromeLog.push(String(chunk)));
  child.stderr.on("data", (chunk) => chromeLog.push(String(chunk)));

  let result;
  try {
    result = await Promise.race([
      resultPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for the page result")), 150_000)),
    ]);
  } catch (error) {
    result = { passed: false, fatal: error.message };
  } finally {
    child.kill();
    server.close();
  }

  const report = {
    ...result,
    subPath: SUB_PATH,
    page,
    chrome: chrome,
    servedRequests: requestLog,
    chromeConsole: chromeLog.join("").slice(0, 4000),
  };
  const directory = join(REPO_ROOT, "reports", "browser-review", "T0");
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "browser-spike.json");
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const failed = (report.checks ?? []).filter((entry) => !entry.passed);
  console.log(`report: ${target}`);
  console.log(`checks: ${(report.checks ?? []).length - failed.length}/${(report.checks ?? []).length} passed`);
  for (const entry of failed) console.log(`  FAIL ${entry.name} — ${entry.detail}`);
  if (report.fatal) console.log(`fatal: ${report.fatal}`);
  console.log(`result: ${report.passed ? "PASS" : "FAIL"}`);
  if (argument("--keep-open")) await new Promise(() => {});
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
