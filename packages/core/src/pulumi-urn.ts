/**
 * Pulumi URN to graph node (#4456): the one rule every Pulumi reader uses.
 *
 * A Pulumi resource is named by its URN,
 * `urn:pulumi:<stack>::<project>::<qualified type>::<name>`, where the
 * qualified type is the parent type chain joined with `$` and the resource's
 * own type last (`my:mod:Web$aws:lambda/function:Function`). The stack export
 * the pulumi member kind renders, the steps of `pulumi preview --json` (the
 * change set) and of `pulumi refresh --preview-only --json` (drift records)
 * all carry that URN, and nothing else they all carry names the resource. So
 * the node is a function of the URN alone:
 *
 * - The node key is the URN after its stack and project,
 *   `<qualified type>::<name>`: `aws:s3/bucket:Bucket::assets`,
 *   `my:mod:Web$aws:lambda/function:Function::handler`. Two stacks of one
 *   program give the same keys, and a key never changes with the stack or
 *   project name.
 * - Inside a workspace the node id is `<member>/<key>`, as the terraform
 *   lexicon names a block `<root>/<block key>`.
 * - Provider resources (`pulumi:providers:*`, at any depth) and the root
 *   `pulumi:pulumi:Stack` have no node: {@link pulumiNodeKey} is null, and a
 *   change-set entry or drift record for one gets `node: null`.
 *
 * A child sits under its component through the `parent` edge the export
 * gives, not through its id. A component's name is not part of its
 * children's URNs, and a preview narrowed with `--target`, or a delete step,
 * need not carry the chain of parents, so an id built from parent names
 * could differ between the export and a change set for the same resource.
 * The parent's type is part of the key, through the qualified type.
 *
 * Like `./change-set.ts`, this imports nothing at run time, so the change-set
 * and drift-record bundles can carry it. The pulumi lexicon imports it as
 * `@intentius/chant/pulumi-urn`.
 */

/** A URN split into its parts. */
export interface PulumiUrn {
  stack: string;
  project: string;
  /** The parent type chain and the resource's own type, joined with `$`. */
  qualifiedType: string;
  /** The resource's own type, the last of the chain. */
  type: string;
  /** The parent types, outermost first; empty for a resource whose parent is the stack. */
  parentTypes: string[];
  /** The resource's name; it may itself hold `::`. */
  name: string;
}

const PREFIX = "urn:pulumi:";
const PROVIDER_TYPE = /^pulumi:providers:/;
/** The type of the root resource every stack has. */
export const PULUMI_STACK_TYPE = "pulumi:pulumi:Stack";

/** The parts of a Pulumi URN, or undefined when `urn` is not one. */
export function parsePulumiUrn(urn: string): PulumiUrn | undefined {
  if (!urn.startsWith(PREFIX)) return undefined;
  const parts = urn.slice(PREFIX.length).split("::");
  if (parts.length < 4) return undefined;
  const [stack, project, qualifiedType] = parts;
  const name = parts.slice(3).join("::");
  if (!stack || !project || !qualifiedType || !name) return undefined;
  const chain = qualifiedType.split("$");
  return { stack, project, qualifiedType, type: chain[chain.length - 1], parentTypes: chain.slice(0, -1), name };
}

/** True for a resource that never gets a node: a provider or the root stack. */
export function isPulumiNodeless(type: string): boolean {
  return PROVIDER_TYPE.test(type) || type === PULUMI_STACK_TYPE;
}

/**
 * The node key of a URN in its member's graph, `<qualified type>::<name>`.
 * Null for a provider resource or the root stack. A string that is not a
 * Pulumi URN is its own key, so a reader that holds something else still
 * gets a stable id.
 */
export function pulumiNodeKey(urn: string): string | null {
  const parsed = parsePulumiUrn(urn);
  if (!parsed) return urn;
  if (isPulumiNodeless(parsed.type)) return null;
  return `${parsed.qualifiedType}::${parsed.name}`;
}

/** The node id of a URN inside a workspace, `<member>/<key>`, or null when it has no node. */
export function pulumiNodeId(member: string, urn: string): string | null {
  const key = pulumiNodeKey(urn);
  return key === null ? null : `${member}/${key}`;
}

const MAY_APPEAR_TYPE = "$*";
const MAY_APPEAR_NAME = "/*";

/**
 * The address of a change-set entry that stands for the resources a
 * component may register inside an `apply()` that preview could not run
 * (#4453): the component's URN with `$*` after its qualified type and `/*`
 * after its name, `urn:pulumi:dev::site::my:web:Site$*::site/*`. It reads as
 * any resource, of any type and name, whose parent chain is the component,
 * and stays unique per component, since a component's URN is.
 */
export function pulumiMayAppearAddress(componentUrn: string): string {
  const parsed = parsePulumiUrn(componentUrn);
  if (!parsed) return `${componentUrn}${MAY_APPEAR_NAME}`;
  return `${PREFIX}${parsed.stack}::${parsed.project}::${parsed.qualifiedType}${MAY_APPEAR_TYPE}::${parsed.name}${MAY_APPEAR_NAME}`;
}

/** The component URN a {@link pulumiMayAppearAddress} was made from, or undefined for any other address. */
export function pulumiMayAppearParent(address: string): string | undefined {
  const parsed = parsePulumiUrn(address);
  if (!parsed || !parsed.qualifiedType.endsWith(MAY_APPEAR_TYPE) || !parsed.name.endsWith(MAY_APPEAR_NAME)) return undefined;
  const qualifiedType = parsed.qualifiedType.slice(0, -MAY_APPEAR_TYPE.length);
  const name = parsed.name.slice(0, -MAY_APPEAR_NAME.length);
  if (!qualifiedType || !name) return undefined;
  return `${PREFIX}${parsed.stack}::${parsed.project}::${qualifiedType}::${name}`;
}

/**
 * The ids, in the order tried, that a Pulumi change-set entry or drift
 * record can have in its member's graph IR, in the shape of
 * `changeSetNodeCandidates` (`./change-set-graph.ts`): `<member>/<key>`.
 * Empty for a provider or the root stack, so mapping leaves `node: null`.
 * A may-appear entry ({@link pulumiMayAppearAddress}) is on its component's
 * node, since nothing names the resources it stands for.
 */
export function pulumiNodeCandidates(entry: { member: string; address: string }): string[] {
  const id = pulumiNodeId(entry.member, pulumiMayAppearParent(entry.address) ?? entry.address);
  return id === null ? [] : [id];
}

/** One step of `pulumi preview --json` (or `refresh --preview-only --json`), as far as the node rule reads it. */
export interface PulumiPreviewStep {
  op?: string;
  urn?: string;
}

/**
 * The URN and node id of each step of a `pulumi preview --json` document
 * (`{ steps: [...] }`). A replace shows as several steps on one URN; each
 * gets the same node. Steps with no URN are skipped.
 */
export function pulumiPreviewNodes(preview: unknown, member: string): { urn: string; op: string; node: string | null }[] {
  const steps = (preview as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return [];
  const out: { urn: string; op: string; node: string | null }[] = [];
  for (const s of steps as PulumiPreviewStep[]) {
    if (typeof s?.urn !== "string") continue;
    out.push({ urn: s.urn, op: typeof s.op === "string" ? s.op : "", node: pulumiNodeId(member, s.urn) });
  }
  return out;
}
