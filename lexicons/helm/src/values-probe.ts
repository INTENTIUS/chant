/**
 * Build-time coalesced-values probe (#1251, epic #1228 Phase 7) and the
 * provenance derived from it (#1252).
 *
 * `helm template --debug` does not print coalesced values on either major
 * version, and `helm get values --all` needs an installed release — the
 * wrong side of the build/deploy line. So the probe extracts them from helm
 * itself: copy the chart, replace every (sub)chart's `templates/` with a
 * single `chant-values-probe.yaml` template containing `{{ toYaml .Values }}`,
 * render, lift the probe documents out, discard the copy. Coalescing —
 * parent-overrides-child, `global` propagation, alias scoping,
 * `import-values`, tags — is delegated to helm rather than reimplemented
 * (the approximation in `pinnability/values.ts` remains only as the
 * classifier's offline fallback).
 *
 * The probe filename must NOT begin with `_`: helm treats underscore-prefixed
 * template files as partials and skips them without error.
 *
 * The probe runs against a private copy in a temp directory, so the probe
 * document can never appear in a real render of the chart — the pinned
 * artifact path (#1237/#1242) never sees the injected template.
 *
 * A dependency disabled by a `condition:` (or tags) is pruned by helm before
 * rendering, so it yields no probe document. Those instances are reported in
 * `disabled` instead, with the condition path where determinable. Note the
 * ROOT probe document still carries the values subtree a disabled dependency
 * would have received — an installed release omits it (epic findings 14, 15).
 *
 * On the probe output, three provenance products (#1252):
 *
 * - `digest` — `sha256:` over the canonical JSON (core's `canonicalJson`,
 *   the #1237 convention) of the per-instance coalesced trees, keyed by
 *   scope path. Same inputs, same coalesced values, same digest.
 * - `valueSources` — each coalesced path attributed to its winning layer:
 *   chart default / parent override / supplied file / --set.
 * - `deadAssignments` — supplied values that never survive coalescing:
 *   shadowed by a later supplied layer, or targeting a disabled or unknown
 *   subchart path. WHM504 turns these into lint diagnostics.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "@intentius/chant/effect-receipt";
import yaml from "js-yaml";

import { splitDocuments } from "./pinnability/render-stream";
import { readChartMeta, readYamlFile, valueAtPath } from "./pinnability/values";

/**
 * The probe template. Renders one document per chart instance carrying the
 * exact `.Values` that instance coalesced. For an aliased dependency helm
 * sets `.Chart.Name` (and the `# Source:` path segment) to the alias, so two
 * instances over the same chart directory stay distinguishable.
 */
const PROBE_TEMPLATE =
  "chantValuesProbe: v1\nchart: {{ .Chart.Name }}\nvalues:\n{{ .Values | toYaml | nindent 2 }}\n";

/** Must not start with `_` — helm skips underscore-prefixed files as partials. */
const PROBE_FILENAME = "chant-values-probe.yaml";

/** Where a coalesced value came from. `computed` = no supplied or authored layer matches (e.g. `import-values`). */
export type ValueOrigin = "chart default" | "parent override" | "supplied file" | "--set" | "computed";

/**
 * One layer of values supplied to the render, in ascending precedence order
 * (a later layer overrides an earlier one, like repeated `--values` flags;
 * `--set` layers conventionally come last). `origin` is the label reported
 * by `valueSources` and dead-assignment findings.
 */
export interface SuppliedValuesLayer {
  origin: "supplied file" | "--set";
  /** Optional identifier (a file path, a flag) used in messages. */
  name?: string;
  values: Record<string, unknown>;
}

/** One chart instance and the values helm coalesced for it. */
export interface CoalescedChartValues {
  /** Value scope from the root: `[]` for the root chart, `["kidtwo"]` for an aliased dependency, nested for grandchildren. */
  scope: string[];
  /** `.Chart.Name` as rendered — the alias for an aliased dependency. */
  chartName: string;
  /** The fully coalesced values this instance saw, exactly as helm computed them. */
  values: Record<string, unknown>;
}

/** A declared dependency helm pruned before rendering. */
export interface DisabledDependency {
  scope: string[];
  /** The dependency's real chart name (not the alias). */
  name: string;
  /** The `condition:` path that resolved false, when determinable (tags-disabled dependencies carry none). */
  condition?: string;
}

