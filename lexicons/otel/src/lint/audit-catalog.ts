/**
 * The otel lexicon's chant audit catalog, contributed via
 * `otelPlugin.auditCatalog()` (#687, #1346).
 *
 * OTEL101-OTEL106, OTEL112-OTEL117 and OTEL119-OTEL127 read the emitted collector YAML, so they are
 * `yamlBased`. OTEL118 reads it too, but only in a build that stamps
 * telemetry attribution, so it is not.
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
    "Declare the receiver, processor or exporter under its section, or reference the declared entity instead of an id string. List a connector as an exporter in one pipeline and a receiver in another.",
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
  OTEL112: auditRule(
    "OTEL112",
    "merge-worthy",
    "guidance",
    "Connector joins pipelines whose signals it does not convert",
    "Feed the connector from, and receive from it into, pipelines of the signals it supports (spanmetrics: traces in, metrics out).",
    { category: "correctness" },
  ),
  OTEL113: auditRule(
    "OTEL113",
    "merge-worthy",
    "guidance",
    "Pipelines form a cycle through connectors",
    "Break the cycle the message names: drop one connector hop, or send that pipeline's data to an exporter instead of back upstream.",
    { category: "correctness" },
  ),
  OTEL114: auditRule(
    "OTEL114",
    "merge-worthy",
    "guidance",
    "Connector id also declared as a receiver or exporter",
    'Give the connector, or the receiver or exporter, its own name (e.g. "datadog/connector") and update the pipelines that list it.',
    { category: "correctness" },
  ),
  OTEL115: auditRule(
    "OTEL115",
    "merge-worthy",
    "guidance",
    "Routing connector routes to a pipeline that does not receive from it",
    "List the routing connector in the receivers of every pipeline its table and default_pipelines name, or remove the pipeline from the route.",
    { category: "correctness" },
  ),
  OTEL116: auditRule(
    "OTEL116",
    "merge-worthy",
    "guidance",
    "Connector splits metrics by a high-cardinality GenAI attribute",
    "Remove the conversation, response, tool call, session or user id, or the content key, from the connector's dimensions or attributes. Keep it on spans and logs, where a per-request value costs nothing extra.",
    { category: "efficiency" },
  ),
  OTEL117: auditRule(
    "OTEL117",
    "merge-worthy",
    "guidance",
    "Two started components listen on the same address",
    "Give one of them another port, or a specific host that doesn't overlap the other's. The collector's own metrics listen on localhost:8888 unless service.telemetry.metrics sets a reader or level none.",
    { category: "correctness" },
  ),
  // Runs only in a build that stamps telemetry attribution, which a standalone YAML file never is.
  OTEL118: {
    ...auditRule(
      "OTEL118",
      "report-only",
      "guidance",
      "Pipeline processor can remove or replace a telemetry attribution key",
      "Leave service.name, service.version, deployment.environment.name, vcs.ref.head.revision and chant.* keys alone: use insert rather than upsert or update, keep them in keep_keys and in redaction's allowed_keys, and set override: false on resourcedetection.",
      { category: "correctness" },
    ),
    yamlBased: false,
  },
  OTEL119: auditRule(
    "OTEL119",
    "report-only",
    "guidance",
    "Collector config sets a field deprecated before the pinned release",
    "Replace invert_match with a drop policy, service.telemetry.metrics.address with readers, and spanmetrics dimensions_cache_size with aggregation_cardinality_limit.",
    { category: "best-practice" },
  ),
  OTEL120: auditRule(
    "OTEL120",
    "merge-worthy",
    "guidance",
    "Collector credential written as a literal in the config",
    'Replace the value with `${env:NAME}` or `${file:/path}` so the collector reads it at start-up.',
    { category: "security" },
  ),
  OTEL121: auditRule(
    "OTEL121",
    "merge-worthy",
    "guidance",
    "Exporter sends a credential over plaintext",
    "Use an https:// endpoint, or drop tls.insecure, for an exporter that sends an authorization header or API key.",
    { category: "security" },
  ),
  OTEL122: auditRule(
    "OTEL122",
    "merge-worthy",
    "guidance",
    "zpages or pprof listens on a non-loopback address",
    "Bind zpages and pprof to localhost and reach them with a port-forward.",
    { category: "security" },
  ),
  OTEL123: auditRule(
    "OTEL123",
    "report-only",
    "guidance",
    "debug exporter at verbosity detailed beside a real exporter",
    "Set the debug exporter to verbosity basic, or keep detailed output to a pipeline that exports nowhere else.",
    { category: "security" },
  ),
  OTEL124: auditRule(
    "OTEL124",
    "report-only",
    "guidance",
    "Remote exporter has its sending queue or retries turned off",
    "Remove sending_queue.enabled: false and retry_on_failure.enabled: false from exporters that send over the network.",
    { category: "best-practice" },
  ),
  OTEL125: auditRule(
    "OTEL125",
    "report-only",
    "guidance",
    "Pipeline sends to a remote otlp or otlphttp exporter without batching",
    "Add a batch processor to the pipeline, or set sending_queue.batch on the exporter.",
    { category: "best-practice" },
  ),
  OTEL126: auditRule(
    "OTEL126",
    "merge-worthy",
    "guidance",
    "k8sattributes extracts an unsupported metadata field",
    "Use a field from the k8sattributes list at the pinned release, or extract it as a label or annotation.",
    { category: "correctness" },
  ),
  OTEL127: auditRule(
    "OTEL127",
    "merge-worthy",
    "guidance",
    "resourcedetection lists an unknown detector",
    "Name detectors as the processor registers them (elastic_beanstalk, not elasticbeanstalk), or remove the entry.",
    { category: "correctness" },
  ),
};
