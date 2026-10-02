/**
 * Synthetic series as OpenMetrics text with timestamps, for
 * `DockerScope.prometheus({ openMetrics })` to backfill.
 *
 * Counters grow at a constant rate, so `rate()` over them is exactly that
 * rate, and every histogram observation lands in one bucket, so
 * `histogram_quantile()` interpolates to a value the test can compute. A
 * counter with `perSecond: 0` is a series with no traffic: it exists, and
 * its rate is 0.
 */

export type Labels = Record<string, string>;

export interface Window {
  /** Unix seconds of the first sample. */
  start: number;
  /** Unix seconds of the last sample. */
  end: number;
  /** Seconds between samples. */
  step: number;
}

export type Family =
  | { type: "counter"; name: string; series: Array<{ labels: Labels; perSecond: number }> }
  | {
      type: "histogram";
      name: string;
      /** Finite upper bounds; `+Inf` is added. */
      buckets: number[];
      /** `within`: the upper bound of the bucket every observation falls in. */
      series: Array<{ labels: Labels; perSecond: number; within: number }>;
    }
  | { type: "gauge"; name: string; series: Array<{ labels: Labels; value: number }> };

function labelText(labels: Labels): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

function times(w: Window): number[] {
  const out: number[] = [];
  for (let t = w.start; t <= w.end; t += w.step) out.push(t);
  return out;
}

/** The families as one OpenMetrics exposition, samples in time order per series, ending `# EOF`. */
export function openMetrics(w: Window, families: Family[]): string {
  const lines: string[] = [];
  const ts = times(w);
  for (const f of families) {
    lines.push(`# TYPE ${f.name} ${f.type}`);
    if (f.type === "counter") {
      for (const s of f.series) {
        for (const t of ts) lines.push(`${f.name}_total${labelText(s.labels)} ${s.perSecond * (t - w.start)} ${t}`);
      }
    } else if (f.type === "gauge") {
      for (const s of f.series) {
        for (const t of ts) lines.push(`${f.name}${labelText(s.labels)} ${s.value} ${t}`);
      }
    } else {
      const bounds = [...f.buckets].sort((a, b) => a - b);
      for (const s of f.series) {
        if (!bounds.includes(s.within)) throw new Error(`${f.name}: ${s.within} is not one of its buckets`);
        const lower = bounds[bounds.indexOf(s.within) - 1] ?? 0;
        for (const t of ts) {
          const n = s.perSecond * (t - w.start);
          for (const le of bounds) lines.push(`${f.name}_bucket${labelText({ ...s.labels, le: String(le) })} ${le >= s.within ? n : 0} ${t}`);
          lines.push(`${f.name}_bucket${labelText({ ...s.labels, le: "+Inf" })} ${n} ${t}`);
          lines.push(`${f.name}_count${labelText(s.labels)} ${n} ${t}`);
          lines.push(`${f.name}_sum${labelText(s.labels)} ${n * ((lower + s.within) / 2)} ${t}`);
        }
      }
    }
  }
  lines.push("# EOF", "");
  return lines.join("\n");
}
