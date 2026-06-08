import { resolve } from "path";
import { discover } from "../../discovery/index";
import type { Declarable } from "../../declarable";
import { formatSuccess, formatBold } from "../format";

/**
 * `chant describe <component>` — project the effective, fully-resolved
 * configuration for one named component, offline (source only; no live calls).
 *
 * `chant list` shows inventory and `chant graph` shows edges; neither shows the
 * resolved property bag for a single thing. `describe` does: for a layered
 * config (see the layered-config guide) it answers "what is the effective config
 * for this component, after every spread/override?" without merging the layers
 * by hand.
 */
export interface DescribeOptions {
  /** The component to describe — a named export (declarable or composite instance). */
  component: string;
  /** Path to the infrastructure directory. */
  path: string;
  /** Output format. */
  format: "text" | "json";
}

/** One resolved resource produced by the component. */
export interface DescribedResource {
  name: string;
  lexicon: string;
  entityType: string;
  kind: string;
  /** The resolved (post-merge, post-composite-expansion) property bag. */
  props: unknown;
}

export interface DescribeResult {
  success: boolean;
  component: string;
  /** True when the component is a composite instance (≥1 produced resource by prefix). */
  composite: boolean;
  resources: DescribedResource[];
  output: string;
}

/** Read a discovered entity's resolved props (same accessor the build pipeline uses). */
function readProps(entity: Declarable): unknown {
  return "props" in entity ? (entity as { props: unknown }).props : undefined;
}

/**
 * Find the entities a component name refers to. A composite instance is
 * flattened at discovery: `WebApp(x)` exported as `foo` becomes `fooDeployment`,
 * `fooService`, … — so an exact-name miss falls back to grouping entities whose
 * name is the export prefix followed by a capitalized result key.
 */
function matchComponent(
  entities: Map<string, Declarable>,
  component: string,
): { matched: Array<[string, Declarable]>; composite: boolean } {
  const exact = entities.get(component);
  if (exact) return { matched: [[component, exact]], composite: false };

  const grouped = [...entities].filter(
    ([n]) =>
      n.length > component.length &&
      n.startsWith(component) &&
      n.charAt(component.length) === n.charAt(component.length).toUpperCase() &&
      n.charAt(component.length) !== n.charAt(component.length).toLowerCase(),
  );
  grouped.sort((a, b) => a[0].localeCompare(b[0]));
  return { matched: grouped, composite: grouped.length > 0 };
}

export async function describeCommand(options: DescribeOptions): Promise<DescribeResult> {
  const infraPath = resolve(options.path);
  const result = await discover(infraPath);

  if (result.errors.length > 0) {
    return {
      success: false,
      component: options.component,
      composite: false,
      resources: [],
      output: result.errors.map((e) => e.message).join("\n"),
    };
  }

  const { matched, composite } = matchComponent(result.entities, options.component);

  if (matched.length === 0) {
    const known = [...result.entities.keys()].sort().join(", ");
    return {
      success: false,
      component: options.component,
      composite: false,
      resources: [],
      output: `No component "${options.component}" found.\nKnown components: ${known || "(none)"}`,
    };
  }

  const resources: DescribedResource[] = matched.map(([name, decl]) => ({
    name,
    lexicon: decl.lexicon ?? "",
    entityType: decl.entityType ?? "",
    kind: decl.kind ?? "resource",
    props: readProps(decl),
  }));

  const output =
    options.format === "json"
      ? JSON.stringify({ component: options.component, composite, resources }, null, 2)
      : formatText(options.component, composite, resources);

  return { success: true, component: options.component, composite, resources, output };
}

/** Human-readable effective-config view. */
function formatText(component: string, composite: boolean, resources: DescribedResource[]): string {
  const lines: string[] = [];
  const header = composite
    ? `${formatBold(component)} — composite instance, ${resources.length} resource(s)`
    : `${formatBold(component)}`;
  lines.push(header);
  for (const r of resources) {
    lines.push("");
    lines.push(`  ${formatBold(r.name)}  (${r.entityType})`);
    const propsJson = JSON.stringify(r.props ?? {}, null, 2)
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n");
    lines.push(propsJson);
  }
  return lines.join("\n");
}

/** Print a describe result to the console. */
export function printDescribeResult(result: DescribeResult): void {
  if (result.output) console.log(result.output);
  if (result.success) {
    console.error(formatSuccess(`Described ${formatBold(result.component)}`));
  }
}