/** A supplied value that never survives coalescing. */
export interface DeadAssignment {
  /** Dot-joined path in root coordinates. */
  path: string;
  /** The layer that supplied it, e.g. `supplied file (values-prod.yaml)`. */
  origin: string;
  reason: "shadowed" | "disabled-subchart" | "unknown-subchart";
  /** What killed it: the shadowing layer, or the disabling condition. */
  shadowedBy?: string;
}

export interface CoalescedValuesProbe {
  /** Enabled chart instances, root first, then by scope path. */
  instances: CoalescedChartValues[];
  disabled: DisabledDependency[];
  /** `sha256:` over the canonical JSON of the per-instance coalesced trees. */
  digest: string;
  /** Dot-joined path (root coordinates, subchart paths scope-prefixed) to winning layer. */
  valueSources: Record<string, ValueOrigin>;
  deadAssignments: DeadAssignment[];
  warnings: string[];
}

export interface ValuesProbeOptions {
  /** Directory of the chart to probe (must contain Chart.yaml). Never modified — the probe works on a copy. */
  chartDir: string;
  /** Logical name recorded with the probe. Defaults to the release name. */
  name?: string;
  /** Release name passed to `helm template`. Default `chant-values-probe`. */
  releaseName?: string;
  namespace?: string;
  /** Values layers in ascending precedence order. */
  supplied?: SuppliedValuesLayer[];
  /** Injectable helm runner (tests). Receives the full argv after `helm`. */
  runHelm?: (args: string[]) => string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

/**
 * Leaf paths of a values tree. Arrays and empty maps are leaves — helm
 * replaces arrays wholesale and an empty map carries no mergeable children.
 */
function leafPaths(v: unknown, prefix: string[] = []): string[][] {
  if (isPlainObject(v) && Object.keys(v).length > 0) {
    const out: string[][] = [];
    for (const [k, child] of Object.entries(v)) out.push(...leafPaths(child, [...prefix, k]));
    return out;
  }
  return prefix.length > 0 ? [prefix] : [];
}

/** A node of the declared dependency tree (walked over the probe's chart copy). */
interface ScopeNode {
  scope: string[];
  /** Real chart name. */
  name: string;
  /** Chart directory (aliased instances share one). */
  dir: string;
  condition?: string;
  /** Scope of the parent node ([] for children of the root). */
  parentScope: string[];
}

const scopeKey = (scope: readonly string[]): string => scope.join(".");

/**
 * Walk the (copied, tgz-extracted) chart tree the way helm's loader does:
 * declared dependencies under their alias-or-name key, undeclared `charts/`
 * directories as implicit always-enabled dependencies.
 */
function collectScopeNodes(rootDir: string): ScopeNode[] {
  const nodes: ScopeNode[] = [];
  const visit = (dir: string, scope: string[]): void => {
    const meta = readChartMeta(dir);
    nodes.push({
      scope,
      name: meta.name,
      dir,
      parentScope: scope.slice(0, -1),
      // condition is attached where the dependency is declared, below.
    });
    const chartsDir = join(dir, "charts");
    const childDirs = existsSync(chartsDir)
      ? readdirSync(chartsDir).filter((e) => {
          const p = join(chartsDir, e);
          return statSync(p).isDirectory() && existsSync(join(p, "Chart.yaml"));
        })
      : [];
    const declared = new Set<string>();
    for (const dep of meta.dependencies) {
      const childDir = join(chartsDir, dep.name);
      if (!existsSync(join(childDir, "Chart.yaml"))) continue;
      declared.add(dep.name);
      const childScope = [...scope, dep.alias ?? dep.name];
      visit(childDir, childScope);
      const node = nodes.find((n) => scopeKey(n.scope) === scopeKey(childScope));
      if (node) node.condition = dep.condition;
    }
    for (const name of childDirs) {
      if (!declared.has(name)) visit(join(chartsDir, name), [...scope, name]);
    }
  };
  visit(rootDir, []);
  return nodes;
}

/**
 * Extract packaged subcharts (`charts/*.tgz`) in place so probes can be
 * injected into them, then recurse. Uses the system `tar`; a failed
 * extraction leaves the tgz alone and records a warning — that subchart's
 * values then appear only through its parents' probe documents.
 */
function extractPackagedSubcharts(dir: string, warnings: string[]): void {
  const chartsDir = join(dir, "charts");
  if (!existsSync(chartsDir)) return;
  for (const entry of readdirSync(chartsDir)) {
    if (!entry.endsWith(".tgz")) continue;
    const tgz = join(chartsDir, entry);
    if (!statSync(tgz).isFile()) continue;
    try {
      // A chart archive unpacks to a single top-level directory named after
      // the chart. Skip when that directory already exists.
      execFileSync("tar", ["-xzf", tgz, "-C", chartsDir], { stdio: "ignore" });
      rmSync(tgz);
    } catch {
      warnings.push(`could not extract packaged subchart ${entry} — its own probe document is skipped`);
    }
  }
  for (const entry of readdirSync(chartsDir)) {
    const p = join(chartsDir, entry);
    if (statSync(p).isDirectory() && existsSync(join(p, "Chart.yaml"))) {
      extractPackagedSubcharts(p, warnings);
    }
  }
}

/**
 * Replace each (sub)chart's `templates/` with the single probe template.
 * Deleting the real templates sidesteps render-time failures (`required`,
 * missing capabilities) — values coalescing does not depend on them.
 * Library charts are left alone: helm never renders their templates.
 */
function injectProbes(dir: string, warnings: string[]): void {
  const chartYaml = readYamlFile(join(dir, "Chart.yaml")) as { type?: unknown } | undefined;
  if (chartYaml?.type === "library") {
    warnings.push(`${dir} is a library chart — helm renders no templates for it, so it yields no probe document`);
  } else {
    const templatesDir = join(dir, "templates");
    rmSync(templatesDir, { recursive: true, force: true });
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, PROBE_FILENAME), PROBE_TEMPLATE);
  }
  const chartsDir = join(dir, "charts");
  if (!existsSync(chartsDir)) return;
  for (const entry of readdirSync(chartsDir)) {
    const p = join(chartsDir, entry);
    if (statSync(p).isDirectory() && existsSync(join(p, "Chart.yaml"))) injectProbes(p, warnings);
  }
}

