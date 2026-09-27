/**
 * Built-in processors that drop, rewrite or redact telemetry: filter,
 * transform, redaction.
 *
 * `filter` and `transform` take OTTL. chant types the structure around it
 * (which signal, which context, which list) and keeps each OTTL condition or
 * statement as a string; the collector parses them when it loads the config.
 */

import { defineBuiltin } from "../define";

/** What an OTTL processor does when a condition or statement errors at run time. */
export type OttlErrorMode = "ignore" | "silent" | "propagate";

// ── filter ───────────────────────────────────────────────────────────

/** OTTL conditions per context. Telemetry matching any condition is dropped. */
export interface FilterProcessorConfig {
  /** Default `propagate`: an erroring condition fails the batch. `ignore` logs and moves on. */
  error_mode?: OttlErrorMode;
  traces?: {
    /** Drops the span, e.g. `attributes["http.route"] == "/healthz"`. */
    span?: string[];
    /** Drops the span event. */
    spanevent?: string[];
  };
  metrics?: {
    /** Drops the whole metric, e.g. `name == "http.server.duration" and type == METRIC_DATA_TYPE_HISTOGRAM`. */
    metric?: string[];
    /** Drops the data point. */
    datapoint?: string[];
  };
  logs?: {
    /** Drops the log record, e.g. `severity_number < SEVERITY_NUMBER_WARN`. */
    log_record?: string[];
  };
}

/** Drops spans, span events, metrics, data points and log records that match OTTL conditions. */
export const FilterProcessor = defineBuiltin<FilterProcessorConfig, "processor", "filter">({
  kind: "processor",
  type: "filter",
  description: "Drops spans, metrics and logs that match OTTL conditions",
  validate: (c) => {
    const lists: Array<[string, string[] | undefined]> = [
      ["traces.span", c.traces?.span],
      ["traces.spanevent", c.traces?.spanevent],
      ["metrics.metric", c.metrics?.metric],
      ["metrics.datapoint", c.metrics?.datapoint],
      ["logs.log_record", c.logs?.log_record],
    ];
    const problems: string[] = [];
    for (const [path, list] of lists) {
      (list ?? []).forEach((cond, i) => {
        if (typeof cond !== "string" || cond.trim() === "") problems.push(`${path}[${i}] is an empty condition`);
      });
    }
    if (lists.every(([, list]) => !list || list.length === 0)) {
      problems.push("no condition is set for any signal, so the processor drops nothing");
    }
    return problems;
  },
});

// ── transform ────────────────────────────────────────────────────────

/** OTTL contexts a trace statement group can run in. */
export type TraceStatementContext = "resource" | "scope" | "span" | "spanevent";
/** OTTL contexts a metric statement group can run in. */
export type MetricStatementContext = "resource" | "scope" | "metric" | "datapoint";
/** OTTL contexts a log statement group can run in. */
export type LogStatementContext = "resource" | "scope" | "log";

/**
 * A group of OTTL statements run in one context. `conditions` gate every
 * statement in the group; each statement may also carry its own `where`.
 */
export interface TransformStatementGroup<Ctx extends string = string> {
  /** The OTTL context. Leave it out and the collector infers it from the paths the statements use. */
  context?: Ctx;
  conditions?: string[];
  statements: string[];
  /** Overrides the processor's `error_mode` for this group. */
  error_mode?: OttlErrorMode;
}

/** Each entry is a group, or a bare statement whose context the collector infers. */
export type TransformStatements<Ctx extends string> = Array<string | TransformStatementGroup<Ctx>>;

export interface TransformProcessorConfig {
  /** Default `propagate`. */
  error_mode?: OttlErrorMode;
  trace_statements?: TransformStatements<TraceStatementContext>;
  metric_statements?: TransformStatements<MetricStatementContext>;
  log_statements?: TransformStatements<LogStatementContext>;
}

const TRANSFORM_CONTEXTS: Record<"trace_statements" | "metric_statements" | "log_statements", readonly string[]> = {
  trace_statements: ["resource", "scope", "span", "spanevent"],
  metric_statements: ["resource", "scope", "metric", "datapoint"],
  log_statements: ["resource", "scope", "log"],
};

