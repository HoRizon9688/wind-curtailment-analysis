/**
 * Lists protected runtime files whose current digest differs from the manifest,
 * so an authorization scope can be checked before it is applied.
 *
 * Lives under tests/ rather than dashboard/scripts/ because that directory is
 * product-owned; this is read-only review tooling, not part of the runtime.
 *
 * Usage, from the repository root:
 *   node tests/browser/list-changed-protected-files.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "dashboard");
const { digestProtectedFile } = await import(new URL("../../dashboard/scripts/protected-file-digest.mjs", import.meta.url).href);

const manifest = JSON.parse(readFileSync(join(root, "protected-runtime.json"), "utf8"));
const changed = [];
const missing = [];
for (const [path, expected] of Object.entries(manifest.files)) {
  try {
    if (digestProtectedFile(path, readFileSync(join(root, path))) !== expected) changed.push(path);
  } catch {
    missing.push(path);
  }
}
console.log(JSON.stringify({ changed, missing }, null, 2));
