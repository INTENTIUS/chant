/**
 * `Distribution`, the builder manifest `ocb` (the OpenTelemetry Collector
 * Builder) builds a custom collector from (#3374).
 *
 * The fields are the builder's `Config` as read at v0.130.0
 * (`cmd/builder/internal/builder/config.go` in opentelemetry-collector):
 * `dist`, a module list per component kind, `providers`,
 * `converters`, `replaces`, `excludes` and `conf_resolver`. `telemetry`
 * (v0.146.0) is not in it, and `otelcol_version`, removed in v0.113.0, is
 * not either.
 *
 * A component list takes a module (`{ gomod, import?, name?, path? }`) or a
 * component class. A built-in class writes its module at `COLLECTOR_PIN`
 * (`OtlpReceiver` is `go.opentelemetry.io/collector/receiver/otlpreceiver
 * v0.162.0`), and a `defineComponent` class writes its own pin's source and
 * version, so the manifest names the same versions the config was typed
 * against.
 *
 * The serializer writes the manifest as `builder-config.yaml` beside the
 * collector config when a project declares a `Distribution`. OTEL128 then
 * checks that the collector config uses only components the distribution
 * builds. A project without one sees no change.
 */

import { createResource } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import { dump } from "js-yaml";
import { COLLECTOR_PIN, isUsablePin, type ComponentClass, type ComponentDefinition } from "./define";
import { canonicalComponentType, canonicalTypeOf, COMPONENT_KINDS, SECTION_OF, type CollectorConfig, type ComponentKind } from "./model";
import type { CollectorIssue } from "./validate-config";

export const DISTRIBUTION_TYPE = "OTel::Distribution";

/** Where the serializer writes the builder manifest, beside the collector config. */
export const DISTRIBUTION_MANIFEST_FILE = "builder-config.yaml";

/** A Go module the builder adds, as the manifest writes it. */
export interface DistributionModule {
  /** The module and its version, as in `go.mod`: `github.com/acme/otel/exporter/acmeexporter v1.2.0`. */
  gomod: string;
  /** The Go import path, when it differs from the module path. */
  import?: string;
  /** The package name the generated code imports it as. */
  name?: string;
  /** A local path the module is replaced with. */
  path?: string;
}

/** A component the distribution builds: a component class (built-in or `defineComponent`), or its module. */
export type DistributionComponent = ComponentClass<ComponentKind, string, any> | DistributionModule;

/** The `dist` section. */
export interface DistributionDist {
  /** The Go module of the generated collector. */
  module?: string;
  /** The binary's name. */
  name?: string;
  /** The `go` binary to build with. */
  go?: string;
  /** The description `--help` prints. */
  description?: string;
  /** Where the generated sources and the binary go. */
  output_path?: string;
  /** The version the binary reports. */
  version?: string;
  /** Go build tags. */
  build_tags?: string;
  /** Build with debug symbols. */
  debug_compilation?: boolean;
  /** Build with cgo enabled. */
  cgo_enabled?: boolean;
  /** Write `replace` paths as absolute paths in the generated `go.mod`. */
  use_absolute_replace_paths?: boolean;
}

export interface DistributionProps {
  dist: DistributionDist;
  receivers?: DistributionComponent[];
  processors?: DistributionComponent[];
  exporters?: DistributionComponent[];
  connectors?: DistributionComponent[];
  extensions?: DistributionComponent[];
  /** confmap providers (`env`, `file`, `http`, ...). The builder adds its defaults when none are listed. */
  providers?: DistributionModule[];
  /** confmap converters. */
  converters?: DistributionModule[];
  /** `replace` directives for the generated `go.mod`. */
  replaces?: string[];
  /** `exclude` directives for the generated `go.mod`. */
  excludes?: string[];
  conf_resolver?: { default_uri_scheme?: string };
}

export interface DistributionEntity extends Declarable {
  readonly props: DistributionProps;
}

/** A custom collector's builder manifest. Declare at most one per project. */
export const Distribution = createResource(DISTRIBUTION_TYPE, "otel", {}) as unknown as new (
  props: DistributionProps,
) => DistributionEntity;

export function isDistributionEntity(value: unknown): value is DistributionEntity {
  return typeof value === "object" && value !== null && (value as Declarable).entityType === DISTRIBUTION_TYPE;
}

const CORE = "go.opentelemetry.io/collector";
const CONTRIB = "github.com/open-telemetry/opentelemetry-collector-contrib";

/**
 * The Go module of every built-in, by `kind:type`. The core collector's
 * components are in opentelemetry-collector, the rest in contrib; both are
 * released at `COLLECTOR_PIN`'s version. A built-in added to `./components`
 * needs a row here (distribution.test.ts checks).
 */
