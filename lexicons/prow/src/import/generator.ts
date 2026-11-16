/**
 * TypeScript generator for `chant import` of a Prow job config: one
 * `main.ts` with a declarable per job, its fields as plain values in the
 * order the file has them, and the jobs exported in one array in file order.
 * chant discovers a module's exports in name order and an array's elements
 * in their order, so the array is what keeps the jobs where the file had
 * them. A multi-line string (a script) is written as a template literal.
 */

import type { TypeScriptGenerator, GeneratedFile } from "@intentius/chant/import/generator";
import type { TemplateIR } from "@intentius/chant/import/parser";

const CLASS: Record<string, string> = {
  "Prow::Presubmit": "Presubmit",
  "Prow::Postsubmit": "Postsubmit",
  "Prow::Periodic": "Periodic",
  "Prow::JobConfig": "JobConfig",
};

/** A job's fields whose value is a property entity, wrapped in its constructor so the import passes COR001. */
const PROPERTY: Record<string, string> = {
  spec: "PodSpec",
  decoration_config: "DecorationConfig",
  reporter_config: "ReporterConfig",
  rerun_auth_config: "RerunAuthConfig",
  prowjob_defaults: "ProwJobDefault",
  retry: "Retry",
  jenkins_spec: "JenkinsSpec",
};
/** A job's list fields whose items are property entities. */
const PROPERTY_ITEMS: Record<string, string> = { extra_refs: "Refs" };

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function key(k: string): string {
  return IDENTIFIER.test(k) ? k : JSON.stringify(k);
}

function str(s: string): string {
  if (!s.includes("\n")) return JSON.stringify(s);
  return `\`${s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\``;
}

function literal(value: unknown, depth: number): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return str(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const pad = "  ".repeat(depth + 1);
  const end = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => literal(v, depth + 1));
    const one = `[${items.join(", ")}]`;
    if (one.length < 80 && !one.includes("\n")) return one;
    return `[\n${items.map((i) => `${pad}${i},`).join("\n")}\n${end}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  return `{\n${entries.map(([k, v]) => `${pad}${key(k)}: ${literal(v, depth + 1)},`).join("\n")}\n${end}}`;
}

/** A job's fields, with the nested types in their constructors. */
function jobLiteral(props: Record<string, unknown>, used: Set<string>): string {
  const pad = "  ";
  const isMap = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
  const entries = Object.entries(props).map(([k, v]) => {
    if (PROPERTY[k] && isMap(v)) {
      used.add(PROPERTY[k]);
      return `${pad}${key(k)}: new ${PROPERTY[k]}(${literal(v, 1)}),`;
    }
    if (PROPERTY_ITEMS[k] && Array.isArray(v) && v.every(isMap)) {
      used.add(PROPERTY_ITEMS[k]);
      return `${pad}${key(k)}: [${v.map((i) => `new ${PROPERTY_ITEMS[k]}(${literal(i, 1)})`).join(", ")}],`;
    }
    return `${pad}${key(k)}: ${literal(v, 1)},`;
  });
  return entries.length === 0 ? "{}" : `{\n${entries.join("\n")}\n}`;
}

export class ProwJobConfigGenerator implements TypeScriptGenerator {
  readonly ownsLayout = true;

  generate(ir: TemplateIR): GeneratedFile[] {
    const used = new Set(ir.resources.map((r) => CLASS[r.type]).filter(Boolean));
    const lines: string[] = [];
    const jobs: string[] = [];
    for (const r of ir.resources) {
      const cls = CLASS[r.type];
      if (!cls) continue;
      if (cls === "JobConfig") {
        lines.push(`export const ${r.logicalId} = new ${cls}(${literal(r.properties, 0)});`, "");
        continue;
      }
      lines.push(`const ${r.logicalId} = new ${cls}(${jobLiteral(r.properties, used)});`, "");
      jobs.push(r.logicalId);
    }
    lines.unshift(`import { ${[...used].sort().join(", ")} } from "@intentius/chant-lexicon-prow";`, "");
    if (jobs.length > 0) lines.push(`/** The jobs, in the order the job config lists them. */`, `export const jobs = [${jobs.join(", ")}];`, "");
    return [{ path: "main.ts", content: lines.join("\n") }];
  }
}
