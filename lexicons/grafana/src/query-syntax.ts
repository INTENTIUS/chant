/**
 * GRAF116 and GRAF117: the LogQL a dashboard sends to Loki and the TraceQL it
 * sends to Tempo, syntax-checked with the grammars behind Grafana's own Loki
 * and Tempo query editors (`@grafana/lezer-logql`, `@grafana/lezer-traceql`).
 *
 * Queries are routed the way GRAF108 routes PromQL: `datasourceUses()`
 * resolves each query's datasource (its own ref, else its panel's, a
 * datasource variable's plugin type, or an undeclared ref's own `type`), and
 * only the ones that resolve to `loki` or `tempo` are parsed. A query whose
 * datasource can't be told is left alone.
 *
 * Template variables are substituted as for PromQL (`substituteTemplateVariables`).
 * A variable can stand for more than a name in these languages (a whole
 * pipeline stage `{app="x"} $filters`, a TraceQL value `{ .code = $code }`),
 * so a parse error at or right after a substituted variable is not reported:
 * the variable's value decides whether the query parses.
 */

import type { LRParser } from "@lezer/lr";
import { parser as logqlParser } from "@grafana/lezer-logql";
import { parser as traceqlParser } from "@grafana/lezer-traceql";
import { substituteTemplateVariables } from "./promql-check";
import { dashboardScopes, datasourceUses, type KnownDatasource } from "./datasource-refs";

type Json = Record<string, unknown>;

/** The grammar packages and the exact versions the checks parse with. */
export const LOGQL_GRAMMAR = Object.freeze({ source: "@grafana/lezer-logql", version: "0.4.2" });
export const TRACEQL_GRAMMAR = Object.freeze({ source: "@grafana/lezer-traceql", version: "1.0.3" });

export type QuerySyntax = { ok: true } | { ok: false; message: string };

function firstError(parser: LRParser, text: string): number | undefined {
  let at: number | undefined;
  parser.parse(text).iterate({
    enter: (node) => {
      if (at !== undefined) return false;
      if (node.type.isError) {
        at = node.from;
        return false;
      }
      return undefined;
    },
  });
  return at;
}

function checkWith(parser: LRParser, query: string): QuerySyntax {
  const substituted = substituteTemplateVariables(query);
  const error = firstError(parser, substituted.text);
  if (error === undefined || substituted.variableAt(error)) return { ok: true };
  const at = Math.min(substituted.originalOffset(error), query.length);
  if (at >= query.length) return { ok: false, message: `the query ends early (after "${query.slice(Math.max(0, at - 30)).trim()}")` };
  const before = query.slice(Math.max(0, at - 30), at);
  const after = query.slice(at, at + 30);
  return { ok: false, message: `syntax error at offset ${at}: "${before}" >>> "${after}"` };
}

/** Check one LogQL query's syntax after substituting its template variables. */
export function checkGrafanaLogql(query: string): QuerySyntax {
  return checkWith(logqlParser, query);
}

/** Check one TraceQL query's syntax after substituting its template variables. */
export function checkGrafanaTraceql(query: string): QuerySyntax {
  return checkWith(traceqlParser, query);
}

/**
 * The LogQL inside a Loki query variable. Grafana stores it as an object,
 * `{ type, label, stream }`, or as `label_names()`, `label_values(label)` or
 * `label_values(stream, label)`; only the stream selector is LogQL.
 */
export function variableLogql(query: unknown): string[] {
  if (query && typeof query === "object" && !Array.isArray(query)) {
    const stream = (query as Json).stream;
    return typeof stream === "string" && stream.trim() !== "" ? [stream] : [];
  }
  if (typeof query !== "string") return [];
  const m = /^\s*label_values\((.+),\s*[a-zA-Z_$][a-zA-Z0-9_.$]*\s*\)\s*$/.exec(query);
  return m && m[1].trim() !== "" ? [m[1]] : [];
}

/** A Tempo query's `query` holds TraceQL when its `queryType` is `traceql`, or unset and it is not a trace id. */
function traceqlOf(target: Json): string | undefined {
  const q = target.query;
  if (typeof q !== "string" || q.trim() === "") return undefined;
  const type = target.queryType;
  if (type === "traceql") return q;
  if (type === undefined && !/^\s*[0-9a-fA-F]{1,32}\s*$/.test(q)) return q;
  return undefined;
}

/** One query a dashboard sends to Loki or Tempo, and where it is written. */
export interface QueryUse {
  where: string;
  expr: string;
}

function lokiUses(dashboard: Json, known: ReadonlyMap<string, KnownDatasource>, library?: string): QueryUse[] {
  const out: QueryUse[] = [];
  for (const use of datasourceUses(dashboard, known)) {
    if (use.resolved.type !== "loki") continue;
    if (use.kind === "query") {
      const expr = use.target?.expr;
      if (typeof expr !== "string" || expr.trim() === "") continue;
      out.push({ where: library ? `library panel "${library}" query ${String(use.target?.refId ?? "?")}` : use.where, expr });
    } else if (use.kind === "annotation" && use.annotation) {
      const expr = use.target?.expr ?? use.annotation.expr;
      if (typeof expr === "string" && expr.trim() !== "") out.push({ where: `${use.where} query`, expr });
    } else if (use.kind === "variable" && use.variable?.type === "query" && !library) {
      for (const expr of variableLogql(use.variable.query)) out.push({ where: `${use.where} query`, expr });
    }
  }
  return out;
}

function tempoUses(dashboard: Json, known: ReadonlyMap<string, KnownDatasource>, library?: string): QueryUse[] {
  const out: QueryUse[] = [];
  for (const use of datasourceUses(dashboard, known)) {
    if (use.resolved.type !== "tempo" || use.kind !== "query" || !use.target) continue;
    const expr = traceqlOf(use.target);
    if (expr === undefined) continue;
    out.push({ where: library ? `library panel "${library}" query ${String(use.target.refId ?? "?")}` : use.where, expr });
  }
  return out;
}

/** Every LogQL query a dashboard sends to Loki: panel queries, annotation queries, query variables' stream selectors and library panels in `__elements`. */
export function lokiQueries(dashboard: Json, known: ReadonlyMap<string, KnownDatasource>): QueryUse[] {
  return dashboardScopes(dashboard).flatMap((s) => lokiUses(s.json, known, s.library));
}

/** Every TraceQL query a dashboard sends to Tempo: panel queries and library panels in `__elements`. */
export function tempoQueries(dashboard: Json, known: ReadonlyMap<string, KnownDatasource>): QueryUse[] {
  return dashboardScopes(dashboard).flatMap((s) => tempoUses(s.json, known, s.library));
}
