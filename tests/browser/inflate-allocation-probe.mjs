/** Isolated process: observe real fflate Uint8Array allocations before its import. */
import { makeZip } from '../fixtures/browser/spike/generate.mjs';

const archive = makeZip([
  { name: 'first.bin', data: Buffer.alloc(16_000_000, 0x61) },
  { name: 'later.bin', data: Buffer.alloc(1_000_000, 0x62) },
]);
let measuring = false;
let maximumAllocation = 0;
const original = globalThis.Uint8Array;
globalThis.Uint8Array = new Proxy(original, {
  construct(target, args) {
    const result = Reflect.construct(target, args);
    // Views over a buffer do not allocate storage; numeric and array arguments do.
    if (measuring && !(args[0] instanceof ArrayBuffer)) {
      maximumAllocation = Math.max(maximumAllocation, result.byteLength);
    }
    return result;
  },
});
const { inflateWithLimit, MAX_INFLATE_TEMP_BYTES } = await import('../../dashboard/src/content/calculation/table-reader.mjs');
measuring = true;
try {
  inflateWithLimit(archive, { limit: 2_000_000 });
  throw new Error('Expected the finite synthetic archive to exceed its limit');
} catch (error) {
  if (!(error instanceof RangeError)) throw error;
  console.log(JSON.stringify({ maximumAllocation, declaredAllocationBound: MAX_INFLATE_TEMP_BYTES,
    largestEmission: error.largestEmission, expandedBytes: error.expandedBytes,
    entries: Object.keys(error.perFile ?? {}) }));
} finally {
  globalThis.Uint8Array = original;
}
