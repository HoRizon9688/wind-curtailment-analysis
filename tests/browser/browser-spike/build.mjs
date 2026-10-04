/**
 * Bundles the browser-spike page and its Worker with the project's own Vite, so
 * the harness exercises the real module graph (including `read-excel-file` and
 * `fflate`) instead of raw ES modules that cannot resolve bare specifiers.
 *
 * Output goes to the gitignored `reports/browser-review/T0/spike-build/`.
 * Called by run.mjs; not meant to be run on its own.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const DASHBOARD = join(REPO_ROOT, "dashboard");
const OUT_DIR = join(REPO_ROOT, "reports", "browser-review", "T0", "spike-build");

const PAGE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>T0 browser spike</title>
    <style>
      body { margin: 0; padding: 24px; font: 14px/1.5 system-ui, sans-serif; background: #fff; color: #111; }
      h1 { font-size: 18px; margin: 0 0 12px; }
      pre { white-space: pre-wrap; word-break: break-word; background: #f5f5f5; padding: 16px; border-radius: 8px; }
    </style>
  </head>
  <body>
    <h1>T0 browser spike — 仓库子路径下的读取、Worker 与隐私</h1>
    <p>本页只做技术验证，不包含任何限电规则。</p>
    <pre id="result">running…</pre>
    <script type="module" src="./spike-page.js"></script>
  </body>
</html>
`;

export async function buildSpike() {
  const { build } = await import(new URL("file:///" + join(DASHBOARD, "node_modules", "vite", "dist", "node", "index.js").replaceAll("\\", "/")).href);
  mkdirSync(OUT_DIR, { recursive: true });
  await build({
    root: DASHBOARD,
    configFile: false,
    logLevel: "warn",
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      outDir: OUT_DIR,
      emptyOutDir: true,
      minify: false,
      target: "es2022",
      lib: {
        entry: {
          "spike-page": join(HERE, "spike-page.mjs"),
          "spike-worker": join(HERE, "spike-worker.mjs"),
        },
        formats: ["es"],
        fileName: (_format, name) => `${name}.js`,
      },
    },
  });
  writeFileSync(join(OUT_DIR, "index.html"), PAGE, "utf8");
  return OUT_DIR;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  console.log(`built spike harness into ${await buildSpike()}`);
}
