/** Browser-only tests of the actual hook, retaining one mounted component. */
import React, { useRef } from '../../dashboard/node_modules/react/index.js';
import { createRoot } from '../../dashboard/node_modules/react-dom/client.js';
import { flushSync } from '../../dashboard/node_modules/react-dom/index.js';
import { useDataApp } from '../../dashboard/src/use-data-app.js';

export async function runtimePriorityChecks() {
  const checks = [];
  const check = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), detail });
  const queries = (label) => ({ wind_minutes: { rows: [{ label }], source: { name: label } } });
  const snapshot = (label) => ({ title: 'Synthetic hook regression', filters: [{ id: 'region', defaultValue: 'north' }], queries: queries(label) });
  const tools = new Map();
  const contextDescriptor = Object.getOwnPropertyDescriptor(document, 'modelContext');
  const originalFetch = globalThis.fetch;
  let state;
  let token;
  const callbacks = [];
  const requests = [];
  const host = document.createElement('div');
  host.hidden = true;
  document.body.append(host);
  const root = createRoot(host);
  function Probe({ input, options }) {
    token = useRef({}).current;
    state = useDataApp(input, options);
    return React.createElement('output', null, state.queries.wind_minutes.rows[0]?.label);
  }
  const render = (input, options = {}) => flushSync(() => root.render(React.createElement(Probe, { input, options })));
  const label = () => state.queries.wind_minutes.rows[0]?.label;
  try {
    render(snapshot('A'));
    const originalToken = token;
    flushSync(() => state.setFilter('region', 'south'));
    render(snapshot('B'));
    check('static queries update A -> B on the SAME mounted hook', label() === 'B' && token === originalToken,
      { label: label(), sameInstance: token === originalToken });
    check('static data updates preserve an existing filter selection', state.filters.region === 'south', state.filters);

    Object.defineProperty(document, 'modelContext', { configurable: true, value: {
      registerTool(tool) { tools.set(tool.name, tool); },
      unregisterTool(name) { tools.delete(name); },
    } });
    const ownerOptions = { hosted: true, canEdit: true, onSnapshotChange(update) { callbacks.push(update); } };
    render(snapshot('owner-snapshot'), ownerOptions);
    check('hosted owner tools actually register after mounting', tools.has('update_data_app_query'), [...tools.keys()]);
    // A test-local response, never a network request or a product upload.
    globalThis.fetch = async (url, options) => {
      requests.push({ url, method: options.method, body: JSON.parse(options.body) });
      const rows = JSON.parse(options.body).rows;
      return { ok: true, async json() { return { queryId: 'wind_minutes', rows,
        executedAt: '2026-02-01T00:00:00+08:00', generatedAt: '2026-02-01T00:00:00+08:00' }; } };
    };
    await tools.get('update_data_app_query').execute({ queryId: 'wind_minutes', rows: [{ label: 'owner-edit' }] });
    flushSync(() => {});
    render(snapshot('later-snapshot'), ownerOptions);
    const updated = callbacks.at(-1)?.(snapshot('owner-snapshot'));
    check('real owner editing wins over a later snapshot without a query store',
      label() === 'owner-edit' && updated?.queries.wind_minutes.rows[0].label === 'owner-edit',
      { hookLabel: label(), callbackLabel: updated?.queries.wind_minutes.rows[0].label });
    check('owner update retains query source metadata and execution time',
      updated?.queries.wind_minutes.source.name === 'owner-snapshot'
        && updated?.queries.wind_minutes.source.executedAt === '2026-02-01T00:00:00+08:00',
      updated?.queries.wind_minutes.source);
    check('owner tool uses the existing PUT query endpoint',
      requests.length === 1 && requests[0].url === '/api/queries/wind_minutes' && requests[0].method === 'PUT', requests);

    let currentQueries = queries('store-A');
    let version = 0;
    let allLoads = 0;
    const listeners = new Set();
    const store = {
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      getVersion() { return version; },
      getQueries() { return currentQueries; },
      async loadAll() { allLoads += 1; },
      replace(queryId, rows, executedAt) { currentQueries = { ...currentQueries, [queryId]: {
        ...currentQueries[queryId], rows, source: { ...currentQueries[queryId].source, executedAt } } };
        version += 1; listeners.forEach((listener) => listener()); },
    };
    const storeOptions = { ...ownerOptions, queryDataStore: store };
    render(snapshot('ignored-snapshot'), storeOptions);
    check('hosted queryDataStore wins over snapshot AND existing owner edit state', label() === 'store-A', label());
    flushSync(() => { currentQueries = queries('store-B'); version += 1; listeners.forEach((listener) => listener()); });
    check('a deferred store notification updates the same mounted hook without remounting',
      label() === 'store-B' && token === originalToken, { label: label(), sameInstance: token === originalToken });
    render(snapshot('another-ignored-snapshot'), storeOptions);
    check('store priority survives a new snapshot', label() === 'store-B', label());
    await tools.get('update_data_app_query').execute({ queryId: 'wind_minutes', rows: [{ label: 'store-owner-edit' }] });
    flushSync(() => {});
    render(snapshot('still-ignored'), storeOptions);
    check('hosted owner edit loads and replaces store data using the existing path',
      label() === 'store-owner-edit' && allLoads === 1 && currentQueries.wind_minutes.source.name === 'store-B',
      { label: label(), allLoads, source: currentQueries.wind_minutes.source });
    render(snapshot('read-only'), { ...storeOptions, canEdit: false });
    check('read-only hosted users do not retain owner update tools', tools.size === 0, [...tools.keys()]);
  } finally {
    globalThis.fetch = originalFetch;
    flushSync(() => root.unmount());
    host.remove();
    if (contextDescriptor) Object.defineProperty(document, 'modelContext', contextDescriptor);
    else delete document.modelContext;
  }
  return { checks, testLocalResponses: true, networkRequests: 0 };
}
