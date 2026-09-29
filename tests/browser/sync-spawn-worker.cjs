/**
 * Worker half of the synchronous-spawn bridge.
 *
 * Runs one child process with the ordinary asynchronous API and writes the
 * captured output next to `resultPath`, then releases the caller through a
 * SharedArrayBuffer. The caller (main thread) is blocked in `Atomics.wait` and
 * therefore cannot service events, which is why the child has to run here.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { workerData } = require("node:worker_threads");

const { command, args, options, signal, resultPath } = workerData;
const flag = new Int32Array(signal);
let settled = false;

const outFd = fs.openSync(`${resultPath}.out`, "w");
const errFd = fs.openSync(`${resultPath}.err`, "w");

function finish(payload) {
  if (settled) return;
  settled = true;
  try {
    fs.writeFileSync(`${resultPath}.json`, JSON.stringify(payload));
  } catch (error) {
    fs.writeFileSync(`${resultPath}.json`, JSON.stringify({ status: null, signal: null, error: { message: String(error) } }));
  }
  for (const fd of [outFd, errFd]) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
}

let child;
try {
  child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: options.windowsHide !== false,
    stdio: ["pipe", "pipe", "pipe"],
  });
} catch (error) {
  finish({ status: null, signal: null, pid: null, error: { message: error.message, code: error.code ?? null } });
  process.exit(0);
}

child.stdout.on("data", (chunk) => fs.writeSync(outFd, chunk));
child.stderr.on("data", (chunk) => fs.writeSync(errFd, chunk));
child.on("error", (error) =>
  finish({ status: null, signal: null, pid: child.pid ?? null, error: { message: error.message, code: error.code ?? null } }),
);
child.on("close", (status, terminationSignal) =>
  finish({ status, signal: terminationSignal, pid: child.pid ?? null, error: null }),
);

try {
  if (options.input !== undefined && options.input !== null) child.stdin.end(options.input);
  else child.stdin.end();
} catch {
  /* the child may have exited already */
}