export const BUILTIN_MODULES: Readonly<Record<string, string>> = Object.freeze({
  "receiver:otlp": `${CORE}/receiver/otlpreceiver`,
  "receiver:filelog": `${CONTRIB}/receiver/filelogreceiver`,
  "receiver:hostmetrics": `${CONTRIB}/receiver/hostmetricsreceiver`,
  "receiver:prometheus": `${CONTRIB}/receiver/prometheusreceiver`,
  "receiver:k8s_cluster": `${CONTRIB}/receiver/k8sclusterreceiver`,
  "receiver:kubeletstats": `${CONTRIB}/receiver/kubeletstatsreceiver`,
  "processor:batch": `${CORE}/processor/batchprocessor`,
  "processor:memory_limiter": `${CORE}/processor/memorylimiterprocessor`,
  "processor:attributes": `${CONTRIB}/processor/attributesprocessor`,
  "processor:deltatocumulative": `${CONTRIB}/processor/deltatocumulativeprocessor`,
  "processor:k8sattributes": `${CONTRIB}/processor/k8sattributesprocessor`,
  "processor:resourcedetection": `${CONTRIB}/processor/resourcedetectionprocessor`,
  "processor:resource": `${CONTRIB}/processor/resourceprocessor`,
  "processor:filter": `${CONTRIB}/processor/filterprocessor`,
  "processor:redaction": `${CONTRIB}/processor/redactionprocessor`,
  "processor:transform": `${CONTRIB}/processor/transformprocessor`,
  "processor:probabilistic_sampler": `${CONTRIB}/processor/probabilisticsamplerprocessor`,
  "processor:tail_sampling": `${CONTRIB}/processor/tailsamplingprocessor`,
  "exporter:debug": `${CORE}/exporter/debugexporter`,
  "exporter:otlp": `${CORE}/exporter/otlpexporter`,
  "exporter:otlphttp": `${CORE}/exporter/otlphttpexporter`,
  "exporter:googlecloud": `${CONTRIB}/exporter/googlecloudexporter`,
  "exporter:prometheus": `${CONTRIB}/exporter/prometheusexporter`,
  "exporter:loadbalancing": `${CONTRIB}/exporter/loadbalancingexporter`,
  "connector:forward": `${CORE}/connector/forwardconnector`,
  "connector:count": `${CONTRIB}/connector/countconnector`,
  "connector:routing": `${CONTRIB}/connector/routingconnector`,
  "connector:servicegraph": `${CONTRIB}/connector/servicegraphconnector`,
  "connector:signaltometrics": `${CONTRIB}/connector/signaltometricsconnector`,
  "connector:spanmetrics": `${CONTRIB}/connector/spanmetricsconnector`,
  "connector:sum": `${CONTRIB}/connector/sumconnector`,
  "extension:zpages": `${CORE}/extension/zpagesextension`,
  "extension:health_check": `${CONTRIB}/extension/healthcheckextension`,
  "extension:k8s_leader_elector": `${CONTRIB}/extension/k8sleaderelector`,
  "extension:pprof": `${CONTRIB}/extension/pprofextension`,
});

const KIND_OF_LIST = {
  receivers: "receiver",
  processors: "processor",
  exporters: "exporter",
  connectors: "connector",
  extensions: "extension",
} as const satisfies Record<string, ComponentKind>;

type ComponentList = keyof typeof KIND_OF_LIST;

const COMPONENT_LISTS = Object.keys(KIND_OF_LIST) as ComponentList[];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isComponentClass(v: unknown): v is ComponentClass<ComponentKind, string, any> {
  return typeof v === "function" && typeof (v as { definition?: unknown }).definition === "object";
}

/** The module a component class is built from, at the version its config type follows. */
export function componentModule(def: ComponentDefinition): DistributionModule {
  if (def.builtin) {
    const path = BUILTIN_MODULES[`${def.kind}:${def.type}`];
    if (!path) throw new Error(`otel: no Go module is recorded for the built-in ${def.kind} "${def.type}"`);
    return { gomod: `${path} ${COLLECTOR_PIN.version}` };
  }
  if (!isUsablePin(def.pin)) {
    throw new Error(`otel: the custom ${def.kind} "${def.type}" has no pin, so its Go module is unknown; list it as { gomod } instead`);
  }
  return { gomod: `${def.pin.source} ${def.pin.version}` };
}

function copyModule(entry: DistributionModule): DistributionModule {
  const out: DistributionModule = { gomod: entry.gomod };
  if (entry.import !== undefined) out.import = entry.import;
  if (entry.name !== undefined) out.name = entry.name;
  if (entry.path !== undefined) out.path = entry.path;
  return out;
}

function moduleOf(entry: DistributionComponent, list: ComponentList): DistributionModule {
  if (isComponentClass(entry)) {
    const def = entry.definition as ComponentDefinition;
    if (def.kind !== KIND_OF_LIST[list]) {
      throw new Error(`otel: ${def.type} is a ${def.kind}, listed under the distribution's ${list}`);
    }
    return componentModule(def);
  }
  return copyModule(entry);
}

