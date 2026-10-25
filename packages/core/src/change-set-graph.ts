/**
 * Place a change set's entries on the graph (#4022).
 *
 * A reader such as behold draws the graph `chant graph --format ir` and
 * `chant workspace graph` print, and wants each change of a change set on the
 * node it changes. The planner's address is not that node's id: a terraform
 * plan names an instance, `module.app.terraform_data.instance[0]`, where the
 * graph has one node per block, `<root>/module.app/terraform_data.instance`
 * (the terraform lexicon's entity key, `hcl/parse.ts`). So chant maps the
 * address itself, against the node ids of the graph it read, and a reader
 * never derives an id.
 *
 * {@link changeSetNodeCandidates} lists the ids an entry's address can have,
 * by planner. {@link mapChangeSetToGraph} keeps the first that the graph
 * holds and puts the member's name in front, as `chant workspace graph`
 * does, with the node's source file as `source` when the graph gives one
 * (#4025). An entry whose address the graph does not hold gets `node: null`:
 * a delete of a block the source no longer declares, or a warden or sql
 * change outside the graph.
 *
 * An instance of a `count` or `for_each` block gets its instance node
 * (#4454): the block node's id followed by the instance key as the planner
 * prints it, `<root>/module.app/terraform_data.instance[0]`, with
 * `instanceOf` naming the block node. That holds whether or not the graph
 * lists the instance node, since a graph read of the source lists only the
 * instances a literal `count` or `for_each` gives (`./instance-nodes.ts`).
 * {@link graphNodeFor} is the same rule for a single address, which a drift
 * row uses.
 *
 * Like `./change-set.ts`, this imports nothing at run time but
 * `./instance-nodes.ts`, which imports nothing either, so it bundles into
 * one file with the change-set code.
 */

import type { ChangeSetDocument, ChangeSetEntry } from "./change-set";
import { instanceNodeId, terraformInstanceKey } from "./instance-nodes";

/** The graph a document is mapped onto: the node ids of one member's own IR. */
export interface ChangeSetGraphNodes {
  /** The workspace member whose graph it is, its path of names joined with `/` when nested, or null outside a workspace. */
  member: string | null;
  /** The commit the graph was read at, or null when unknown. */
  at: string | null;
  /** Every node id of the member's `chant graph --format ir`, without the member in front. */
  ids: Iterable<string>;
  /**
   * The source file of each node that has one (#4025), by the same ids, as a
   * path from the repository root. An entry mapped onto such a node gets it
   * as `source`.
   */
  sources?: ReadonlyMap<string, string>;
}

/**
 * Split a terraform address into its dot-separated parts, dropping every
 * `[...]` index. A quoted key may hold `.` or `]`, so quotes are honoured.
 */
function terraformParts(address: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < address.length; i++) {
    const c = address[i];
    if (depth > 0) {
      if (quoted) {
        if (c === "\\") i++;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "]") depth--;
      continue;
    }
    if (c === "[") depth++;
    else if (c === ".") {
      parts.push(current);
      current = "";
    } else current += c;
  }
  parts.push(current);
  return parts.filter((p) => p.length > 0);
}

/**
 * The block key the terraform lexicon gives an address in its root:
 * `module.<call>/` for each module call, then the block's own address with
 * no index. `module.app.terraform_data.instance[0]` is
 * `module.app/terraform_data.instance`.
 */
export function terraformBlockKey(address: string): string | undefined {
  const parts = terraformParts(address);
  const scope: string[] = [];
  let i = 0;
  while (parts[i] === "module" && i + 1 < parts.length) {
    scope.push(`module.${parts[i + 1]}`);
    i += 2;
  }
  const rest = parts.slice(i);
  let block: string | undefined;
  if (rest[0] === "data" && rest.length >= 3) block = `data.${rest[1]}.${rest[2]}`;
  else if (rest.length >= 2) block = `${rest[0]}.${rest[1]}`;
  else if (rest.length === 0 && scope.length > 0) {
    // The module call itself is a block of its caller.
    const call = scope.pop()!;
    block = call;
  }
  if (block === undefined) return undefined;
  return [...scope, block].join("/");
}

