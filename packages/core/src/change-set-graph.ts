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
 * does. An entry whose address the graph does not hold gets `node: null`:
 * a delete of a block the source no longer declares, or a warden or sql
 * change outside the graph.
 *
 * Like `./change-set.ts`, this imports nothing at run time, so it bundles
 * into one file with the change-set code.
 */

import type { ChangeSetDocument, ChangeSetEntry } from "./change-set";

/** The graph a document is mapped onto: the node ids of one member's own IR. */
export interface ChangeSetGraphNodes {
  /** The workspace member whose graph it is, its path of names joined with `/` when nested, or null outside a workspace. */
  member: string | null;
  /** The commit the graph was read at, or null when unknown. */
  at: string | null;
  /** Every node id of the member's `chant graph --format ir`, without the member in front. */
  ids: Iterable<string>;
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

/**
 * The document with each entry's `node` set from `graph`, and `graph`
 * recording which graph it was. A null `graph` (none could be read) gives
 * every entry `node: null`. The digest is unchanged: `node` is not hashed.
 */
export function mapChangeSetToGraph(doc: ChangeSetDocument, graph: ChangeSetGraphNodes | null): ChangeSetDocument {
  if (graph === null) {
    return { ...doc, entries: doc.entries.map((e) => ({ ...e, node: null })), graph: null };
  }
  const ids = new Set(graph.ids);
  const prefix = graph.member ? `${graph.member}/` : "";
  return {
    ...doc,
    entries: doc.entries.map((e) => {
      const id = changeSetNodeCandidates(e).find((c) => ids.has(c));
      return { ...e, node: id === undefined ? null : `${prefix}${id}` };
    }),
    graph: { member: graph.member, at: graph.at },
  };
}
