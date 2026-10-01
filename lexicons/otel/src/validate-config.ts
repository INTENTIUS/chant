/**
 * Collector config checks, as plain functions over `CollectorConfig` and over
 * declared entities.
 *
 * The post-synth checks in `lint/post-synth/` are thin wrappers around these,
 * so the same rules can run anywhere a config exists: on a build's output, on
 * a composite's generated YAML, or on a collector file parsed by some other
 * tool.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { definitionFor, definitionOf, isOTelComponent, isUsablePin, runValidator } from "./define";
import { componentConfig } from "./collector";
import { isComponentId, parseComponentId, pipelineSignal, SIGNALS, type CollectorConfig, type ConnectorSignalPair } from "./model";
import { isPipelineEntity } from "./pipeline";
import { signalToMetricsEntries, type SignalToMetricsConnectorConfig } from "./components/connectors";
import { genAiCardinalityRisk } from "./genai";
import { collectorTopology, type TopologyEdge } from "./topology";
// OTEL112 reads the built-in connectors' signal pairs from the registry.
import "./components/connectors";

export type CollectorIssueCode =
  | "OTEL101"
  | "OTEL102"
  | "OTEL103"
  | "OTEL104"
  | "OTEL105"
  | "OTEL106"
  | "OTEL107"
  | "OTEL108"
  | "OTEL109"
  | "OTEL112"
  | "OTEL113"
  | "OTEL114"
  | "OTEL115"
  | "OTEL116";

export interface CollectorIssue {
  code: CollectorIssueCode;
  severity: "error" | "warning";
  message: string;
  /** The pipeline id the issue is about, when it is about one. */
  pipeline?: string;
  /** The component id the issue is about, when it is about one. */
  component?: string;
}

const KNOWN_SIGNALS = new Set<string>([...SIGNALS, "profiles"]);

function ids(section: Record<string, unknown> | undefined): Set<string> {
  return new Set(Object.keys(section ?? {}));
}

/** Where a connector appears: the pipelines it is an exporter in, and those it is a receiver in. */
interface ConnectorUse {
  asExporter: string[];
  asReceiver: string[];
}

function describePairs(pairs: ReadonlyArray<ConnectorSignalPair>): string {
  return pairs.map((p) => `${p.from} to ${p.to}`).join(", ");
}

/**
 * Check a collector config's references and pipeline shape (OTEL101-OTEL106),
 * each connector's signals against its definition (OTEL112), cycles through
 * connectors (OTEL113), connector ids shared with a receiver or exporter
 * (OTEL114), `routing` connector targets (OTEL115), and the attributes
 * connectors split metrics by (OTEL116).
 */