/**
 * The ids, in the order tried, that an entry's address can have in its
 * member's graph IR:
 *
 * - `chant`: the address, which is the entity name the IR uses as its id.
 * - `terraform`, `tofu`, `choudoufu`: `<root>/<block key>`, the root being
 *   the change-set member (`terraformBlockKey`), then the address.
 * - `warden`, `sql`: the address.
 */
export function changeSetNodeCandidates(entry: Pick<ChangeSetEntry, "member" | "planner" | "address">): string[] {
  switch (entry.planner) {
    case "terraform":
    case "tofu":
    case "choudoufu": {
      const key = terraformBlockKey(entry.address);
      return key === undefined ? [entry.address] : [`${entry.member}/${key}`, entry.address];
    }
    default:
      return [entry.address];
  }
}

/** Where one address sits on a graph: its node, and the block node when that node is an instance's. */
export interface GraphNodePlacement {
  /** The node id, with the member in front inside a workspace, or null when the graph holds none for the address. */
  node: string | null;
  /** The block node's id, set when `node` is an instance node (#4454). */
  instanceOf?: string;
  /** The source file of the node, or of its block node for an instance, from the graph's `sources`. */
  source?: string;
}

/**
 * The node an address of a member's planner is on, in `ids` (one member's
 * node ids, without the member) with `prefix` in front: the first candidate
 * ({@link changeSetNodeCandidates}) the graph holds, and for an instance of a
 * terraform-family block that the graph holds, the instance node (#4454).
 */
function placeOn(
  entry: Pick<ChangeSetEntry, "member" | "planner" | "address">,
  ids: ReadonlySet<string>,
  prefix: string,
  sources: ReadonlyMap<string, string> | undefined,
): GraphNodePlacement {
  const id = changeSetNodeCandidates(entry).find((c) => ids.has(c));
  if (id === undefined) return { node: null };

  const key =
    (entry.planner === "terraform" || entry.planner === "tofu" || entry.planner === "choudoufu") && id !== entry.address
      ? terraformInstanceKey(entry.address)
      : undefined;
  if (key === undefined) {
    const source = sources?.get(id);
    return { node: `${prefix}${id}`, ...(source !== undefined ? { source } : {}) };
  }
  const instance = instanceNodeId(id, key);
  const source = sources?.get(instance) ?? sources?.get(id);
  return { node: `${prefix}${instance}`, instanceOf: `${prefix}${id}`, ...(source !== undefined ? { source } : {}) };
}

/**
 * The node one engine address is on in `graph`, by the change set's mapping
 * rules: what a drift row's `node` and `instanceOf` are (#4454), so a drift
 * row and a change-set entry for the same instance name the same node. A null
 * `graph` places nothing.
 */
export function graphNodeFor(
  entry: Pick<ChangeSetEntry, "member" | "planner" | "address">,
  graph: ChangeSetGraphNodes | null,
): GraphNodePlacement {
  if (graph === null) return { node: null };
  return placeOn(entry, new Set(graph.ids), graph.member ? `${graph.member}/` : "", graph.sources);
}

/**
 * The document with each entry's `node` set from `graph`, and `graph`
 * recording which graph it was. A null `graph` (none could be read) gives
 * every entry `node: null`. The digest is unchanged: `node`, `instanceOf` and
 * `source` are not hashed.
 */
export function mapChangeSetToGraph(doc: ChangeSetDocument, graph: ChangeSetGraphNodes | null): ChangeSetDocument {
  if (graph === null) {
    return { ...doc, entries: doc.entries.map(({ instanceOf: _i, ...e }) => ({ ...e, node: null })), graph: null };
  }
  const ids = new Set(graph.ids);
  const prefix = graph.member ? `${graph.member}/` : "";
  return {
    ...doc,
    entries: doc.entries.map(({ instanceOf: _i, ...e }) => ({ ...e, ...placeOn(e, ids, prefix, graph.sources) })),
    graph: { member: graph.member, at: graph.at },
  };
}
