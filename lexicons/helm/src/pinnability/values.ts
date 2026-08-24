/**
 * Chart model and value coalescing for the pinnability classifier (#1234,
 * epic #1228).
 *
 * Pinnability is a property of `(chart, values)`, not of the chart alone —
 * so the classifier needs each subchart instance's EFFECTIVE values to ask
 * whether a gate is open. This module walks `Chart.yaml` dependencies
 * (aliases and `condition:` included — finding 12: dependency conditions are
 * values-driven and therefore closed inputs) and approximates helm's
 * coalescing: child defaults, overridden by the parent's `<alias-or-name>`
 * subtree, with `global` propagated down.
 *
 * The approximation is deliberate and bounded. `import-values`, `tags`, and
 * `tpl`-computed values are not modeled; a gate they would decide resolves
 * as UNKNOWN and the classifier refuses rather than pins (see
 * conditions.ts). The build-time values probe (#1251) replaces this with
 * helm's own coalescing.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

export interface ChartDependency {
  name: string;
  alias?: string;
  /** Comma-separated values paths, evaluated against the ROOT values. */
  condition?: string;
}

export interface ChartMeta {
  name: string;
  dependencies: ChartDependency[];
}

export function readChartMeta(chartDir: string): ChartMeta {
  const raw = readYamlFile(join(chartDir, "Chart.yaml")) as
    | { name?: unknown; dependencies?: unknown }
    | undefined;
  const deps: ChartDependency[] = [];
  if (Array.isArray(raw?.dependencies)) {
    for (const d of raw.dependencies) {
      if (d === null || typeof d !== "object") continue;
      const dep = d as Record<string, unknown>;
      if (typeof dep.name !== "string") continue;
      deps.push({
        name: dep.name,
        alias: typeof dep.alias === "string" ? dep.alias : undefined,
        condition: typeof dep.condition === "string" ? dep.condition : undefined,
      });
    }
  }
  return {
    name: typeof raw?.name === "string" ? raw.name : "",
    dependencies: deps,
  };
}

export function readYamlFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  return yaml.load(readFileSync(path, "utf8"));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Helm-style deep merge: `override` wins, maps merge recursively, a `null`
 * override deletes the key, arrays replace wholesale.
 */
export function mergeValues(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === null) {
      delete out[k];
      continue;
    }
    out[k] = k in out ? mergeValues(out[k], v) : v;
  }
  return out;
}

/** Resolve a dot path against a values tree; undefined when absent. */
export function valueAtPath(values: unknown, path: string[]): unknown {
  let v = values;
  for (const seg of path) {
    if (!isPlainObject(v)) return undefined;
    v = v[seg];
  }
  return v;
}

/**
 * One chart in the tree, with the values IT sees. An aliased dependency
 * yields two instances over the same directory — each with its own value
 * scope, which is why findings are evaluated per instance but reported per
 * file.
 */
export interface ChartInstance {
  /** Directory of the (sub)chart. */
  dir: string;
  /** Directory relative to the root chart ("" for the root). */
  relDir: string;
  /** Values scope from the root, e.g. ["grafana"] or ["kidtwo"]; [] for root. */
  scope: string[];
  /** Effective values as this instance sees them. */
  values: unknown;
  /**
   * When a `condition:` on the dependency chain disables this instance under
   * the supplied values: the first condition path that resolved false, in
   * root coordinates. Constructs inside a disabled instance are gated by it.
   */
  disabledBy?: string;
}

/**
 * Build the instance tree for a chart directory and the values the render
 * was given. `suppliedValues` merges over the root chart's `values.yaml`
 * exactly like `helm template --values`.
 */
export function buildChartInstances(
  chartDir: string,
  suppliedValues?: unknown,
): { instances: ChartInstance[]; warnings: string[] } {
  const warnings: string[] = [];
  const rootDefaults = readYamlFile(join(chartDir, "values.yaml")) ?? {};
  const rootValues = mergeValues(rootDefaults, suppliedValues);
  const instances: ChartInstance[] = [];

  const visit = (
    dir: string,
    relDir: string,
    scope: string[],
    values: unknown,
    disabledBy: string | undefined,
  ): void => {
    instances.push({ dir, relDir, scope, values, disabledBy });
    const meta = readChartMeta(dir);
    const chartsDir = join(dir, "charts");
    const childDirs = existsSync(chartsDir)
      ? readdirSync(chartsDir).filter((e) => {
          const p = join(chartsDir, e);
          return statSync(p).isDirectory() && existsSync(join(p, "Chart.yaml"));
        })
      : [];
    const declared = new Set<string>();

    const visitChild = (dep: ChartDependency): void => {
      const key = dep.alias ?? dep.name;
      const childDir = join(chartsDir, dep.name);
      if (!existsSync(join(childDir, "Chart.yaml"))) {
        warnings.push(
          `dependency ${dep.name} of ${relDir === "" ? "the chart" : relDir} is not vendored under charts/ — not scanned`,
        );
        return;
      }
      declared.add(dep.name);
      // Condition paths are resolved against the TOP parent's values
      // (helm's documented semantics); first present path wins, absent
      // conditions leave the dependency enabled.
      let childDisabledBy = disabledBy;
      if (childDisabledBy === undefined && dep.condition !== undefined) {
        for (const rawPath of dep.condition.split(",")) {
          const path = rawPath.trim();
          if (path === "") continue;
          const v = valueAtPath(rootValues, path.split("."));
          if (v === undefined) continue;
          if (v === false) childDisabledBy = path;
          break;
        }
      }
      const childDefaults = readYamlFile(join(childDir, "values.yaml")) ?? {};
      const parentSlice = isPlainObject(values) ? values[key] : undefined;
      let childValues = mergeValues(childDefaults, parentSlice);
      // Globals propagate into every subchart tree.
      const parentGlobal = isPlainObject(values) ? values.global : undefined;
      if (parentGlobal !== undefined && isPlainObject(childValues)) {
        childValues = {
          ...childValues,
          global: mergeValues(childValues.global, parentGlobal),
        };
      }
      visit(
        childDir,
        relDir === "" ? `charts/${dep.name}` : `${relDir}/charts/${dep.name}`,
        [...scope, key],
        childValues,
        childDisabledBy,
      );
    };

    for (const dep of meta.dependencies) visitChild(dep);
    // charts/ directories not declared in Chart.yaml are implicit,
    // always-enabled dependencies.
    for (const name of childDirs) {
      if (!declared.has(name)) visitChild({ name });
    }
  };

  visit(chartDir, "", [], rootValues, undefined);
  return { instances, warnings };
}
