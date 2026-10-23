import type { GraphIR, IRNode } from "../../graph-ir";

/**
 * `chant search --count-by <kind|module|attr:<name>>` (#4360): grouped counts
 * over the matched set, one line per group, instead of one row per match.
 *
 * An agent asking "how many resources of each type does each module own" used
 * to run one search per value, or read every row and count them itself. The
 * second is the token cost `search` exists to avoid.
 *
 * Every matched node lands in exactly one group. A node with no value for the
 * grouped dimension is counted under `(none)`, never dropped, so the groups
 * always add up to the total line.
 */
export type CountBy = { by: "kind" } | { by: "module" } | { by: "attr"; name: string };

/** The group a node with no value for the grouped dimension is counted under. */
export const NONE_GROUP = "(none)";
/** The module group of a Terraform block declared in the root module itself. */
export const ROOT_MODULE_GROUP = "(root)";

/** Parse a `--count-by` value, or say what the accepted spellings are. */
export function parseCountBy(raw: string): CountBy | { error: string; hint: string } {
  const value = raw.trim();
  if (value === "kind") return { by: "kind" };
  if (value === "module") return { by: "module" };
  const attr = /^attr:(.+)$/.exec(value);
  if (attr && attr[1].trim()) return { by: "attr", name: attr[1].trim() };
  return {
    error: `--count-by "${raw}" is not a grouping`,
    hint: "group by one of: --count-by kind, --count-by module, --count-by attr:<name>",
  };
}

/**
 * The Terraform type of a block, read from its address: `aws_instance` for
 * `aws_instance.web`, `data.aws_ami` for `data.aws_ami.ubuntu`. Undefined for
 * anything that is not a Terraform resource or data block.
 *
 * Every Terraform resource is `Terraform::Resource` in chant's IR, so grouping
 * a Terraform root by that kind puts the whole estate in one group. The
 * resource type is what `terraform state list` and the provider docs call the
 * type, so that is what `--count-by kind` groups by. A data source keeps its
 * `data.` prefix: `data.aws_ami` reads an AMI, it does not manage one.
 */
export function terraformType(n: IRNode): string | undefined {
  if (n.lexicon !== "terraform") return undefined;
  if (n.kind !== "Terraform::Resource" && n.kind !== "Terraform::Data") return undefined;
  const address = terraformAddress(n);
  const parts = address.split(".");
  if (n.kind === "Terraform::Data") return parts[0] === "data" && parts[1] ? `data.${parts[1]}` : undefined;
  return parts[0] || undefined;
}

/** A Terraform node's own address (`aws_s3_bucket.assets`), from its attrs or, failing that, its id. */
function terraformAddress(n: IRNode): string {
  const attrs = (n.attrs ?? {}) as Record<string, unknown>;
  if (typeof attrs.address === "string") return attrs.address;
  return n.id.slice(n.id.lastIndexOf("/") + 1).replace(/~\d+$/, "");
}

/** A Terraform node's root name, from its attrs or the first segment of its id. */
function terraformRoot(n: IRNode): string {
  const attrs = (n.attrs ?? {}) as Record<string, unknown>;
  if (typeof attrs.root === "string") return attrs.root;
  const slash = n.id.indexOf("/");
  return slash === -1 ? "" : n.id.slice(0, slash);
}

/**
 * The module a Terraform node sits in: its call chain as Terraform writes it
 * (`module.cdn`, `module.cdn.module.bucket`), or `(root)` for a block of the
 * root module itself. The chain is on `attrs.callers`; an entity key
 * `<root>/module.cdn/<address>` carries the same chain when it is absent.
 */
function terraformModule(n: IRNode): string {
  const attrs = (n.attrs ?? {}) as Record<string, unknown>;
  const callers = Array.isArray(attrs.callers)
    ? attrs.callers.filter((c): c is string => typeof c === "string")
    : n.id.split("/").slice(1, -1);
  return callers.length === 0 ? ROOT_MODULE_GROUP : callers.join(".");
}

/** An attribute's value as a group name, matched by exact name and then case-insensitively, as `--show` does. */
function attrGroup(n: IRNode, name: string): string {
  const attrs = (n.attrs ?? {}) as Record<string, unknown>;
  const key = name in attrs ? name : Object.keys(attrs).find((k) => k.toLowerCase() === name.toLowerCase());
  const v = key === undefined ? undefined : attrs[key];
  if (v === undefined || v === null || v === "") return NONE_GROUP;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/**
 * The group one node belongs to.
 *
 * `module` on a Terraform node is its call chain. When the graph holds more
 * than one Terraform root, the chain is prefixed with the root (`app/(root)`,
 * `net/module.vpc`): `module.vpc` in two roots is two modules, applied
 * separately, and counting them as one would add up resources that never sit
 * in the same state. A node of another lexicon groups under the composite that
 * expanded it, chant's own unit of reuse, or `(none)`.
 */
export function groupOf(n: IRNode, countBy: CountBy, multiRoot = false): string {
  if (countBy.by === "kind") return terraformType(n) ?? (n.kind || NONE_GROUP);
  if (countBy.by === "attr") return attrGroup(n, countBy.name);
  if (n.lexicon === "terraform") {
    const module = terraformModule(n);
    return multiRoot ? `${terraformRoot(n) || NONE_GROUP}/${module}` : module;
  }
  return n.compositeParent || NONE_GROUP;
}

/** Whether the graph holds blocks from more than one Terraform root. */
export function hasManyTerraformRoots(ir: GraphIR): boolean {
  const roots = new Set<string>();
  for (const n of ir.nodes) if (n.lexicon === "terraform") roots.add(terraformRoot(n));
  return roots.size > 1;
}

/** Count `matches` per group, sorted by count (highest first) and then by name. */
export function countGroups(matches: IRNode[], countBy: CountBy, multiRoot = false): Array<{ group: string; count: number }> {
  const counts = new Map<string, number>();
  for (const n of matches) {
    const g = groupOf(n, countBy, multiRoot);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts]
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => b.count - a.count || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
}

/** The label a `--count-by` value is printed with on the total line. */
function countByLabel(countBy: CountBy): string {
  return countBy.by === "attr" ? `attr:${countBy.name}` : countBy.by;
}

/**
 * Render grouped counts: one `<count>  <group>` line per group, counts right
 * aligned, then the total. The total is the number of matches, which is the
 * sum of the group counts by construction.
 */
export function formatCounts(groups: Array<{ group: string; count: number }>, countBy: CountBy): string[] {
  const total = groups.reduce((sum, g) => sum + g.count, 0);
  const width = String(groups[0]?.count ?? 0).length;
  const lines = groups.map((g) => `${String(g.count).padStart(width)}  ${g.group}`);
  lines.push(`— ${total} total · ${groups.length} group${groups.length === 1 ? "" : "s"} by ${countByLabel(countBy)}`);
  return lines;
}