export function validateCollectorConfig(config: CollectorConfig): CollectorIssue[] {
  const issues: CollectorIssue[] = [];
  const receivers = ids(config.receivers);
  const processors = ids(config.processors);
  const exporters = ids(config.exporters);
  const extensions = ids(config.extensions);
  const connectors = ids(config.connectors);
  const pipelines = config.service?.pipelines ?? {};

  const used = { receivers: new Set<string>(), processors: new Set<string>(), exporters: new Set<string>() };
  const connectorUse = new Map<string, ConnectorUse>();

  for (const [pipelineId, pipeline] of Object.entries(pipelines)) {
    const signal = pipelineSignal(pipelineId);
    if (!KNOWN_SIGNALS.has(signal) || !isComponentId(pipelineId)) {
      issues.push({
        code: "OTEL106",
        severity: "error",
        pipeline: pipelineId,
        message: `pipeline "${pipelineId}" does not name a signal; a pipeline id is traces, metrics or logs, optionally followed by /name`,
      });
    }
    const p = pipeline ?? {};
    const lists: Array<["receivers" | "processors" | "exporters", string[] | undefined, Set<string>, string]> = [
      ["receivers", p.receivers, receivers, "receiver"],
      ["processors", p.processors, processors, "processor"],
      ["exporters", p.exporters, exporters, "exporter"],
    ];
    for (const [field, refs, declared, noun] of lists) {
      for (const ref of refs ?? []) {
        const id = String(ref);
        used[field].add(id);
        if (!isComponentId(id)) {
          issues.push({
            code: "OTEL106",
            severity: "error",
            pipeline: pipelineId,
            component: id,
            message: `pipeline "${pipelineId}" lists ${noun} "${id}", which is not a component id (type or type/name)`,
          });
          continue;
        }
        const viaConnector = field !== "processors" && connectors.has(id);
        if (viaConnector) {
          const use = connectorUse.get(id) ?? { asExporter: [], asReceiver: [] };
          (field === "exporters" ? use.asExporter : use.asReceiver).push(pipelineId);
          connectorUse.set(id, use);
        }
        if (!declared.has(id) && !viaConnector) {
          issues.push({
            code: "OTEL101",
            severity: "error",
            pipeline: pipelineId,
            component: id,
            message: `pipeline "${pipelineId}" uses ${noun} "${id}", which is not declared under ${field}; the collector refuses to start`,
          });
        }
      }
    }
    if ((p.receivers ?? []).length === 0) {
      issues.push({
        code: "OTEL102",
        severity: "error",
        pipeline: pipelineId,
        message: `pipeline "${pipelineId}" has no receivers, so nothing enters it`,
      });
    }
    if ((p.exporters ?? []).length === 0) {
      issues.push({
        code: "OTEL102",
        severity: "error",
        pipeline: pipelineId,
        message: `pipeline "${pipelineId}" has no exporters, so what enters it goes nowhere`,
      });
    }
    const procs = (p.processors ?? []).map(String);
    const limiterAt = procs.findIndex((id) => id === "memory_limiter" || id.startsWith("memory_limiter/"));
    if (limiterAt > 0) {
      issues.push({
        code: "OTEL105",
        severity: "warning",
        pipeline: pipelineId,
        component: procs[limiterAt],
        message: `pipeline "${pipelineId}" runs ${procs[limiterAt]} at position ${limiterAt + 1}; put it first so it can refuse data before other processors buffer it`,
      });
    }
  }

  // A connector joins two pipelines, so the collector refuses one that is
  // listed on only one side.
  for (const [id, use] of connectorUse) {
    if (use.asReceiver.length === 0) {
      issues.push({
        code: "OTEL101",
        severity: "error",
        pipeline: use.asExporter[0],
        component: id,
        message: `connector "${id}" is an exporter in pipeline "${use.asExporter[0]}" but no pipeline lists it as a receiver; a connector must appear on both sides, and the collector refuses to start`,
      });
    } else if (use.asExporter.length === 0) {
      issues.push({
        code: "OTEL101",
        severity: "error",
        pipeline: use.asReceiver[0],
        component: id,
        message: `connector "${id}" is a receiver in pipeline "${use.asReceiver[0]}" but no pipeline lists it as an exporter; a connector must appear on both sides, and the collector refuses to start`,
      });
    } else {
      issues.push(...connectorSignalIssues(id, use));
    }
  }

  const unused: Array<[Set<string>, Set<string>, string]> = [
    [receivers, used.receivers, "receiver"],
    [processors, used.processors, "processor"],
    [exporters, used.exporters, "exporter"],
    [connectors, new Set(connectorUse.keys()), "connector"],
  ];
  for (const [declared, usedIds, noun] of unused) {
    for (const id of declared) {
      if (!usedIds.has(id)) {
        issues.push({
          code: "OTEL103",
          severity: "warning",
          component: id,
          message: `${noun} "${id}" is declared but no pipeline uses it; the collector ignores it`,
        });
      }
    }
  }

  const enabled = new Set((config.service?.extensions ?? []).map(String));
  for (const id of enabled) {
    if (!extensions.has(id)) {
      issues.push({
        code: "OTEL104",
        severity: "error",
        component: id,
        message: `service.extensions enables "${id}", which is not declared under extensions; the collector refuses to start`,
      });
    }
  }
  for (const id of extensions) {
    if (!enabled.has(id)) {
      issues.push({
        code: "OTEL103",
        severity: "warning",
        component: id,
        message: `extension "${id}" is declared but not listed in service.extensions, so it never starts`,
      });
    }
  }

  issues.push(
    ...connectorCycleIssues(config),
    ...connectorIdIssues(config),
    ...routingTargetIssues(config),
    ...metricAttributeIssues(config),
  );

  return issues;
}

