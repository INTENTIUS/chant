/**
 * CLI-facing helpers over component discovery (#560, epic #551) — kept
 * separate from ../cli/commands/{list,describe}.ts and
 * ../cli/handlers/graph.ts so those files stay thin dispatchers and the
 * component-specific report shaping lives alongside the rest of the
 * component subsystem, the same way ../op/discover.ts's results are shaped
 * inline by its own CLI callers rather than a `cli` folder inside `op/`.
 *
 * Surfaces components in the three places the issue asks for:
 *  - `chant list --components` — inventory (mirrors `ListEntity`/`listCommand`).
 *  - `chant describe <name> --components` — one component's full JSON contract
 *    projection (mirrors `describeCommand`'s effective-config view).
 *  - `chant graph --components` — dependency order/waves from `dependsOn`
 *    (mirrors `computeStackGraph`/`runStackGraph`, but reuses
 *    `resolveComponentGraph` from ../driver.ts since a component's `dependsOn`
 *    is already a flat name list — no AttrRef-style inference needed).
 */

import { discoverComponents } from "./discover";
import { projectToJson, type Archetype } from "./component";
import { resolveComponentGraph, UnknownDependencyError, DependencyCycleError } from "./driver";
import type { DriverComponent } from "./driver";

/** One component in `chant list --components` output. */
export interface ListedComponent {
  name: string;
  archetype: Archetype;
  dependsOn: string[];
  hasBuild: boolean;
  phases: string[];
  filePath: string;
}

export interface ListComponentsResult {
  success: boolean;
  components: ListedComponent[];
  errors: string[];
}

/** Discover components under `path` and shape them for `chant list --components`. */
export async function listComponents(path: string): Promise<ListComponentsResult> {
  const result = await discoverComponents(path);
  if (result.errors.length > 0) {
    return { success: false, components: [], errors: result.errors.map((e) => e.message) };
  }

  const components: ListedComponent[] = [...result.components.values()]
    .map(({ component, filePath }) => {
      const projected = projectToJson(component) as { archetype: Archetype };
      return {
        name: component.name,
        archetype: projected.archetype,
        dependsOn: component.dependsOn,
        hasBuild: component.build !== undefined,
        phases: component.deploy.map((p) => p.phase),
        filePath,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { success: true, components, errors: [] };
}

/** One component's full JSON contract projection, for `chant describe <name> --components`. */
export interface DescribedComponent {
  name: string;
  filePath: string;
  /** The component's JSON contract projection (validates against component.schema.json). */
  json: unknown;
}

export interface DescribeComponentResult {
  success: boolean;
  component: string;
  described?: DescribedComponent;
  output: string;
}

/** Find and project one named component, for `chant describe <name> --components`. */
export async function describeComponent(path: string, name: string): Promise<DescribeComponentResult> {
  const result = await discoverComponents(path);
  if (result.errors.length > 0) {
    return { success: false, component: name, output: result.errors.map((e) => e.message).join("\n") };
  }

  const found = result.components.get(name);
  if (!found) {
    const known = [...result.components.keys()].sort().join(", ");
    return {
      success: false,
      component: name,
      output: `No component "${name}" found.\nKnown components: ${known || "(none)"}`,
    };
  }

  const json = projectToJson(found.component);
  return {
    success: true,
    component: name,
    described: { name, filePath: found.filePath, json },
    output: "",
  };
}

/** Dependency order/waves for `chant graph --components`, from every discovered component's `dependsOn`. */
export interface ComponentGraphResult {
  success: boolean;
  order: string[];
  waves: string[][];
  edges: Array<{ from: string; to: string }>;
  error?: string;
}

/** Compute the components' dependency graph under `path`, for `chant graph --components`. */
export async function computeComponentGraph(path: string): Promise<ComponentGraphResult> {
  const result = await discoverComponents(path);
  if (result.errors.length > 0) {
    return { success: false, order: [], waves: [], edges: [], error: result.errors.map((e) => e.message).join("\n") };
  }

  const driverComponents: DriverComponent[] = [...result.components.values()].map(({ component }) => ({
    name: component.name,
    dependsOn: component.dependsOn,
    deploy: component.deploy,
  }));

  try {
    const { order, waves } = resolveComponentGraph(driverComponents);
    const edges: Array<{ from: string; to: string }> = [];
    for (const c of driverComponents) {
      for (const dep of c.dependsOn ?? []) edges.push({ from: c.name, to: dep });
    }
    return { success: true, order, waves, edges };
  } catch (err) {
    if (err instanceof UnknownDependencyError || err instanceof DependencyCycleError) {
      return { success: false, order: [], waves: [], edges: [], error: err.message };
    }
    throw err;
  }
}
