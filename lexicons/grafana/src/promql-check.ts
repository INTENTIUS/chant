/**
 * GRAF108: the PromQL a dashboard sends to Prometheus, syntax-checked with
 * the prometheus lexicon's `checkPromql` (the grammar behind the Prometheus
 * web UI's editor, `@prometheus-io/lezer-promql`).
 *
 * Only queries that reach a Prometheus datasource are parsed, as
 * `datasourceUses()` resolves them: a query's own ref, else its panel's, a
 * datasource variable's plugin type, or an undeclared ref's own `type`. A
 * query whose datasource can't be told (no ref at all, a `-- Mixed --` panel
 * query with none of its own) is left alone.
 *
 * Grafana interpolates template variables before Prometheus sees the query,
 * so `$var`, `${var}`, `${var:format}`, `[[var]]` and the `$__` macros are
 * replaced with a placeholder that parses where they stand: a duration
 * inside `[...]` or after `offset`, a number for the `_ms`/`_s` macros and
 * `$__from`/`$__to`, an identifier anywhere else. Inside a string literal
 * they are left as they are.
 */

import { checkPromql } from "@intentius/chant-lexicon-prometheus/promql";
import { datasourceUses, variablesOf, type KnownDatasource } from "./datasource-refs";

type Json = Record<string, unknown>;

const DURATION = "5m";
const NUMBER = "1";
const IDENTIFIER = "grafana_var";

/** A template variable reference starting at the regex's lastIndex. */
const VARIABLE = /\$\{([^}]*)\}|\[\[([A-Za-z_][^\]]*)\]\]|\$([A-Za-z_][A-Za-z0-9_]*)/y;

function isNumericMacro(name: string): boolean {
  if (name === "__from" || name === "__to") return true;
  return (name.startsWith("__") || name === "interval_ms") && /_(ms|s)$/.test(name);
}

/** A span of substituted text and the original text it replaced. */
interface Span {
  at: number;
  length: number;
  original: number;
  originalLength: number;
}

export interface Substituted {
  text: string;
  /** Maps an offset in `text` back to one in the original query. */
  originalOffset(at: number): number;
}

