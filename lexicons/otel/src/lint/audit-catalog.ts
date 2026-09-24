/**
 * The otel lexicon's chant audit catalog, contributed via
 * `otelPlugin.auditCatalog()` (#687, #1346).
 *
 * OTEL101-OTEL106 read the emitted collector YAML, so they are `yamlBased`.
 * OTEL107-OTEL109 read the declared entities (a component's definition, its
 * schema pin), which a standalone YAML file does not carry, so they are
 * constructed with `yamlBased: false`. The two source-level lint rules are
 * listed too, for a reader who meets them in a lint report.
 */

import { auditRule, type RuleMeta } from "@intentius/chant/audit/catalog";

function entityRule(
  id: string,
  category: RuleMeta["category"],
  title: string,
  remediation: string,
): RuleMeta {
  return { id, tier: "merge-worthy", fixKind: "guidance", category, title, remediation, yamlBased: false };
}

export const otelAuditCatalog: Record<string, RuleMeta> = {
  OTEL001: entityRule(
    "OTEL001",
    "correctness",
    "Collector component id or instance name is not valid syntax",
    'Write component ids as `type` or `type/name` (e.g. "otlp/backend") and give instances a non-empty name with no whitespace.',
  ),
  OTEL002: entityRule(
    "OTEL002",
    "security",
    "Collector credential declared as a literal",
    'Replace the value with `${env:NAME}` or `${file:/path}` so the collector reads it at start-up.',
  ),
  OTEL101: auditRule(
    "OTEL101",
    "merge-worthy",
    "guidance",
    "Pipeline uses an undeclared component",
    "Declare the receiver, processor or exporter under its section, or reference the declared entity instead of an id string.",
    { category: "correctness" },
  ),
  OTEL102: auditRule(
    "OTEL102",
    "merge-worthy",
    "guidance",
    "Pipeline has no receivers or no exporters",
    "Give every pipeline at least one receiver and at least one exporter, or remove it.",
    { category: "correctness" },
  ),
  OTEL103: auditRule(
    "OTEL103",
    "report-only",
    "guidance",
    "Declared collector component is never used",
    "List the component in a pipeline (or the extension in service.extensions), or remove its declaration.",
    { category: "best-practice" },
  ),
  OTEL104: auditRule(
    "OTEL104",
    "merge-worthy",
    "guidance",
    "service.extensions enables an undeclared extension",
    "Declare the extension under extensions, or drop it from service.extensions.",
    { category: "correctness" },
  ),
  OTEL105: auditRule(
    "OTEL105",
    "report-only",
    "guidance",
    "memory_limiter is not the first processor",
    "Move memory_limiter to the front of the pipeline's processors list.",
    { category: "best-practice" },
  ),
  OTEL106: auditRule(
    "OTEL106",
    "merge-worthy",
    "guidance",
    "Pipeline id or component reference is not valid collector syntax",
    "Name pipelines traces, metrics or logs (optionally /name) and reference components as type or type/name.",
    { category: "correctness" },
  ),
  OTEL107: entityRule(
    "OTEL107",
    "correctness",
    "Collector component config breaks its definition's rules",
    "Fix the config the message names; for a custom component the rule comes from its defineComponent validate.",
  ),
  OTEL108: entityRule(
    "OTEL108",
    "correctness",
    "Two collector components or pipelines declare the same id",
    "Give each instance its own name so their ids (type/name) differ.",
  ),
  OTEL109: entityRule(
    "OTEL109",
    "correctness",
    "Custom collector component has no schema pin",
    "Pass defineComponent a pin with the source and version the component's config type follows.",
  ),
};