/** Rewrites telemetry with OTTL statements, grouped per signal and context. */
export const TransformProcessor = defineBuiltin<TransformProcessorConfig, "processor", "transform">({
  kind: "processor",
  type: "transform",
  description: "Rewrites spans, metrics and logs with OTTL statements, grouped by context",
  validate: (c) => {
    const problems: string[] = [];
    let total = 0;
    for (const field of Object.keys(TRANSFORM_CONTEXTS) as Array<keyof typeof TRANSFORM_CONTEXTS>) {
      const allowed = TRANSFORM_CONTEXTS[field];
      (c[field] ?? []).forEach((entry, i) => {
        if (typeof entry === "string") {
          if (entry.trim() === "") problems.push(`${field}[${i}] is an empty statement`);
          else total++;
          return;
        }
        if (entry.context !== undefined && !allowed.includes(entry.context)) {
          problems.push(`${field}[${i}] has context "${entry.context}"; ${field} runs in ${allowed.join(", ")}`);
        }
        if (!entry.statements || entry.statements.length === 0) {
          problems.push(`${field}[${i}] has no statements`);
        }
        total += entry.statements?.length ?? 0;
      });
    }
    if (total === 0) problems.push("no statement is set for any signal, so the processor changes nothing");
    return problems;
  },
});

// ── redaction ────────────────────────────────────────────────────────

/**
 * Attribute keys and values to keep, mask or hash. Applies to span, span
 * event, log record and metric data point attributes (not resource
 * attributes).
 *
 * Keys: with `allow_all_keys` false, any attribute whose key is not in
 * `allowed_keys` or `ignored_keys` is deleted. Values: a value matching a
 * `blocked_values` pattern, or any value of a key matching a
 * `blocked_key_patterns` pattern, is masked with `****`, or replaced by its
 * hash when `hash_function` is set; `allowed_values` exempts a value from
 * masking. Patterns are Go (RE2) regular expressions.
 */
export interface RedactionProcessorConfig {
  /** Keep every key, so only values are masked. Default false. */
  allow_all_keys?: boolean;
  /** The keys that survive when `allow_all_keys` is false. */
  allowed_keys?: string[];
  /** Keys never touched: not deleted, not masked. */
  ignored_keys?: string[];
  /** Regexes on keys; every value of a matching key is masked. */
  blocked_key_patterns?: string[];
  /** Regexes on values; the matching part is masked. */
  blocked_values?: string[];
  /** Regexes on values that are never masked, even when they match a blocked pattern. */
  allowed_values?: string[];
  /** Hash blocked values with this function instead of masking them. */
  hash_function?: "md5" | "sha1" | "sha3";
  /** How much the processor records about what it redacted, as span attributes. Default `info`. */
  summary?: "debug" | "info" | "silent";
}

/** Deletes attributes whose keys aren't allowed, and masks or hashes values that match blocked patterns. */
export const RedactionProcessor = defineBuiltin<RedactionProcessorConfig, "processor", "redaction">({
  kind: "processor",
  type: "redaction",
  description: "Deletes attributes not on an allow list and masks or hashes values that match block patterns",
  validate: (c) => {
    const problems: string[] = [];
    if (c.allow_all_keys !== true && c.allowed_keys === undefined) {
      problems.push(
        "neither allow_all_keys nor allowed_keys is set, so every attribute is deleted; set allow_all_keys: true to keep keys, or allowed_keys: [] if deleting all is intended",
      );
    }
    if (c.allow_all_keys === true && c.allowed_keys !== undefined && c.allowed_keys.length > 0) {
      problems.push("allowed_keys has no effect while allow_all_keys is true");
    }
    for (const field of ["blocked_key_patterns", "blocked_values", "allowed_values"] as const) {
      (c[field] ?? []).forEach((p, i) => {
        if (typeof p !== "string" || p === "") problems.push(`${field}[${i}] is an empty pattern`);
      });
    }
    if (c.hash_function !== undefined && !c.blocked_values?.length && !c.blocked_key_patterns?.length) {
      problems.push("hash_function is set but nothing is blocked, so nothing is hashed");
    }
    return problems;
  },
});
