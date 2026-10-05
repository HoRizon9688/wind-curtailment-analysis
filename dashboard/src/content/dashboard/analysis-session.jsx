/**
 * Business session for a browser-side station analysis.
 *
 * Committing a finished analysis is a single call so the shell never shows a
 * mixture of the new rows with the previous summary, daily list, exclusion
 * intervals or station name. The commit is atomic: if anything before the call
 * throws, nothing is replaced.
 *
 * The mechanism lives in the protected shell (`commitAnalysis` in the shell
 * context) and is only available on a static build. On a hosted publication the
 * shell owns its data and refuses the commit, so this module must not be used
 * as a publication write path.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useDataApp } from "../../data-app-public.jsx";
import { readTable } from "../calculation/table-reader.mjs";
import {createCalculationClient} from '../calculation/calculation-browser.mjs';
import {createAnalysisSession,analysisCommitPayload} from './analysis-session-model.mjs';

/** Reviewed query that carries the per-minute analysis rows. */
export const ANALYSIS_QUERY_ID = "wind_minutes";
/** Authored snapshot namespace that carries meta/summary/daily/gaps. */
export const ANALYSIS_NAMESPACE = "wind";

/**
 * Returns `commit(analysis)`.
 *
 * `analysis` must be a complete result: `{rows, meta, summary, daily, gaps}` and
 * optionally `source` provenance metadata for the reviewed query. Fields are
 * validated before the shell sees them, so a partial result is refused instead
 * of rendering as a half-updated analysis.
 */
export function useAnalysisCommit() {
  const { commitAnalysis,setFilter,snapshot } = useDataApp();
  return useCallback(
    (analysis,revision) => {
      if(analysis?.calibration){
        commitAnalysis(analysisCommitPayload(analysis,revision));
        for(const filter of snapshot.filters??[])setFilter(filter.id,filter.defaultValue??'all');
        return;
      }
      if (!analysis || typeof analysis !== "object") {
        throw new Error("一次分析提交需要完整结果对象。");
      }
      const { rows, meta, summary, daily, gaps, source } = analysis;
      if (!Array.isArray(rows) || !rows.length) {
        throw new Error("分析结果缺少逐分钟行，已保留上一次成功分析。");
      }
      if (!meta || !summary || !Array.isArray(daily) || !Array.isArray(gaps)) {
        throw new Error("分析结果缺少 meta / summary / daily / gaps，已保留上一次成功分析。");
      }
      return commitAnalysis({
        queryId: ANALYSIS_QUERY_ID,
        rows,
        ...(source === undefined ? {} : { source }),
        namespace: ANALYSIS_NAMESPACE,
        analysis: { meta, summary, daily, gaps },
      });
    },
    [commitAnalysis,setFilter,snapshot.filters],
  );
}

export function useBrowserAnalysis() {
 const commit=useAnalysisCommit(),commitRef=useRef(commit),sessionRef=useRef(null);
 commitRef.current=commit;
 const [state,setState]=useState({status:'idle',progress:null,error:null});
 useEffect(()=>{
  const session=createAnalysisSession({createClient:createCalculationClient,commit:(r,id)=>commitRef.current(r,id),onState:setState});
  sessionRef.current=session;
  return()=>{session.dispose();if(sessionRef.current===session)sessionRef.current=null;};
 },[]);
 return {state,start:input=>sessionRef.current?.start(input),cancel:()=>sessionRef.current?.cancel()};
}

/** Fraction of the repository root the static fixtures live under. */
function fixturePrefix() {
  const requested = new URLSearchParams(globalThis.location?.search ?? "").get("t0-prefix");
  if (requested) return requested.replace(/\/$/u, "");
  // The app is served under the repository's own directory name, so the first
  // path segment is the same prefix the build uses. Deriving it here keeps the
  // fixture URL and the served prefix from being configured in two places.
  const segment = (globalThis.location?.pathname ?? "/").split("/")[1] ?? "";
  return segment ? `/${segment}` : "";
}

