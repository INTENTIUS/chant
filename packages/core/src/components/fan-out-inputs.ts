/**
 * What each component of a fan-out would apply, as one digest per component
 * (#4081), and which of an earlier attempt's progress still holds against it.
 *
 * A fan-out's plan digest identifies the derivation: who runs, in what order,
 * off which edges. Two different changes that touch the same components in
 * the same shape derive the same plan, so the plan digest alone cannot say
 * whether "cluster-a already applied" is about the change in front of us.
 * The attempt record therefore keeps, for each component it applied, the
 * input digest computed here, and a resumed attempt carries a component as
 * `already-applied` only when that digest is the one the component has now.
 *
 * ## What a component's input digest covers
 *
 * - The environment. Progress against `local` says nothing about `prod`.
 * - The composition: every phase and step as authored, `rollback` included.
 *   A `stackOutput` reference is hashed as the reference, not its value.
 * - The bytes of every file a step input names. A string input that resolves,
 *   relative to the project root, to a file or directory inside the root is
 *   read and hashed, so `template: "dist/cluster-a.template.json"` covers the
 *   built template and a rebuild that changes it changes the digest. A
 *   directory is hashed by its files, skipping `.git`, `node_modules` and
 *   `.chant`, the last because the attempt record itself lives there.
 * - The input digests of the components it depends on. A parameter filled
 *   from an upstream output gets its value from that upstream's apply, so a
 *   change upstream changes the digest of everything downstream of it, the
 *   same reach the fan-out's own walk has.
 *
 * Nothing decided during the run goes in: no run id, no time, no output an
 * apply produced.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { computePlanDigest } from "../lifecycle/plan-digest";
import { sha256Hex } from "../content-digest";
import type { DriverComponent, DriverPhase } from "./driver";

export interface ComponentInputOptions {
  /** The root step inputs' file paths are read relative to, the project the fan-out runs in. */
  projectRoot: string;
  /** The environment the fan-out applies to. */
  env: string;
  /** Environment config resolved ahead of the run, when the caller has any. */
  vars?: Record<string, unknown>;
}

const SKIPPED_DIRS = new Set([".git", "node_modules", ".chant"]);

/** Inside `root`, and not `root` itself: a bare "." names the whole project, which is no one step's input. */
function insideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Hash a file, or a directory by the relative path and bytes of each file under it. */
function hashPath(path: string): string | undefined {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return undefined;
  }
  if (stat.isFile()) return `sha256:${sha256Hex(readFileSync(path))}`;
  if (!stat.isDirectory()) return undefined;
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files[relative(path, full).split(sep).join("/")] = sha256Hex(readFileSync(full));
    }
  };
  walk(path);
  return computePlanDigest("component-input-dir", files);
}

/** Every file or directory a component's steps name, keyed by the string the step wrote. */
function referencedFiles(component: DriverComponent, root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value === "" || value.includes("\n") || value in out) return;
      const path = resolve(root, value);
      if (!insideRoot(root, path) || !existsSync(path)) return;
      const digest = hashPath(path);
      if (digest !== undefined) out[value] = digest;
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  // Only a step's inputs name files. A phase name or a step's `kind` that
  // happens to match a directory in the project is not one.
  const visitPhases = (phases: DriverPhase[] | undefined): void => {
    for (const phase of phases ?? []) {
      for (const step of phase.steps) {
        if (isPhase(step)) {
          visitPhases([step]);
          continue;
        }
        if (step.kind === "gate") continue;
        const { kind: _kind, ...inputs } = step;
        visit(inputs);
      }
      visitPhases(phase.onFailure);
    }
  };
  visitPhases(component.deploy);
  visitPhases(component.rollback);
  return out;
}

function isPhase(step: DriverPhase["steps"][number]): step is DriverPhase {
  return typeof (step as { phase?: unknown }).phase === "string" && Array.isArray((step as DriverPhase).steps);
}

/**
 * One input digest per component in `components`, keyed by name. Each folds
 * in the digests of the components it depends on, so `components` should be
 * the whole project: a dependency it does not contain is hashed by name only.
 */
export function componentInputDigests(
  components: DriverComponent[],
  options: ComponentInputOptions,
): Record<string, string> {
  const root = resolve(options.projectRoot);
  const byName = new Map(components.map((c) => [c.name, c]));
  const digests = new Map<string, string>();
  const visiting = new Set<string>();

  const digestOf = (name: string): string | null => {
    const known = digests.get(name);
    if (known !== undefined) return known;
    const component = byName.get(name);
    // An unknown dependency or a cycle is refused by the fan-out's derivation
    // before this runs; here it only has to not loop.
    if (!component || visiting.has(name)) return null;
    visiting.add(name);
    const upstream = [...(component.dependsOn ?? [])].sort().map((dep) => ({ component: dep, digest: digestOf(dep) }));
    visiting.delete(name);
    const digest = computePlanDigest("component-input", {
      environment: options.env,
      component: name,
      deploy: component.deploy,
      rollback: component.rollback ?? null,
      vars: options.vars ?? null,
      files: referencedFiles(component, root),
      upstream,
    });
    digests.set(name, digest);
    return digest;
  };

  for (const c of components) digestOf(c.name);
  return Object.fromEntries([...digests.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** What of an earlier attempt's progress holds against the inputs the components have now. */
export interface CarriedProgress {
  /** Components the attempt applied whose input is the same now. These stay `already-applied`. */
  carried: string[];
  /** Components the attempt applied whose input moved since. These run again. */
  changed: string[];
  /**
   * True when the record has no input digests at all, as one written before
   * #4081 has. Nothing carries from such a record, since nothing in it says
   * what was applied.
   */
  unrecorded: boolean;
}

/**
 * Split an attempt's `completed` by whether each component's input is the
 * same as now. A component the record holds no digest for counts as changed:
 * a claim that it applied is only worth keeping for the input it applied.
 */
export function progressThatCarries(
  attempt: { completed: string[]; inputs?: Record<string, string> },
  now: Record<string, string>,
): CarriedProgress {
  const recorded = attempt.inputs;
  const carried: string[] = [];
  const changed: string[] = [];
  for (const name of [...attempt.completed].sort()) {
    const then = recorded?.[name];
    if (then !== undefined && now[name] !== undefined && then === now[name]) carried.push(name);
    else changed.push(name);
  }
  return { carried, changed, unrecorded: recorded === undefined };
}
