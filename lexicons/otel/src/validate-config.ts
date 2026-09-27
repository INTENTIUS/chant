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
  | "OTEL112";

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
 * and each connector's signals against its definition (OTEL112).
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
