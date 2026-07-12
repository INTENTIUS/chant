import type { ExportedTemplate } from "@intentius/chant/lexicon";

/**
 * Resolve a live CloudFormation template's per-resource properties into flat
 * attributes for `chant graph --live` edge reconstruction (#784).
 *
 * `describeResources()` returns thin metadata (stack outputs), so the reference
 * resolver (#778) had nothing to match on. `exportResources()` returns the
 * deployed template, where resources reference each other by **logical id** via
 * `{Ref: LogicalId}` / `{Fn::GetAtt: [LogicalId, …]}`. Logical id == the IR node
 * id (both keyed by the CloudFormation logical name), so resolving those
 * intrinsics to the bare logical-id string turns each reference into a value the
 * resolver matches directly (it indexes every node by its own id).
 */
function resolveIntrinsics(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(resolveIntrinsics);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && typeof o.Ref === "string") return o.Ref;
    if (keys.length === 1 && o["Fn::GetAtt"] !== undefined) {
      const g = o["Fn::GetAtt"];
      if (Array.isArray(g) && typeof g[0] === "string") return g[0]; // ["LogicalId", "Attr"]
      if (typeof g === "string") return g.split(".")[0]; // "LogicalId.Attr"
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = resolveIntrinsics(val);
    return out;
  }
  return v;
}

/** logical id → resolved properties (references become bare logical-id strings). */
export function resolveTemplateAttrs(template: ExportedTemplate): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const r of template.resources) {
    out[r.logicalId] = resolveIntrinsics(r.properties) as Record<string, unknown>;
  }
  return out;
}
