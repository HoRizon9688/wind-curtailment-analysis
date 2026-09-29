/**
 * Synchronous-spawn bridge — an ENVIRONMENT WORKAROUND, not project behaviour.
 *
 * On this machine every `child_process.spawnSync` / `execFileSync` call made by
 * a Node process fails immediately with `EBUSY`, while the asynchronous `spawn`
 * works normally:
 *
 *   spawnSync(process.execPath, ["-e", "1"])            -> EBUSY
 *   execFileSync(process.execPath, ["-e", "1"])         -> EBUSY
 *   spawn(process.execPath, ["-e", "1"]).on(...)        -> exit 0
 *
 * The installed Data build plugin runs Vite through `runDataNode()`, which is a
 * `spawnSync`. Without this bridge the plugin cannot run at all here.
 *
 * The bridge replaces the synchronous entry points with an equivalent built on
 * the asynchronous one: the child runs on a worker thread, its output is spooled
 * to temporary files, and the caller blocks on a SharedArrayBuffer until the
 * worker signals completion. It preserves the documented result shape
 * (`pid`, `status`, `signal`, `stdout`, `stderr`, `output`, `error`) and the
 * `encoding`, `cwd`, `env`, `input`, `timeout`, `windowsHide` and `maxBuffer`
 * options the caller uses.
 *
 * This file does not modify the plugin. It is loaded with
 * `NODE_OPTIONS=--require <this file>` only for build and verification runs
 * recorded in the T0-R handover, and it is inert when nothing spawns.
 */
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

const WORKER_PATH = path.join(__dirname, "sync-spawn-worker.cjs");
const DEFAULT_MAX_BUFFER = 1024 * 1024;

if (!process.env.DATA_APP_SYNC_SPAWN_BRIDGE_ACTIVE) {
  process.env.DATA_APP_SYNC_SPAWN_BRIDGE_ACTIVE = "1";
  let counter = 0;

  function bridgedSpawnSync(command, args, options) {
    const settings = options && typeof options === "object" ? options : {};
    const encoding = settings.encoding ?? null;
    const maxBuffer = Number.isFinite(settings.maxBuffer) ? settings.maxBuffer : DEFAULT_MAX_BUFFER;
    const id = `${process.pid}-${process.hrtime.bigint()}-${++counter}`;
    const resultPath = path.join(os.tmpdir(), `data-app-spawn-bridge-${id}`);
    const signal = new SharedArrayBuffer(4);
    const flag = new Int32Array(signal);

    const worker = new Worker(WORKER_PATH, {
      workerData: {
        command,
        args: Array.isArray(args) ? args : [],
        options: {
          cwd: settings.cwd,
          env: settings.env ?? process.env,
          input: settings.input,
          windowsHide: settings.windowsHide,
        },
        signal,
        resultPath,
      },
    });

    const started = Date.now();
    const timeout = Number.isFinite(settings.timeout) && settings.timeout > 0 ? settings.timeout : 0;
    let timedOut = false;
    while (Atomics.load(flag, 0) === 0) {
      if (timeout && Date.now() - started > timeout) {
        timedOut = true;
        worker.terminate();
        break;
      }
      Atomics.wait(flag, 0, 0, 100);
    }
    if (timedOut && Atomics.load(flag, 0) === 0) {
      const cleanup = () => {
        for (const suffix of [".out", ".err", ".json"]) {
          try {
            fs.unlinkSync(`${resultPath}${suffix}`);
          } catch {
            /* nothing to clean */
          }
        }
      };
      try {
        worker.terminate().then(cleanup, cleanup);
      } catch {
        cleanup();
      }
      return { pid: null, status: null, signal: "SIGTERM", stdout: encode("", encoding), stderr: encode("", encoding), output: [], error: new Error(`spawnSync timed out after ${timeout}ms`) };
    }

    const meta = JSON.parse(fs.readFileSync(`${resultPath}.json`, "utf8"));
    const cap = (buffer) => (buffer.length > maxBuffer ? buffer.subarray(0, maxBuffer) : buffer);
    const stdoutBuffer = cap(fs.readFileSync(`${resultPath}.out`));
    const stderrBuffer = cap(fs.readFileSync(`${resultPath}.err`));
    for (const suffix of [".out", ".err", ".json"]) {
      try {
        fs.unlinkSync(`${resultPath}${suffix}`);
      } catch {
        /* nothing to clean */
      }
    }

    let error = null;
    if (meta.error) {
      error = new Error(meta.error.message);
      if (meta.error.code) error.code = meta.error.code;
    }
    const stdout = encode(stdoutBuffer, encoding);
    const stderr = encode(stderrBuffer, encoding);
    return {
      pid: meta.pid,
      status: meta.status ?? null,
      signal: meta.signal ?? null,
      stdout,
      stderr,
      output: [null, stdout, stderr],
      error,
    };
  }

  function encode(buffer, encoding) {
    return encoding ? buffer.toString(encoding) : buffer;
  }

  function bridgedExecFileSync(command, args, options) {
    const settings = options && typeof options === "object" ? options : {};
    const result = bridgedSpawnSync(command, args, settings);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const failure = new Error(
        `${command} exited with ${result.signal ?? result.status}: ${String(result.stderr ?? "").trim()}`,
      );
      failure.status = result.status;
      failure.signal = result.signal;
      failure.stdout = result.stdout;
      failure.stderr = result.stderr;
      throw failure;
    }
    return settings.encoding && settings.encoding !== "buffer" ? String(result.stdout) : result.stdout;
  }

  childProcess.spawnSync = bridgedSpawnSync;
  childProcess.execFileSync = bridgedExecFileSync;
  childProcess.execSync = (command, options) => {
    const settings = options && typeof options === "object" ? options : {};
    if (settings.shell === false) return bridgedExecFileSync(command, [], settings);
    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
    return bridgedExecFileSync(shell, shellArgs, settings);
  };
}

module.exports = { bridged: Boolean(process.env.DATA_APP_SYNC_SPAWN_BRIDGE_ACTIVE) };
