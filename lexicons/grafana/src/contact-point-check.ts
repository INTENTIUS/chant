/**
 * Checks one contact point receiver's `settings` against the options Grafana
 * lists for its integration (`src/contact-point-settings.gen.ts`): a key the
 * integration does not take, and a required option left out. An integration
 * the table does not know is not checked.
 */
import { CONTACT_POINT_NOTIFIERS, type NotifierOptionSchema } from "./contact-point-settings.gen";

export interface SettingsProblem {
  severity: "error" | "warning";
  /** Dotted path of the setting. */
  path: string;
  message: string;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function closest(key: string, known: readonly string[]): string | undefined {
  const lower = key.toLowerCase();
  const exact = known.find((k) => k.toLowerCase() === lower);
  if (exact) return exact;
  const best = known.map((k) => [k, distance(lower, k.toLowerCase())] as const).sort((x, y) => x[1] - y[1])[0];
  return best && best[1] <= Math.max(2, Math.floor(key.length / 3)) ? best[0] : undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function walk(options: readonly NotifierOptionSchema[], value: Record<string, unknown>, prefix: string, out: SettingsProblem[]): void {
  const known = options.map((o) => o.key);
  for (const key of Object.keys(value)) {
    if (known.includes(key)) continue;
    const near = closest(key, known);
    out.push({
      severity: "warning",
      path: `${prefix}${key}`,
      message: `${prefix}${key} is not a setting of this integration${near ? `; did you mean ${prefix}${near}?` : ""}`,
    });
  }
  for (const o of options) {
    const v = value[o.key];
    if (o.required && (v === undefined || v === null || v === "")) {
      out.push({ severity: "error", path: `${prefix}${o.key}`, message: `${prefix}${o.key} is required` });
    }
    if (o.options && isObject(v)) walk(o.options, v, `${prefix}${o.key}.`, out);
    if (o.options && o.kind === "objects" && Array.isArray(v)) {
      v.forEach((item, i) => isObject(item) && walk(o.options!, item, `${prefix}${o.key}[${i}].`, out));
    }
  }
}

export function checkContactPointSettings(type: string, settings: Record<string, unknown>): SettingsProblem[] {
  const schema = (CONTACT_POINT_NOTIFIERS as Record<string, (typeof CONTACT_POINT_NOTIFIERS)[keyof typeof CONTACT_POINT_NOTIFIERS] | undefined>)[type];
  if (!schema) return [];
  const out: SettingsProblem[] = [];
  walk(schema.options, settings, "", out);
  return out;
}
