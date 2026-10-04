/**
 * Initial-render smoke checks for `dashboard/src/use-data-app.js`.
 *
 * `useDataApp` resolves `queries` from three candidate sources. The priority
 * order is a product contract, so each path is pinned here:
 *
 *   1. hosted + queryDataStore -> the store's queries (deferred loads, edits)
 *   2. no store, owner edits made -> the owner's queries
 *   3. no store, no owner edits   -> the *current* snapshot's queries
 *
 * Path 3 is the T0-R fix: a static build's analysis is replaced in memory, and
 * `queries` must follow the new snapshot instead of freezing on the first one.
 *
 * SSR creates fresh hook state on each call. These checks do NOT prove updates
 * of an existing component or owner edits. Those run in a real browser in
 * runtime-priority.mjs, including same-instance identity and registered tools.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DASHBOARD = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dashboard");
// The tests tree has no package.json of its own; React resolves through the
// dashboard's node_modules where the app itself installs it. React 19 ships the
// synchronous string renderer in react-dom/server.
const toFileUrl = (p) => `file:///${p.replaceAll("\\", "/")}`;
const { default: React } = await import(toFileUrl(join(DASHBOARD, "node_modules", "react", "index.js")));
const { renderToStaticMarkup } = await import(toFileUrl(join(DASHBOARD, "node_modules", "react-dom", "server.js")));

import { useDataApp } from "../../dashboard/src/use-data-app.js";

/**
 * Renders a probe component that calls `useDataApp` once and records the
 * resulting `queries` object. Returns the recorded value.
 */
function renderOnce(props, recorded) {
  function Probe() {
    const { queries } = useDataApp(props.snapshot, props.options ?? {});
    recorded.push(queries);
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));
  return recorded.at(-1);
}

function snapshotWith(rows) {
  return { title: "t", filters: [], queries: { wind_minutes: { rows, source: { name: "s" } } } };
}

test("a query store supplies queries on an initial hosted render", () => {
  const store = {
    subscribe() { return () => {}; },
    getVersion() { return 1; },
    getQueries() { return snapshotWith([{ store: true }]).queries; },
  };
  const recorded = [];
  const queries = renderOnce(
    { snapshot: snapshotWith([{ snapshot: true }]), options: { hosted: true, queryDataStore: store } },
    recorded,
  );
  assert.deepEqual(queries.wind_minutes.rows, [{ store: true }]);
});

test("independent initial static renders each receive their input snapshot", () => {
  // Independent server renders deliberately do not retain React hook state.
  const first = snapshotWith([{ from: "A" }]);
  const second = snapshotWith([{ from: "B" }]);
  const recorded = [];
  renderOnce({ snapshot: first }, recorded);
  renderOnce({ snapshot: second }, recorded);
  assert.deepEqual(recorded[0].wind_minutes.rows, [{ from: "A" }]);
  assert.deepEqual(recorded[1].wind_minutes.rows, [{ from: "B" }]);
});

test("independent initial hosted renders each read the then-current store", () => {
  // Deferred load: the store's queries and version change between renders.
  // Each render snapshot is captured at its own moment (the store object is
  // mutable), so this pins that the hook keeps reading the store after the
  // snapshot itself has also moved on.
  const storeQueriesA = { wind_minutes: { rows: [{ store: 1 }], source: { name: "s" } } };
  const storeQueriesB = { wind_minutes: { rows: [{ store: 2 }], source: { name: "s" } } };
  let version = 1;
  let current = storeQueriesA;
  const store = {
    subscribe() { return () => {}; },
    getVersion() { return version; },
    getQueries() { return current; },
  };
  const recorded = [];
  renderOnce({ snapshot: snapshotWith([{ snapshot: 1 }]), options: { hosted: true, queryDataStore: store } }, recorded);
  current = storeQueriesB;
  version = 2;
  renderOnce({ snapshot: snapshotWith([{ snapshot: 2 }]), options: { hosted: true, queryDataStore: store } }, recorded);
  assert.deepEqual(recorded[0].wind_minutes.rows, [{ store: 1 }]);
  assert.deepEqual(recorded[1].wind_minutes.rows, [{ store: 2 }]);
});

test("owner edits are absent from a plain static render, so the snapshot supplies queries", () => {
  // On a static build the owner-edit path is not exercised by content; the
  // initial state must therefore fall straight through to snapshot.queries.
  const snapshot = snapshotWith([{ plain: 1 }]);
  const recorded = [];
  const queries = renderOnce({ snapshot, options: { hosted: false } }, recorded);
  assert.equal(queries, snapshot.queries);
  assert.deepEqual(queries.wind_minutes.rows, [{ plain: 1 }]);
});

test("filters still initialise from the snapshot and remain writable state", () => {
  const snapshot = { title: "t", filters: [{ id: "region", defaultValue: "north" }], queries: {} };
  const recorded = [];
  function Probe() {
    const { filters, setFilter } = useDataApp(snapshot, {});
    recorded.push({ filters, setFilter });
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));
  const { filters, setFilter } = recorded[0];
  assert.equal(filters.region, "north");
  assert.equal(typeof setFilter, "function");
});