function defaultRunHelm(args: string[]): string {
  try {
    return execFileSync("helm", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err ? String((err as { stderr: unknown }).stderr) : String(err);
    throw new Error(
      `coalesced-values probe render failed:\n${stderr}\n` +
        `Hint: ensure the 'helm' CLI is on PATH and the chart's dependencies are vendored under charts/.`,
    );
  }
}

/** Scope of a probe document, from its `# Source:` path — every segment following a `charts/`. */
function scopeFromSource(sourceLine: string): string[] | undefined {
  const m = sourceLine.match(/^# Source: (\S+)$/m);
  if (!m) return undefined;
  const segments = m[1].split("/");
  if (segments[segments.length - 1] !== PROBE_FILENAME) return undefined;
  const scope: string[] = [];
  for (let i = 1; i < segments.length - 2; i += 2) {
    if (segments[i] !== "charts") return undefined;
    scope.push(segments[i + 1]);
  }
  return scope;
}

/**
 * The coalesced-values identity: `sha256:` over the canonical JSON of the
 * per-instance trees keyed by scope path — the #1237 digest conventions
 * (core `canonicalJson`, `sha256:` prefix). Two renders that coalesce the
 * same values for every instance share it; any value, in any subchart,
 * changing breaks it.
 */
export function coalescedValuesDigest(instances: readonly CoalescedChartValues[]): string {
  const tree: Record<string, unknown> = {};
  for (const i of instances) tree[scopeKey(i.scope)] = i.values;
  return `sha256:${createHash("sha256").update(canonicalJson(tree), "utf8").digest("hex")}`;
}

/** Inputs the pure provenance analysis needs — separable from the render for tests. */
export interface ValuesAttributionInput {
  instances: readonly CoalescedChartValues[];
  supplied: readonly SuppliedValuesLayer[];
  /** The chart-default `values.yaml` for an instance scope; undefined when unknown. */
  defaultsFor: (scope: readonly string[]) => Record<string, unknown> | undefined;
}

/**
 * Attribute each coalesced path to the layer that won it.
 *
 * Keys are dot-joined root-coordinate paths: a subchart instance's paths are
 * prefixed with its scope, so `kidtwo.replicas` is the `replicas` the
 * `kidtwo` instance actually sees. A key of an instance's tree that is
 * itself an enabled child scope is skipped — helm pushes the child's
 * coalesced tree back into the parent's `.Values`, and the child instance
 * owns those paths.
 *
 * Layer precedence mirrors helm: supplied layers (last first), then ancestor
 * chart defaults (root outranks intermediates — "parent override"), then the
 * instance's own defaults ("chart default"). A path no layer explains — an
 * `import-values` product, a helm-computed merge — reports `computed`.
 * Attribution matches on value equality, so a layer that assigned a path but
 * lost it reports as the layer that actually won.
 */
export function computeValueSources(input: ValuesAttributionInput): Record<string, ValueOrigin> {
  const out: Record<string, ValueOrigin> = {};
  const instanceScopes = new Set(input.instances.map((i) => scopeKey(i.scope)));

  for (const instance of input.instances) {
    for (const path of leafPaths(instance.values)) {
      // Skip paths under an enabled child scope — the child instance owns them.
      if (instanceScopes.has(scopeKey([...instance.scope, path[0]]))) continue;
      const coalesced = valueAtPath(instance.values, path);
      out[scopeKey([...instance.scope, ...path])] = attributePath(instance, path, coalesced, input);
    }
  }
  return out;
}

function attributePath(
  instance: CoalescedChartValues,
  path: string[],
  coalesced: unknown,
  input: ValuesAttributionInput,
): ValueOrigin {
  const rootPath = [...instance.scope, ...path];
  const isGlobal = path[0] === "global" && instance.scope.length > 0;

  // 1. Supplied layers, highest precedence first. A subchart's `global.*`
  //    can be fed either scoped (`<scope>.global.*`) or from the root
  //    `global.*` — scoped wins, so check it first.
  for (let i = input.supplied.length - 1; i >= 0; i--) {
    const layer = input.supplied[i];
    let candidate = valueAtPath(layer.values, rootPath);
    if (candidate === undefined && isGlobal) candidate = valueAtPath(layer.values, path);
    if (candidate !== undefined && deepEqual(candidate, coalesced)) return layer.origin;
  }

  // 2. Ancestor chart defaults — the top parent outranks intermediates.
  for (let prefixLen = 0; prefixLen < instance.scope.length; prefixLen++) {
    const ancestorScope = instance.scope.slice(0, prefixLen);
    const defaults = input.defaultsFor(ancestorScope);
    if (defaults === undefined) continue;
    const rel = [...instance.scope.slice(prefixLen), ...path];
    let candidate = valueAtPath(defaults, rel);
    if (candidate === undefined && isGlobal) candidate = valueAtPath(defaults, path);
    if (candidate !== undefined && deepEqual(candidate, coalesced)) return "parent override";
  }

  // 3. The instance's own values.yaml.
  const own = input.defaultsFor(instance.scope);
  if (own !== undefined) {
    const candidate = valueAtPath(own, path);
    if (candidate !== undefined && deepEqual(candidate, coalesced)) return "chart default";
  }

  return "computed";
}

const layerLabel = (layer: SuppliedValuesLayer): string =>
  layer.name !== undefined ? `${layer.origin} (${layer.name})` : layer.origin;

/**
 * Supplied values that never survive coalescing:
 *
 * - `shadowed` — a later supplied layer assigns the same path (a map merging
 *   into a map is not a shadow; anything else replaces).
 * - `disabled-subchart` — the path targets a dependency a `condition:` (or
 *   tags) disabled, so no rendered chart ever reads it.
 * - `unknown-subchart` — a map supplied under a top-level key that matches
 *   no dependency, no root default, and not `global`, on a chart that HAS
 *   dependencies: the classic silently-ignored typo of a subchart name.
 *   Reported once per top-level key per layer.
 */
export function findDeadAssignments(
  input: ValuesAttributionInput,
  disabled: readonly DisabledDependency[],
): DeadAssignment[] {
  const out: DeadAssignment[] = [];
  const rootDefaults = input.defaultsFor([]) ?? {};
  const knownFirstSegments = new Set<string>(["global", ...Object.keys(rootDefaults)]);
  let hasDependencies = false;
  for (const i of input.instances) {
    if (i.scope.length > 0) {
      knownFirstSegments.add(i.scope[0]);
      hasDependencies = true;
    }
  }
  for (const d of disabled) {
    knownFirstSegments.add(d.scope[0]);
    if (d.name !== d.scope[0]) knownFirstSegments.add(d.name);
    hasDependencies = true;
  }

  for (let i = 0; i < input.supplied.length; i++) {
    const layer = input.supplied[i];
    const flaggedUnknown = new Set<string>();
    for (const path of leafPaths(layer.values)) {
      const value = valueAtPath(layer.values, path);

      // Shadowed by a later supplied layer?
      const shadow = input.supplied.slice(i + 1).find((later) => {
        const laterValue = valueAtPath(later.values, path);
        if (laterValue === undefined) return false;
        return !(isPlainObject(value) && isPlainObject(laterValue));
      });
      if (shadow) {
        out.push({
          path: scopeKey(path),
          origin: layerLabel(layer),
          reason: "shadowed",
          shadowedBy: layerLabel(shadow),
        });
        continue;
      }

      // Targeting a disabled dependency?
      const disabledHit = disabled.find(
        (d) => d.scope.length <= path.length && scopeKey(path.slice(0, d.scope.length)) === scopeKey(d.scope),
      );
      if (disabledHit) {
        out.push({
          path: scopeKey(path),
          origin: layerLabel(layer),
          reason: "disabled-subchart",
          shadowedBy:
            disabledHit.condition !== undefined
              ? `disabled subchart ${scopeKey(disabledHit.scope)} (condition ${disabledHit.condition} is false)`
              : `disabled subchart ${scopeKey(disabledHit.scope)}`,
        });
        continue;
      }

      // A map under an unknown top-level key on a chart with dependencies?
      if (
        hasDependencies &&
        path.length > 1 &&
        !knownFirstSegments.has(path[0]) &&
        isPlainObject(layer.values[path[0]]) &&
        !flaggedUnknown.has(path[0])
      ) {
        flaggedUnknown.add(path[0]);
        out.push({
          path: path[0],
          origin: layerLabel(layer),
          reason: "unknown-subchart",
          shadowedBy: `no dependency, chart default, or global named "${path[0]}"`,
        });
      }
    }
  }
  return out;
}

/**
 * Run the probe: copy the chart, inject probe templates, render, lift the
 * probe documents out, analyze, discard the copy. The source chart is never
 * touched. Every run is recorded for WHM504 (`getValuesProbeRecords`).
 */
export function probeCoalescedValues(options: ValuesProbeOptions): CoalescedValuesProbe {
  if (!existsSync(join(options.chartDir, "Chart.yaml"))) {
    throw new Error(`coalesced-values probe: ${options.chartDir} has no Chart.yaml`);
  }
  const warnings: string[] = [];
  const supplied = options.supplied ?? [];
  const workRoot = mkdtempSync(join(tmpdir(), "chant-values-probe-"));
  try {
    const chartCopy = join(workRoot, "chart");
    cpSync(options.chartDir, chartCopy, { recursive: true });
    extractPackagedSubcharts(chartCopy, warnings);
    injectProbes(chartCopy, warnings);
    const scopeNodes = collectScopeNodes(chartCopy);

    const releaseName = options.releaseName ?? "chant-values-probe";
    const args = ["template", releaseName, chartCopy];
    if (options.namespace !== undefined) args.push("--namespace", options.namespace);
    supplied.forEach((layer, i) => {
      const layerPath = join(workRoot, `supplied-${i}.yaml`);
      writeFileSync(layerPath, yaml.dump(layer.values, { lineWidth: -1, noRefs: true }));
      args.push("--values", layerPath);
    });
    const rendered = (options.runHelm ?? defaultRunHelm)(args);

    // Lift the probe documents out.
    const instances: CoalescedChartValues[] = [];
    for (const doc of splitDocuments(rendered)) {
      if (!doc.includes("chantValuesProbe:")) continue;
      let parsed: unknown;
      try {
        parsed = yaml.load(doc);
      } catch {
        warnings.push("a probe document failed to parse as YAML — skipped");
        continue;
      }
      if (!isPlainObject(parsed) || parsed.chantValuesProbe !== "v1") continue;
      const scope = scopeFromSource(doc);
      if (scope === undefined) {
        warnings.push("a probe document carried no usable # Source: header — skipped");
        continue;
      }
      instances.push({
        scope,
        chartName: typeof parsed.chart === "string" ? parsed.chart : "",
        values: isPlainObject(parsed.values) ? parsed.values : {},
      });
    }
    instances.sort((a, b) => a.scope.length - b.scope.length || scopeKey(a.scope).localeCompare(scopeKey(b.scope)));
    if (instances.length === 0) {
      throw new Error(
        `coalesced-values probe: render of ${options.chartDir} produced no probe document — is the chart renderable?`,
      );
    }
    const root = instances[0];

    // Declared dependencies with no probe document were pruned by helm —
    // disabled by a condition (evaluated here against the EXACT coalesced
    // root values) or by tags. Only nodes whose parent rendered are
    // reported; a disabled subtree's descendants are unreachable anyway.
    const probedScopes = new Set(instances.map((i) => scopeKey(i.scope)));
    const disabled: DisabledDependency[] = [];
    for (const node of scopeNodes) {
      if (node.scope.length === 0 || probedScopes.has(scopeKey(node.scope))) continue;
      if (!probedScopes.has(scopeKey(node.parentScope))) continue;
      let condition: string | undefined;
      for (const rawPath of (node.condition ?? "").split(",")) {
        const path = rawPath.trim();
        if (path === "") continue;
        const v = valueAtPath(root.values, path.split("."));
        if (v === undefined) continue;
        if (v === false) condition = path;
        break;
      }
      disabled.push({ scope: node.scope, name: node.name, condition });
    }

    const defaultsCache = new Map<string, Record<string, unknown> | undefined>();
    const defaultsFor = (scope: readonly string[]): Record<string, unknown> | undefined => {
      const key = scopeKey(scope);
      if (!defaultsCache.has(key)) {
        const node = scopeNodes.find((n) => scopeKey(n.scope) === key);
        const loaded = node ? readYamlFile(join(node.dir, "values.yaml")) : undefined;
        defaultsCache.set(key, isPlainObject(loaded) ? loaded : undefined);
      }
      return defaultsCache.get(key);
    };

    const attribution: ValuesAttributionInput = { instances, supplied, defaultsFor };
    const probe: CoalescedValuesProbe = {
      instances,
      disabled,
      digest: coalescedValuesDigest(instances),
      valueSources: computeValueSources(attribution),
      deadAssignments: findDeadAssignments(attribution, disabled),
      warnings,
    };
    probeRecords.push({ name: options.name ?? releaseName, chartDir: options.chartDir, probe });
    return probe;
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

/** What one probe run recorded about itself — the WHM504 lint surface. */
export interface HelmValuesProbeRecord {
  name: string;
  chartDir: string;
  probe: CoalescedValuesProbe;
}

const probeRecords: HelmValuesProbeRecord[] = [];

/** Every probe recorded in this process, in invocation order. */
export function getValuesProbeRecords(): readonly HelmValuesProbeRecord[] {
  return probeRecords;
}

/** Record a probe computed elsewhere (the render path integration point). */
export function recordValuesProbe(record: HelmValuesProbeRecord): void {
  probeRecords.push(record);
}

/** Reset the record list (test isolation). */
export function clearValuesProbeRecords(): void {
  probeRecords.length = 0;
}

/**
 * The values gap between the probe and an installed release: an installed
 * release's `helm get values --all` omits subtrees for disabled
 * dependencies; the probe's root document keeps them (epic findings 14, 15).
 * On shared keys the two agree — this helper names the shared-key view for
 * comparisons against a live release.
 */
export function rootCoalescedValues(probe: CoalescedValuesProbe): Record<string, unknown> {
  return probe.instances[0]?.values ?? {};
}
