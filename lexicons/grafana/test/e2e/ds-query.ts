/**
 * Run a dashboard panel's target through Grafana's `/api/ds/query`, as the
 * dashboard would, and read the data frames back as labelled series.
 *
 * Grafana's backend expands `$__rate_interval`, `$__interval` and
 * `$__range`; dashboard variables are expanded by the frontend, so the
 * caller passes their values in `vars`.
 */
import type { GrafanaContainer } from "./containers";

export interface Target {
  refId: string;
  expr: string;
  datasource?: { type?: string; uid?: string };
  instant?: boolean;
  range?: boolean;
  legendFormat?: string;
}

export interface Series {
  labels: Record<string, string>;
  /** Frame values, with NaN and ±Inf restored from the frame's `entities`; `null` is a missing point. */
  values: Array<number | null>;
}

export interface QueryResult {
  status: number;
  error?: string;
  series: Series[];
}

interface Frame {
  schema: { fields: Array<{ name: string; type?: string; labels?: Record<string, string> }> };
  data: { values: unknown[][]; entities?: Array<{ NaN?: number[]; Inf?: number[]; NegInf?: number[] } | null> };
}

/** Replace `$name` and `${name}` for each variable, longest names first. */
export function interpolate(expr: string, vars: Record<string, string>): string {
  let out = expr;
  for (const name of Object.keys(vars).sort((a, b) => b.length - a.length)) {
    out = out.split(`\${${name}}`).join(vars[name]).split(`$${name}`).join(vars[name]);
  }
  return out;
}

function framesToSeries(frames: Frame[]): Series[] {
  const out: Series[] = [];
  for (const f of frames) {
    f.schema.fields.forEach((field, i) => {
      if (field.type === "time" || field.name === "Time") return;
      const raw = (f.data.values[i] ?? []) as Array<number | null>;
      const values: Array<number | null> = [...raw];
      const e = f.data.entities?.[i];
      for (const j of e?.NaN ?? []) values[j] = Number.NaN;
      for (const j of e?.Inf ?? []) values[j] = Number.POSITIVE_INFINITY;
      for (const j of e?.NegInf ?? []) values[j] = Number.NEGATIVE_INFINITY;
      out.push({ labels: field.labels ?? {}, values });
    });
  }
  return out;
}

/**
 * One target over `[from, to]` (Unix ms). A range query unless the target
 * says `instant: true, range: false`.
 */
export async function dsQuery(
  grafana: GrafanaContainer,
  target: Target,
  opts: { from: number; to: number; vars?: Record<string, string>; datasource?: { type: string; uid: string }; maxDataPoints?: number },
): Promise<QueryResult> {
  const instant = target.instant === true && target.range === false;
  const query = {
    ...target,
    expr: interpolate(target.expr, opts.vars ?? {}),
    datasource: opts.datasource ?? target.datasource,
    instant,
    range: !instant,
    maxDataPoints: opts.maxDataPoints ?? 120,
    intervalMs: 15_000,
  };
  const res = await grafana.api("/api/ds/query", {
    method: "POST",
    body: JSON.stringify({ queries: [query], from: String(opts.from), to: String(opts.to) }),
  });
  const result = res.body?.results?.[target.refId] as { status?: number; error?: string; frames?: Frame[] } | undefined;
  return {
    status: result?.status ?? res.status,
    ...(result?.error || res.status !== 200 ? { error: result?.error ?? JSON.stringify(res.body) } : {}),
    series: framesToSeries(result?.frames ?? []),
  };
}

/** Each series' last point that isn't missing (NaN counts as a point), keyed by one label's value. */
export function lastBy(series: Series[], label: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of series) {
    const last = [...s.values].reverse().find((v) => v !== null);
    if (last !== undefined && last !== null) out[s.labels[label] ?? ""] = last;
  }
  return out;
}
