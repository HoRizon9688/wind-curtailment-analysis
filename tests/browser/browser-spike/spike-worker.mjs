/**
 * T0 module Worker entry.
 *
 * It reuses `readTable` from the calculation directory instead of holding a
 * second copy of any parsing or formula logic.
 */
import { readTable } from "../../../dashboard/src/content/calculation/table-reader.mjs";

self.onmessage = async (event) => {
  const { name, bytes } = event.data ?? {};
  try {
    const started = performance.now();
    const table = await readTable({ name, bytes });
    const parseMs = performance.now() - started;
    // Sequential walk only: a blocking proxy, not a curtailment rule.
    let finite = 0;
    let sum = 0;
    for (const row of table.rows) {
      const a = Number(row[1]);
      const p = Number(row[3]);
      const g = Number(row[4]);
      if (Number.isFinite(a) && Number.isFinite(p) && Number.isFinite(g)) {
        finite += 1;
        sum += p - Math.min(a, g);
      }
    }
    const totalMs = performance.now() - started;
    self.postMessage({ ok: true, parseMs, totalMs, rows: table.rows.length, finite, sum, sha256: table.sha256 });
  } catch (error) {
    self.postMessage({ ok: false, error: error?.message ?? String(error) });
  }
};