async function loadAnalysisFixture(name) {
  const response = await fetch(`${fixturePrefix()}/tests/fixtures/browser/${name}`);
  if (!response.ok) throw new Error(`无法加载合成对照夹具 ${name}（HTTP ${response.status}）`);
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

/**
 * Reads a spike fixture through the real adapter inside the built app. This is
 * what puts the parsing dependency into the app bundle and proves the library's
 * browser entry, content detection and 150 MB gate work under the served
 * sub-path rather than only under Node.
 */
async function readSpikeFixture(name) {
  const response = await fetch(`${fixturePrefix()}/tests/fixtures/browser/spike/${name}`);
  if (!response.ok) throw new Error(`无法加载夹具 ${name}（HTTP ${response.status}）`);
  const table = await readTable({ name, bytes: await response.arrayBuffer() });
  return {
    name: table.name,
    format: table.format,
    sheetName: table.sheetName ?? null,
    date1904: table.date1904 ?? null,
    sha256: table.sha256,
    bytes: table.bytes,
    expandedBytes: table.expandedBytes ?? null,
    rowCount: table.rows.length,
    header: table.rows[0] ?? [],
    firstDate: table.rows[1]?.[2] instanceof Date ? table.rows[1][2].toISOString() : null,
  };
}

/**
 * T0-R evidence scaffolding. Mounted only when the URL carries `?t0-harness`,
 * so ordinary previews and publications render exactly as before. It exists to
 * drive real synthetic analyses through the real shell; the product upload
 * experience is T5's work and will replace this.
 */
export function T0AnalysisHarness() {
  const commit = useAnalysisCommit();
  const shell = useDataApp();
  useEffect(() => {
    const enabled = new URLSearchParams(globalThis.location?.search ?? "").has("t0-harness");
    if (!enabled) return undefined;
    const harness = {
      load: loadAnalysisFixture,
      readFixture: readSpikeFixture,
      /**
       * Exactly what the shell exposes to charts, the source inspector and the
       * export helpers, so a test can compare them against one another.
       */
      state() {
        const { snapshot, queries } = shell;
        const analysis = snapshot.wind ?? {};
        const rows = queries.wind_minutes?.rows ?? [];
        return {
          appId: snapshot.id ?? null,
          surface: snapshot.surface ?? null,
          stationName: analysis.meta?.stationName ?? null,
          capacity: analysis.meta?.capacity ?? null,
          period: analysis.meta ? [analysis.meta.start, analysis.meta.end] : null,
          summary: analysis.summary ?? null,
          dailyDates: (analysis.daily ?? []).map((entry) => entry.date),
          gaps: (analysis.gaps ?? []).map((entry) => `${entry.reason}:${entry.minutes}`),
          rowCount: rows.length,
          firstTimestamp: rows[0]?.timestamp ?? null,
          lastTimestamp: rows.at(-1)?.timestamp ?? null,
          rowDispatchTotal: rows.reduce((sum, row) => sum + (row.dispatch ?? 0), 0),
          sourceName: queries.wind_minutes?.source?.name ?? null,
          methods: queries.wind_minutes?.methods ?? [],
          sourcePeriod: queries.wind_minutes?.source?.period ?? null,
          guard: typeof shell.commitAnalysis === "function",
        };
      },
      commitInvalidMethods(methods) {
        return shell.commitAnalysis({queryId: ANALYSIS_QUERY_ID,rows:[],methods});
      },
      /** Commits a fixture by file name. */
      async apply(name) {
        commit(await loadAnalysisFixture(name));
        return true;
      },
      /** Must be refused and must leave the previous analysis untouched. */
      commitWithoutRows() {
        commit({ meta: {}, summary: {}, daily: [], gaps: [] });
      },
      /** Must be refused: the shell owns the reviewed query map. */
      commitUnknownQuery() {
        shell.commitAnalysis({ queryId: "not_a_reviewed_query", rows: [{}] });
      },
      /** Must be refused: the shell owns app identity. */
      commitReservedNamespace() {
        shell.commitAnalysis({ queryId: ANALYSIS_QUERY_ID, rows: [{}], namespace: "id", analysis: {} });
      },
      /** Must be refused (T0-R2 S1): `report` is a shell-read field. */
      commitReportNamespace() {
        shell.commitAnalysis({ queryId: ANALYSIS_QUERY_ID, rows: [{}], namespace: "report", analysis: {} });
      },
      /** Must be refused (T0-R2 S1): `visibleReportFilters` is a shell-read field. */
      commitVisibleReportFiltersNamespace() {
        shell.commitAnalysis({ queryId: ANALYSIS_QUERY_ID, rows: [{}], namespace: "visibleReportFilters", analysis: {} });
      },
      /** Must be refused (T0-R2 S1): an unregistered namespace is unknown. */
      commitUnknownNamespace() {
        shell.commitAnalysis({ queryId: ANALYSIS_QUERY_ID, rows: [{}], namespace: "madeUpNamespace", analysis: {} });
      },
      /** Namespace validation must not disappear when the optional analysis is omitted. */
      commitUnknownNamespaceWithoutAnalysis() {
        shell.commitAnalysis({ queryId: ANALYSIS_QUERY_ID, rows: shell.queries[ANALYSIS_QUERY_ID].rows,
          namespace: 'madeUpNamespace' });
      },
    };
    window.__T0__ = harness;
    return () => {
      if (window.__T0__ === harness) delete window.__T0__;
    };
  }, [commit, shell]);
  return null;
}
