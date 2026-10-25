/**
 * Instance nodes (#4454): one graph node per `count` or `for_each` instance,
 * under the node of the block that declares it.
 *
 * A lexicon whose entity is a block that expands into instances (terraform's
 * `aws_eip.pool`, applied as `aws_eip.pool[0]`, `aws_eip.pool[1]`, ...) has
 * one graph node per block. A plan, a state read and a drift read all speak
 * per instance. This module is the contract that puts both on the graph:
 *
 * - An instance's node id is its block's node id followed by the instance key
 *   exactly as Terraform prints it: `<blockNode>[0]`, `<blockNode>["a"]`.
 *   Inside a workspace the member goes in front as for any node, so
 *   `<member>/<blockNode>[0]`.
 * - The block node keeps existing and is the rollup: its verdict is the
 *   aggregate of its instances' ({@link rollupInstances}).
 * - In the graph IR an instance node is a child of its block node. It carries
 *   `instanceOf`, the block node's id, and `instanceKey`, the key on its own
 *   (`IRNode` in `./graph-ir.ts`). It has no edges and no attrs of its own:
 *   both stay on the block, since a reference in the source is block to block.
 * - A change-set entry and a drift row for an instance carry the instance
 *   node's id as `node`, and the block node's id as `instanceOf`.
 *
 * The graph lists the instances a read of the source can count: a literal
 * `count` or a literal `for_each`. An expansion that only a plan can count
 * (`count = var.n`) has no instance nodes in the declared graph, and an entry
 * for one of its instances still names the instance id by the rule above,
 * with `instanceOf` saying which block node to hang it under.
 *
 * An address under a module call that is itself expanded
 * (`module.app[0].aws_eip.pool[1]`) has no instance node: the block node id
 * has no place for the module's key, so it rolls up to the block.
 *
 * Imports nothing at run time, so it bundles with `./change-set.ts`.
 */

/** A `[...]` instance key, a number or a quoted string with escapes. */
const KEY = /\[(?:"(?:[^"\\]|\\.)*"|\d+)\]/;
const TRAILING_KEY = new RegExp(`(${KEY.source})$`);

/** An instance key as Terraform prints it: `[0]` for a `count` index, `["a"]` for a `for_each` key. */
export function instanceKeyLiteral(key: string | number): string {
  return typeof key === "number" ? `[${key}]` : `[${JSON.stringify(key)}]`;
}

/** The instance node id for a block node id and an instance key as Terraform prints it. */
export function instanceNodeId(blockNode: string, key: string): string {
  return `${blockNode}${key}`;
}

/**
 * The instance key a terraform-family address ends with, as printed
 * (`[0]`, `["a"]`), or undefined when it has none or when a module call on
 * the way to it is expanded, which rolls up to the block (see the module doc).
 */
export function terraformInstanceKey(address: string): string | undefined {
  const m = TRAILING_KEY.exec(address);
  if (!m) return undefined;
  const head = address.slice(0, m.index);
  if (head.includes("[")) return undefined;
  return m[1];
}

/**
 * One instance's observed verdict, carried on its block's
 * `ResourceMetadata.instances` (`./lexicon.ts`) so the live graph can draw the
 * instance node and paint it on its own.
 */
export interface InstanceObservation {
  /** The instance key as Terraform prints it, `[0]` or `["a"]`. */
  key: string;
  /** The engine's own instance address, `aws_eip.pool[0]`. */
  address: string;
  verdict: "present" | "absent" | "not-observed";
  /** The provider's id, on a present instance, when the read gave one. */
  physicalId?: string;
  /** Same meaning as `ResourceMetadata.ownership`, on a present instance. */
  ownership?: "owned" | "foreign" | "unknown";
  /** The lexicon's status word for this instance, as on `ResourceMetadata.status`. */
  status?: string;
  /** Why it was not observed, on a not-observed instance. An `UnobservedReason`. */
  reason?: string;
  detail?: string;
}

/**
 * The block's verdict from its instances' (#4454, the one place the rollup is
 * written): the first kind in `precedence` that any instance has, or
 * undefined when there are no instances or none has a kind `precedence`
 * names. The precedence is the caller's, most significant first; terraform's
 * is {@link TERRAFORM_INSTANCE_ROLLUP}.
 *
 * Partial knowledge is not knowledge: put the not-observed kind first and a
 * block with one unread instance is unread, never partly owned.
 */
export function rollupInstances<V extends { kind: string }>(verdicts: readonly V[], precedence: readonly V["kind"][]): V | undefined {
  for (const kind of precedence) {
    const found = verdicts.find((v) => v.kind === kind);
    if (found) return found;
  }
  return undefined;
}

/**
 * Terraform's block rollup over live-plan instance verdicts: any instance
 * not-observed makes the block not-observed, then foreign, then adoptable,
 * then owned, and a block whose instances are all absent is absent.
 */
export const TERRAFORM_INSTANCE_ROLLUP = ["unobserved", "foreign", "adoptable", "owned", "absent"] as const;