/** Replace every template variable outside a string literal with a placeholder that parses in its place. */
export function substituteTemplateVariables(query: string): Substituted {
  let out = "";
  const spans: Span[] = [];
  let quote: string | undefined;
  let depth = 0;
  let i = 0;
  while (i < query.length) {
    const c = query[i];
    if (quote) {
      out += c;
      if (c === "\\" && quote !== "`" && i + 1 < query.length) {
        out += query[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = undefined;
      i++;
      continue;
    }
    if (c === "$" || (c === "[" && query[i + 1] === "[")) {
      VARIABLE.lastIndex = i;
      const m = VARIABLE.exec(query);
      if (m) {
        const name = (m[1] ?? m[2] ?? m[3]).split(/[:.]/)[0].trim();
        const before = out.trimEnd();
        let value: string;
        if (depth > 0 || /\boffset$/i.test(before)) {
          // `[${n}m]`: the unit follows, so only the number is substituted.
          value = /[a-z]/i.test(query[i + m[0].length] ?? "") ? NUMBER : DURATION;
        } else if (isNumericMacro(name) || before.endsWith("@")) {
          value = NUMBER;
        } else {
          value = IDENTIFIER;
        }
        spans.push({ at: out.length, length: value.length, original: i, originalLength: m[0].length });
        out += value;
        i += m[0].length;
        continue;
      }
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "[") depth++;
    else if (c === "]" && depth > 0) depth--;
    out += c;
    i++;
  }
  return {
    text: out,
    originalOffset(at: number): number {
      let shift = 0;
      for (const s of spans) {
        if (at < s.at) break;
        if (at < s.at + s.length) return s.original;
        shift = s.original + s.originalLength - (s.at + s.length);
      }
      return at + shift;
    },
  };
}

export type PromqlSyntax = { ok: true } | { ok: false; message: string };

/** Check one query's PromQL syntax after substituting its template variables. */
export function checkGrafanaPromql(query: string): PromqlSyntax {
  const substituted = substituteTemplateVariables(query);
  const checked = checkPromql(substituted.text);
  if (checked.ok) return { ok: true };
  const at = Math.min(substituted.originalOffset(checked.position), query.length);
  if (at >= query.length) return { ok: false, message: `the expression ends early (after "${query.slice(Math.max(0, at - 30)).trim()}")` };
  const before = query.slice(Math.max(0, at - 30), at);
  const after = query.slice(at, at + 30);
  return { ok: false, message: `syntax error at offset ${at}: "${before}" >>> "${after}"` };
}

/**
 * The PromQL inside a Prometheus query variable's query. Grafana handles
 * `label_names()`, `label_values(selector, label)`, `metrics(regex)` and
 * `query_result(expr)` itself and sends only the selector or expression; any
 * other text is a series selector (`/api/v1/series?match[]=`).
 */
export function variablePromql(query: string): string[] {
  const q = query.trim();
  if (q === "" || /^label_names\(\s*\)$/.test(q)) return [];
  let m = /^label_names\((.+)\)$/.exec(q);
  if (m) return [m[1]];
  m = /^label_values\((?:(.+),\s*)?([a-zA-Z_$][a-zA-Z0-9_]*)\)$/.exec(q);
  if (m) return m[1] ? [m[1]] : [];
  if (/^metrics\((.+)\)$/.test(q)) return [];
  m = /^query_result\((.+)\)$/.exec(q);
  if (m) return [m[1]];
  return [q];
}

function variableQueryText(variable: Json): string | undefined {
  const q = variable.query;
  if (typeof q === "string") return q;
  if (q && typeof q === "object" && typeof (q as Json).query === "string") return (q as Json).query as string;
  return undefined;
}

/** One piece of PromQL a dashboard sends to Prometheus, and where it is written. */
export interface PromqlUse {
  where: string;
  expr: string;
}

/** The PromQL of one dashboard (or, for a library panel, a one-panel stand-in); `library` names the `__elements` key. */
function usesOf(dashboard: Json, known: ReadonlyMap<string, KnownDatasource>, library?: string): PromqlUse[] {
  const out: PromqlUse[] = [];
  for (const use of datasourceUses(dashboard, known)) {
    if (use.resolved.type !== "prometheus") continue;
    if (use.kind === "query") {
      const expr = use.target?.expr;
      if (typeof expr !== "string" || expr.trim() === "") continue;
      out.push({ where: library ? `library panel "${library}" query ${String(use.target?.refId ?? "?")}` : use.where, expr });
    } else if (use.kind === "annotation" && use.annotation) {
      // A Prometheus annotation keeps its query in `target.expr`, or at the top level when saved before Grafana 10.
      const expr = use.target?.expr ?? use.annotation.expr;
      if (typeof expr === "string" && expr.trim() !== "") out.push({ where: `${use.where} query`, expr });
    } else if (use.kind === "variable" && use.variable?.type === "query" && !library) {
      const text = variableQueryText(use.variable);
      if (text) for (const expr of variablePromql(text)) out.push({ where: `${use.where} query`, expr });
    }
  }
  return out;
}

/** Every PromQL query a dashboard sends to Prometheus: panel queries, query variables and the library panels an export embeds in `__elements`. */
export function prometheusQueries(dashboard: Json, known: ReadonlyMap<string, KnownDatasource>): PromqlUse[] {
  const out = usesOf(dashboard, known);
  const elements = dashboard.__elements;
  if (elements && typeof elements === "object" && !Array.isArray(elements)) {
    // The dashboard's variables, so a library panel's `${DS_...}` ref resolves as the dashboard's would.
    const templating = { list: variablesOf(dashboard) };
    for (const [key, element] of Object.entries(elements as Json)) {
      const model = element && typeof element === "object" ? (element as Json).model : undefined;
      if (!model || typeof model !== "object" || Array.isArray(model)) continue;
      out.push(...usesOf({ templating, panels: [model] }, known, key));
    }
  }
  return out;
}