/** The builder manifest a distribution writes, as the object `ocb --config` reads. */
export function distributionManifest(dist: DistributionEntity | DistributionProps): Record<string, unknown> {
  const p = isDistributionEntity(dist) ? dist.props : dist;
  const out: Record<string, unknown> = {};
  const d: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.dist ?? {})) if (v !== undefined) d[k] = v;
  out.dist = d;
  for (const list of COMPONENT_LISTS) {
    const entries = p[list];
    if (entries && entries.length > 0) out[list] = entries.map((e) => moduleOf(e, list));
  }
  if (p.providers && p.providers.length > 0) out.providers = p.providers.map(copyModule);
  if (p.converters && p.converters.length > 0) out.converters = p.converters.map(copyModule);
  if (p.replaces && p.replaces.length > 0) out.replaces = [...p.replaces];
  if (p.excludes && p.excludes.length > 0) out.excludes = [...p.excludes];
  if (p.conf_resolver && p.conf_resolver.default_uri_scheme !== undefined) {
    out.conf_resolver = { default_uri_scheme: p.conf_resolver.default_uri_scheme };
  }
  return out;
}

/** The builder manifest as the YAML `ocb --config` reads. */
export function distributionYaml(dist: DistributionEntity | DistributionProps): string {
  return dump(distributionManifest(dist), { lineWidth: -1, noRefs: true });
}

/** The module path of a `gomod` line: everything before the version. */
function modulePath(gomod: string): string {
  return gomod.trim().split(/\s+/)[0];
}

const BUILTIN_BY_PATH = new Map(Object.entries(BUILTIN_MODULES).map(([key, path]) => [path, key.split(":")[1]]));

/**
 * The component type a module builds, when it can be told: a built-in's
 * module, or a module path ending `<type><kind>` as contrib's do
 * (`.../exporter/datadogexporter` is `datadog`). Undefined otherwise.
 */
export function moduleComponentType(kind: ComponentKind, gomod: string): string | undefined {
  const path = modulePath(gomod);
  const builtin = BUILTIN_BY_PATH.get(path);
  if (builtin !== undefined) return builtin;
  const last = path.split("/").pop() ?? "";
  return last.endsWith(kind) && last.length > kind.length ? last.slice(0, -kind.length) : undefined;
}

/** What a distribution builds, per kind: the component types it names, and the modules whose type can't be told. */
export interface DistributionComponents {
  types: Record<ComponentKind, Set<string>>;
  unknown: Record<ComponentKind, string[]>;
}

export function distributionComponents(dist: DistributionEntity | DistributionProps): DistributionComponents {
  const p = isDistributionEntity(dist) ? dist.props : dist;
  const types = { receiver: new Set<string>(), processor: new Set<string>(), exporter: new Set<string>(), connector: new Set<string>(), extension: new Set<string>() };
  const unknown: Record<ComponentKind, string[]> = { receiver: [], processor: [], exporter: [], connector: [], extension: [] };
  for (const list of COMPONENT_LISTS) {
    const kind = KIND_OF_LIST[list];
    for (const entry of p[list] ?? []) {
      if (isComponentClass(entry)) {
        types[kind].add(canonicalComponentType(kind, (entry.definition as ComponentDefinition).type));
        continue;
      }
      const type = moduleComponentType(kind, entry.gomod);
      if (type === undefined) unknown[kind].push(entry.gomod);
      else types[kind].add(canonicalComponentType(kind, type));
    }
  }
  return { types, unknown };
}

/**
 * OTEL128: the components `config` declares that `dist` does not build. A
 * collector built from the distribution refuses such a config at start with
 * "unknown type". When a kind lists a module whose type can't be told from
 * its path, a missing component may be that module, so it is a warning
 * naming the module rather than an error.
 */
export function distributionIssues(config: CollectorConfig, dist: DistributionEntity | DistributionProps): CollectorIssue[] {
  const { types, unknown } = distributionComponents(dist);
  const issues: CollectorIssue[] = [];
  for (const kind of COMPONENT_KINDS) {
    const section = (config as Record<string, unknown>)[SECTION_OF[kind]];
    if (typeof section !== "object" || section === null) continue;
    for (const id of Object.keys(section)) {
      const type = canonicalTypeOf(kind, id);
      if (types[kind].has(type)) continue;
      const unsure = unknown[kind];
      issues.push({
        code: "OTEL128",
        severity: unsure.length > 0 ? "warning" : "error",
        component: id,
        message:
          `${kind} "${id}" is not in the Distribution, so a collector built from it does not know the type "${type}"` +
          (unsure.length > 0
            ? `, unless it is built by ${unsure.map((m) => `"${modulePath(m)}"`).join(", ")}, whose type can't be read from its path`
            : `. Add it to the Distribution's ${SECTION_OF[kind]}, or remove it from the config`),
      });
    }
  }
  return issues;
}