/**
 * OTEL113: the pipelines and the connectors between them must form a graph
 * with no cycle, or the collector refuses to start. Reads the edges
 * `collectorTopology()` returns, so an edge counts only for a signal pair the
 * connector supports, as in the collector's own graph. Reports each strongly
 * connected group of pipelines once, with one cycle through it.
 */
function connectorCycleIssues(config: CollectorConfig): CollectorIssue[] {
  const { pipelines, edges } = collectorTopology(config);
  const out = new Map<string, TopologyEdge[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);

  // Tarjan's strongly connected components, in pipeline order.
  const order = pipelines.map((p) => p.id);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  const visit = (v: string) => {
    index.set(v, index.size);
    low.set(v, index.get(v)!);
    stack.push(v);
    onStack.add(v);
    for (const { to } of out.get(v) ?? []) {
      if (!index.has(to)) {
        visit(to);
        low.set(v, Math.min(low.get(v)!, low.get(to)!));
      } else if (onStack.has(to)) {
        low.set(v, Math.min(low.get(v)!, index.get(to)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const group: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      groups.push(group);
    }
  };
  for (const id of order) if (!index.has(id)) visit(id);

  const issues: CollectorIssue[] = [];
  for (const group of groups) {
    const members = new Set(group);
    const start = order.find((id) => members.has(id))!;
    const path = shortestCycle(start, members, out);
    if (!path) continue; // a single pipeline with no edge to itself
    const hops = path.map((e) => `${e.from} -> ${e.connector}`).join(" -> ");
    issues.push({
      code: "OTEL113",
      severity: "error",
      pipeline: start,
      message: `pipelines form a cycle through connectors: ${hops} -> ${start}; the collector refuses to start`,
    });
  }
  return issues;
}

/** The shortest path of edges from `start` back to itself, staying inside `members`. */
function shortestCycle(start: string, members: Set<string>, out: Map<string, TopologyEdge[]>): TopologyEdge[] | undefined {
  const via = new Map<string, TopologyEdge>();
  const queue = [start];
  while (queue.length > 0) {
    const v = queue.shift()!;
    for (const e of out.get(v) ?? []) {
      if (!members.has(e.to)) continue;
      if (e.to === start) {
        const path = [e];
        for (let at = v; at !== start; at = via.get(at)!.from) path.unshift(via.get(at)!);
        return path;
      }
      if (!via.has(e.to)) {
        via.set(e.to, e);
        queue.push(e.to);
      }
    }
  }
  return undefined;
}

/**
 * OTEL114: a pipeline names a connector the same way it names a receiver or
 * an exporter, so the collector refuses a connector id that is also declared
 * under receivers or exporters, used or not.
 */
function connectorIdIssues(config: CollectorConfig): CollectorIssue[] {
  const receivers = ids(config.receivers);
  const exporters = ids(config.exporters);
  const issues: CollectorIssue[] = [];
  for (const id of ids(config.connectors)) {
    const clashes = [receivers.has(id) ? "receiver" : "", exporters.has(id) ? "exporter" : ""].filter(Boolean);
    if (clashes.length === 0) continue;
    const type = parseComponentId(id)?.type ?? id;
    issues.push({
      code: "OTEL114",
      severity: "error",
      component: id,
      message: `connector "${id}" has the same id as a declared ${clashes.join(" and ")}, so a pipeline listing "${id}" is ambiguous and the collector refuses to start; rename one of them (e.g. "${type}/connector")`,
    });
  }
  return issues;
}

/**
 * OTEL115: each pipeline a `routing` connector routes to, in `table[].pipelines`
 * or `default_pipelines`, must list that connector in its receivers. The
 * connector can only hand data to the pipelines it feeds, and the collector
 * refuses to start when a route names any other.
 */
function routingTargetIssues(config: CollectorConfig): CollectorIssue[] {
  const pipelines = config.service?.pipelines ?? {};
  const issues: CollectorIssue[] = [];
  for (const [id, raw] of Object.entries(config.connectors ?? {})) {
    if (parseComponentId(id)?.type !== "routing") continue;
    const cfg = (raw ?? {}) as { table?: Array<{ pipelines?: unknown }>; default_pipelines?: unknown };
    const targets: Array<[string, string]> = [];
    (Array.isArray(cfg.table) ? cfg.table : []).forEach((item, i) => {
      for (const t of Array.isArray(item?.pipelines) ? item.pipelines : []) targets.push([String(t), `table[${i}].pipelines`]);
    });
    for (const t of Array.isArray(cfg.default_pipelines) ? cfg.default_pipelines : []) targets.push([String(t), "default_pipelines"]);

    const reported = new Set<string>();
    for (const [target, where] of targets) {
      if (reported.has(target)) continue;
      const pipeline = Object.prototype.hasOwnProperty.call(pipelines, target) ? pipelines[target] : undefined;
      if (pipeline && (pipeline.receivers ?? []).map(String).includes(id)) continue;
      reported.add(target);
      issues.push({
        code: "OTEL115",
        severity: "error",
        pipeline: target,
        component: id,
        message: pipeline
          ? `routing connector "${id}" routes to pipeline "${target}" (${where}), which does not list "${id}" in its receivers; the collector refuses to start`
          : `routing connector "${id}" routes to pipeline "${target}" (${where}), which is not declared under service.pipelines; the collector refuses to start`,
      });
    }
  }
  return issues;
}

/** Where a connector lists the attribute keys it splits metrics by. */
interface MetricAttributeUse {
  key: string;
  /** The config field, e.g. `dimensions` or `spans.genai.tokens.attributes`. */
  field: string;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function keysOf(items: unknown, prop: "name" | "key", field: string): MetricAttributeUse[] {
  return list(items).flatMap((item) => {
    const key = typeof item === "string" ? item : (item as Record<string, unknown> | null)?.[prop];
    return typeof key === "string" ? [{ key, field }] : [];
  });
}

/**
 * The attribute keys a built-in metrics connector puts on the metrics it
 * makes, by type. An empty or unset `include_resource_attributes` keeps
 * every resource attribute, whichever they are, so only listed keys can be
 * named.
 */
function metricAttributeUses(type: string, config: Record<string, unknown>): MetricAttributeUse[] {
  switch (type) {
    case "spanmetrics": {
      const histogram = config.histogram as Record<string, unknown> | undefined;
      const events = config.events as Record<string, unknown> | undefined;
      return [
        ...keysOf(config.dimensions, "name", "dimensions"),
        ...keysOf(config.calls_dimensions, "name", "calls_dimensions"),
        ...keysOf(histogram?.dimensions, "name", "histogram.dimensions"),
        ...keysOf(events?.dimensions, "name", "events.dimensions"),
      ];
    }
    case "servicegraph":
      return keysOf(config.dimensions, "name", "dimensions");
    case "count":
    case "sum":
      return Object.entries(config).flatMap(([section, metrics]) =>
        typeof metrics === "object" && metrics !== null && !Array.isArray(metrics)
          ? Object.entries(metrics as Record<string, unknown>).flatMap(([name, info]) =>
              keysOf((info as Record<string, unknown> | null)?.attributes, "key", `${section}.${name}.attributes`),
            )
          : [],
      );
    case "signaltometrics":
      return signalToMetricsEntries(config as SignalToMetricsConnectorConfig).flatMap(({ signal, index, metric }) => {
        const at = metric.name ? `${signal}[${index}] (${metric.name})` : `${signal}[${index}]`;
        return [
          ...keysOf(metric.attributes, "key", `${at}.attributes`),
          ...keysOf(metric.include_resource_attributes, "key", `${at}.include_resource_attributes`),
        ];
      });
    default:
      return [];
  }
}

/**
 * OTEL116: a connector splits metrics by a GenAI attribute that takes a new
 * value per response, tool call, conversation, session or user, or by a
 * content attribute. Each value starts new time series, so the metric's
 * series grow with traffic. The keys are `GENAI_HIGH_CARDINALITY_ATTRIBUTES`
 * and the content keys in `genai.ts`.
 */
function metricAttributeIssues(config: CollectorConfig): CollectorIssue[] {
  const issues: CollectorIssue[] = [];
  for (const [id, raw] of Object.entries(config.connectors ?? {})) {
    const type = parseComponentId(id)?.type ?? id;
    const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    for (const { key, field } of metricAttributeUses(type, body)) {
      const risk = genAiCardinalityRisk(key);
      if (!risk) continue;
      const why =
        risk === "content"
          ? "it carries message content, which is unbounded and sensitive"
          : "it takes a new value per request, conversation or user";
      issues.push({
        code: "OTEL116",
        severity: "warning",
        component: id,
        message: `connector "${id}" splits metrics by "${key}" (${field}); ${why}, so every value starts new time series. Drop it from the metric's attributes, or keep it on spans and logs`,
      });
    }
  }
  return issues;
}

/**
 * OTEL112: every pipeline a connector joins must pair with a pipeline on the
 * other side through a signal pair the connector supports. This is the
 * collector's own rule: `spanmetrics` fed by a traces pipeline needs a metrics
 * pipeline to receive from it, and cannot be the receiver of a traces
 * pipeline. A connector whose definition this process doesn't have, or whose
 * definition lists no pairs, is not checked.
 */
function connectorSignalIssues(id: string, use: ConnectorUse): CollectorIssue[] {
  const type = parseComponentId(id)?.type ?? id;
  const pairs = definitionOf("connector", type)?.connects;
  if (!pairs || pairs.length === 0) return [];
  const supported = (from: string, to: string) => pairs.some((p) => p.from === from && p.to === to);
  const inSignals = use.asExporter.map(pipelineSignal);
  const outSignals = use.asReceiver.map(pipelineSignal);
  const issues: CollectorIssue[] = [];
  for (const pipeline of use.asExporter) {
    const from = pipelineSignal(pipeline);
    if (outSignals.some((to) => supported(from, to))) continue;
    issues.push({
      code: "OTEL112",
      severity: "error",
      pipeline,
      component: id,
      message: `connector "${id}" is an exporter in ${from} pipeline "${pipeline}", but no pipeline it feeds carries a signal ${type} makes from ${from} (it supports ${describePairs(pairs)}); the collector refuses to start`,
    });
  }
  for (const pipeline of use.asReceiver) {
    const to = pipelineSignal(pipeline);
    if (inSignals.some((from) => supported(from, to))) continue;
    issues.push({
      code: "OTEL112",
      severity: "error",
      pipeline,
      component: id,
      message: `connector "${id}" is a receiver in ${to} pipeline "${pipeline}", but no pipeline feeding it carries a signal ${type} turns into ${to} (it supports ${describePairs(pairs)}); the collector refuses to start`,
    });
  }
  return issues;
}

/**
 * Check declared entities for what only the declaration knows (OTEL107-OTEL109):
 * each component's own config rules, duplicate ids, and custom components'
 * schema pins.
 */
export function validateCollectorEntities(entities: Iterable<Declarable> | Map<string, Declarable>): CollectorIssue[] {
  const list = entities instanceof Map ? [...entities.values()] : [...entities];
  const issues: CollectorIssue[] = [];
  const seen = new Map<string, number>();
  const pipelineIds = new Map<string, number>();

  for (const e of list) {
    if (isPipelineEntity(e)) {
      pipelineIds.set(e.pipelineId, (pipelineIds.get(e.pipelineId) ?? 0) + 1);
      continue;
    }
    if (!isOTelComponent(e)) continue;
    const key = `${e.componentKind} ${e.componentId}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);

    const def = definitionFor(e.entityType);
    if (!def) continue;
    if (!def.builtin && !isUsablePin(def.pin)) {
      issues.push({
        code: "OTEL109",
        severity: "error",
        component: e.componentId,
        message: `custom ${e.componentKind} "${e.componentId}" has no schema pin; give defineComponent a pin with a source and a version`,
      });
    }
    for (const problem of runValidator(def.validate, componentConfig(e) as never)) {
      issues.push({
        code: "OTEL107",
        severity: "error",
        component: e.componentId,
        message: `${e.componentKind} "${e.componentId}": ${problem}`,
      });
    }
  }

  for (const [key, count] of seen) {
    if (count > 1) {
      const [kind, id] = key.split(" ");
      issues.push({
        code: "OTEL108",
        severity: "error",
        component: id,
        message: `${count} ${kind}s declare the id "${id}"; give each a distinct name`,
      });
    }
  }
  for (const [id, count] of pipelineIds) {
    if (count > 1) {
      issues.push({
        code: "OTEL108",
        severity: "error",
        pipeline: id,
        message: `${count} pipelines declare the id "${id}"; give each a distinct name`,
      });
    }
  }
  return issues;
}
