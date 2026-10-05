/**
 * PROM225: a `labeldrop` or `labelkeep` relabel step carries a field the
 * action does not take.
 *
 * Both actions match `regex` against label names, so `source_labels`,
 * `separator`, `target_label`, `modulus` and `replacement` have nothing to
 * act on. Prometheus rejects the file when it loads it (the importer's
 * fixture was fixed for the same reason, #3537).
 */

import type { PrometheusConfigFile } from "./config-model";
import type { PrometheusIssue } from "./validate-config";

const RELABEL_KEYS = new Set(["relabel_configs", "metric_relabel_configs", "alert_relabel_configs", "write_relabel_configs"]);
const FOREIGN_FIELDS = ["source_labels", "separator", "target_label", "modulus", "replacement"] as const;

/** Every relabel step in a `prometheus.yml`, with where it sits, e.g. `scrape_configs[0].relabel_configs[1]`. */
function relabelSteps(node: unknown, path: string, out: Array<{ path: string; step: Record<string, unknown> }>): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => relabelSteps(v, `${path}[${i}]`, out));
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    const here = path ? `${path}.${key}` : key;
    if (RELABEL_KEYS.has(key) && Array.isArray(value)) {
      value.forEach((step, i) => {
        if (typeof step === "object" && step !== null && !Array.isArray(step)) out.push({ path: `${here}[${i}]`, step: step as Record<string, unknown> });
      });
    } else {
      relabelSteps(value, here, out);
    }
  }
}

/** PROM225 over one `prometheus.yml`. */
export function validateRelabelFields(config: PrometheusConfigFile): PrometheusIssue[] {
  const steps: Array<{ path: string; step: Record<string, unknown> }> = [];
  relabelSteps(config, "", steps);
  const issues: PrometheusIssue[] = [];
  for (const { path, step } of steps) {
    if (step.action !== "labeldrop" && step.action !== "labelkeep") continue;
    const extra = FOREIGN_FIELDS.filter((f) => step[f] !== undefined);
    if (extra.length === 0) continue;
    issues.push({
      code: "PROM225",
      severity: "error",
      subject: path,
      message: `${path}: a ${String(step.action)} step matches regex against label names and takes no ${extra.join(", ")}; Prometheus rejects the file, so remove ${extra.length === 1 ? "it" : "them"}`,
    });
  }
  return issues;
}
