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
 * `count` or a literal `for_each`, or (#4486) one that reads a variable whose
 * value the root's files give. An expansion that only a plan can count has
 * no instance nodes in the declared graph, and an entry
 * for one of its instances still names the instance id by the rule above,
 * with `instanceOf` saying which block node to hang it under.
 *
 * Under a module call that is itself expanded (#4486), the module key goes
 * on the call segment it belongs to, as Terraform prints it, and the
 * block's own key stays at the end: `module.app[0].aws_eip.pool[1]` in root
 * `estate` is `estate/module.app[0]/aws_eip.pool[1]`, under the block node
 * `estate/module.app/aws_eip.pool`. The node also carries `instanceScope`,
 * the expanded module path as Terraform prints it (`module.app[0]`), and its
 * `instanceKey` is the block's own key, absent when only the module call is
 * expanded. With no module call expanded the rule is the one above. The
 * module call's own node gets instance nodes by the first rule,
 * `estate/module.app[0]`.
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

/** One part of a terraform address: a name and the `[...]` key that follows it, if any. */
interface AddressPart {
  name: string;
  key?: string;
}

/** Split a terraform address on its dots, keeping each part's `[...]` key. Quoted keys may hold `.` or `]`. */
function addressParts(address: string): AddressPart[] {
  const parts: AddressPart[] = [];
  let name = "";
  let key = "";
  let depth = 0;
  let quoted = false;
  const flush = (): void => {
    if (name.length > 0) parts.push({ name, ...(key ? { key } : {}) });
    name = "";
    key = "";
  };
  for (let i = 0; i < address.length; i++) {
    const c = address[i]!;
    if (depth > 0) {
      key += c;
      if (quoted) {
        if (c === "\\") key += address[++i] ?? "";
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "]") depth--;
      continue;
    }
    if (c === "[") {
      depth++;
      key += c;
    } else if (c === ".") flush();
    else name += c;
  }
  flush();
  return parts;
}

/** Where one terraform-family instance address sits, relative to its root (#4486). */
export interface TerraformInstancePath {
  /** The block's key in its root: `module.app/aws_eip.pool`. */
  block: string;
  /** The instance node's key in its root: `module.app[0]/aws_eip.pool[1]`. */
  instance: string;
  /** The block's own instance key, `[1]`, absent when the block itself is not expanded. */
  key?: string;
  /** The expanded module path, `module.app[0]`, absent when no module call on the way is expanded. */
  scope?: string;
}

/**
 * The block key and instance node key a terraform-family address names, or
 * undefined when nothing on it is expanded (no `[...]` anywhere) or the
 * address is not a block's. `module.app[0].aws_eip.pool[1]` is block
 * `module.app/aws_eip.pool`, instance `module.app[0]/aws_eip.pool[1]`, key
 * `[1]`, scope `module.app[0]`.
 */
export function terraformInstancePath(address: string): TerraformInstancePath | undefined {
  const parts = addressParts(address);
  const blockScope: string[] = [];
  const instanceScope: string[] = [];
  let expandedScope = false;
  let i = 0;
  while (parts[i]?.name === "module" && i + 1 < parts.length) {
    const call = parts[i + 1]!;
    blockScope.push(`module.${call.name}`);
    instanceScope.push(`module.${call.name}${call.key ?? ""}`);
    if (call.key) expandedScope = true;
    i += 2;
  }
  const rest = parts.slice(i);
  let block: string;
  let key: string | undefined;
  if (rest.length === 0) {
    // The module call itself, a block of its caller.
    if (blockScope.length === 0) return undefined;
    const call = blockScope.pop()!;
    const inst = instanceScope.pop()!;
    block = call;
    key = inst.length > call.length ? inst.slice(call.length) : undefined;
    expandedScope = instanceScope.some((s, n) => s !== blockScope[n]);
  } else if (rest[0]!.name === "data" && rest.length >= 3) {
    block = `data.${rest[1]!.name}.${rest[2]!.name}`;
    key = rest[2]!.key;
  } else if (rest.length >= 2) {
    block = `${rest[0]!.name}.${rest[1]!.name}`;
    key = rest[1]!.key;
  } else return undefined;
  if (key === undefined && !expandedScope) return undefined;
  const scope = expandedScope ? instanceScope.join(".") : undefined;
  return {
    block: [...blockScope, block].join("/"),
    instance: [...(expandedScope ? instanceScope : blockScope), `${block}${key ?? ""}`].join("/"),
    ...(key !== undefined ? { key } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };
}

/**
 * One instance's observed verdict, carried on its block's
 * `ResourceMetadata.instances` (`./lexicon.ts`) so the live graph can draw the
 * instance node and paint it on its own.
 */
export interface InstanceObservation {
  /**
   * The block's own instance key as Terraform prints it, `[0]` or `["a"]`.
   * Absent on an instance that only an expanded module call makes (#4488),
   * which then carries {@link scope}.
   */
  key?: string;
  /**
   * The expanded module path as Terraform prints it, `module.app[0]`, on an
   * instance under an expanded module call (#4488). The live graph then
   * builds the node id by {@link terraformInstancePath} from {@link address},
   * the same id the declared graph lists: `estate/module.app[0]/aws_eip.pool[1]`.
   */
  scope?: string;
  /** The engine's own instance address, `aws_eip.pool[0]` or `module.app[0].aws_eip.pool[1]`. */
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
 * The live graph's node id for one observed instance of the block node
 * `blockNode` (#4488): `<blockNode><key>` with no expanded module call on
 * the way, else the declared graph's rule (#4486) applied to the instance's
 * address, so `module.app[0].aws_eip.pool[1]` under
 * `estate/module.app/aws_eip.pool` is `estate/module.app[0]/aws_eip.pool[1]`.
 * Undefined when the address does not belong to that block node.
 */
export function observedInstanceNodeId(blockNode: string, inst: Pick<InstanceObservation, "key" | "scope" | "address">): string | undefined {
  if (inst.scope === undefined) return inst.key === undefined ? undefined : instanceNodeId(blockNode, inst.key);
  const path = terraformInstancePath(inst.address);
  if (!path?.scope) return undefined;
  if (blockNode !== path.block && !blockNode.endsWith(`/${path.block}`)) return undefined;
  return `${blockNode.slice(0, blockNode.length - path.block.length)}${path.instance}`;
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
