/**
 * A behaviour engine's request from a terraform estate, declared or live (#2360).
 *
 * The epic (#2355) wants two predictions shown as a delta: what the file
 * declares, and what the account holds. For a choudoufu root the second is
 * readable — `live-ls -json` lists every resource the account holds under the
 * estate's marker, `live-plan -json` says which declared instance each one is
 * bound to and which declarations nothing answers for — and this module turns
 * either reading into the request `PredictBehaviourOptions` describes:
 * `entityNames`, `entities`, `edges`, `edgeCoverage`, `traffic`.
 *
 * One producer for both sides, on purpose. A delta is only a statement about
 * the estate if both sides were assembled the same way, and the third review
 * comment on #2360 is about exactly the asymmetry this avoids: the declared
 * path had no containment producer, so a "one zone lost" verdict differed
 * between the sides for a reason that was not drift. Here the same reference
 * catalog (`./reference-catalog.ts`) runs over the same reconstruction
 * (`reconstructEdges`, `packages/core/src/graph-refs.ts`) on both sides, and
 * `edgeCoverage.containmentEdges` is populated the same way on each.
 *
 * ## What the live side is, and is not
 *
 * The two documents carry identities, types, addresses and markers. Neither
 * carries a resource's attributes: a subnet's `vpc_id` as the account holds it
 * is in no section of either. So a live node's arguments are the declaration's
 * arguments — the body choudoufu applied — and its **references** are the
 * declaration's references resolved against what is bound: a reference whose
 * target the plan bound resolves to that target's live identity, and one whose
 * target is absent from the account stays unresolved and is reported as
 * `dangling`, naming the node, the argument and the address it points at. A
 * resource the listing holds that nothing declares has no body at all; it is a
 * node with an identity and a type, and its kind is counted into
 * `unresolvedKinds` unless the catalog knows that kind references nothing.
 *
 * The drift this side sees is therefore **membership** drift: a resource added
 * out of band under the estate's marker, a declared resource never applied, a
 * resource at a declared identity that another estate holds. An attribute
 * changed live — an instance resized by hand — is not in either document and
 * is not claimed here; the size an engine is sent is the declared one on both
 * sides. `describe-resources.ts`'s module doc has the same boundary for the
 * observation read, for the same reason.
 *
 * One consequence of that worth stating outright, because it is the one a
 * reader will hit first: a block with `count` or `for_each` is **one** node on
 * both sides, whatever the account holds. The request's unit is the entity the
 * caller asked about, and the caller asked about `aws_eip.pool`, not about two
 * slots — inventing `aws_eip.pool[0]` and `[1]` as entities would put names in
 * the report that are in no `entityNames` list and in no build. Every instance
 * address the plan named rides on `props.live.instances` instead, so an engine
 * that prices per instance has the count and one that does not is not silently
 * handed a multiplier. An estate whose drift is a changed `count` is therefore
 * a delta this path does not yet show.
 *
 * ## `edgeCoverage`, honestly
 *
 * `partial` whenever `dangling` or `unresolvedKinds` is non-empty, `complete`
 * only when both are empty, and `dangling` carries `reconstructEdges`'s
 * `DanglingRef` records through unflattened — `from` is the field that says
 * which node's argument leaves the estate. `containmentEdges` comes from the
 * reconstruction's `containmentEdges`, the traversable shape, and never from
 * the `containment` pairs beside it. All three of those are #2360's review
 * comments, applied.
 */

import type {
  BehaviourEdgeCoverage,
  PredictBehaviourOptions,
  UnpredictedEntity,
} from "@intentius/chant/behaviour";
import type { EntityReference, IRNode } from "@intentius/chant/graph-ir";
import { reconstructEdges, type ReconstructedEdges } from "@intentius/chant/graph-refs";
import {
  classifyLiveInstance,
  declaredOf,
  entityKeyFor,
  instancesOf,
  type LiveLsItem,
  type LiveLsListing,
  type LivePlanIndex,
  type TerraformDeclared,
} from "../describe-resources";
import { RESOURCE_TYPE } from "../hcl/parse";
import { isUnresolvedKind, TERRAFORM_REFERENCE_CATALOG } from "./reference-catalog";

/**
 * One entity as this builder needs it: the contract's `{ entityType, props }`
 * plus the `references` the terraform build stamps beside `props`
 * (`../hcl/edges.ts`, chant #2265). A caller holding the build's entities has
 * them; a caller that copied only the two contract fields does not, and a
 * block whose body holds a `${…}` reference with none resolved is counted as
 * an unresolved kind rather than read as referencing nothing.
 */
export interface TerraformBehaviourEntity {
  entityType: string;
  props: Record<string, unknown>;
  references?: readonly EntityReference[];
}

/** One live root's two documents, already parsed. */
export interface TerraformLiveRead {
  root: string;
  listing: LiveLsListing;
  plan: LivePlanIndex;
}

/** How a live node stands in the account. */
export type LiveResourceStatus = "bound" | "adoptable" | "foreign" | "orphan";

/**
 * What a live node's `props.live` carries: the facts the two documents state
 * about it, kept apart from the declaration under `props` so a reader can
 * tell which side said what.
 */
export interface LiveResourceFacts {
  status: LiveResourceStatus;
  ownership: "owned" | "unknown" | "foreign";
  /** The import identity the plan bound (`vpc-…`, a bucket name), on a single-instance block. */
  identity?: string;
  /** The ARN or other stable identity the listing carries. */
  arn?: string;
  /** The region the ARN names, where it names one. */
  region?: string;
  /** Every instance address the plan named for the block, where there is more than the block itself. */
  instances?: string[];
  /** The estate holding a foreign resource, when its marker names one. */
  heldBy?: string;
  /** The marker tags the listing read off an undeclared resource. */
  tags?: Record<string, string>;
}

export interface TerraformBehaviourRequestOptions
  extends Pick<PredictBehaviourOptions, "environment" | "buildOutput" | "traffic" | "region" | "stack" | "owned"> {
  entityNames: readonly string[];
  entities: ReadonlyMap<string, TerraformBehaviourEntity>;
  /**
   * Live reads, one per live root. A root with a read here is built from the
   * account; every other root is built from its declaration. Omit for the
   * declared side.
   */
  live?: readonly TerraformLiveRead[];
}

export interface TerraformBehaviourRequest {
  /** The request, ready for `screenBehaviourRequest` and an engine-fronting `predictBehaviour`. */
  request: PredictBehaviourOptions;
  /** Which side each name in the request came from. */
  sources: Record<string, "live" | "declared">;
  /**
   * Declared resources of a live root the account does not hold: the plan
   * reported them `ABSENT`, or named no instance for them. Not in the request,
   * because a prediction of the account cannot price what is not in it, and
   * not `unpredicted`, because the contract has no reason for "not there".
   * The declared side names them; the delta shows them as declared-only.
   */
  absent: string[];
  /**
   * Declared names of a live root with no live verdict to build from — an
   * instance the plan could not read, or one withheld by `owned` — each with
   * the reason. Not in the request; a caller merges them into the report.
   */
  unpredicted: Record<string, UnpredictedEntity>;
}

/** The node `reconstructEdges` sees: the provider type as its kind, the substituted body as its attrs. */
type GraphNode = IRNode;

/** Code-unit order, so the request's bytes do not depend on the machine's locale. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The block a document instance address belongs to: `aws_eip.pool[0]` is `aws_eip.pool`. */
export function blockAddressOf(instance: string): string {
  return instance.replace(/\[[^\]]*\]$/, "");
}

/** The region an ARN names, or undefined for a global one (`arn:aws:s3:::bucket`). */
export function regionOfArn(arn: string): string | undefined {
  const parts = arn.split(":");
  return parts[0] === "arn" && parts.length >= 6 && parts[3] ? parts[3] : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bodyOf(props: Record<string, unknown>): Record<string, unknown> {
  const body = props.body;
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function referencesOf(entity: TerraformBehaviourEntity | undefined): readonly EntityReference[] {
  return Array.isArray(entity?.references) ? entity.references : [];
}

/** True when a body holds any `${…}` string at all, at any depth. */
function holdsReference(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (typeof value === "string") return value.includes("${");
  if (Array.isArray(value)) return value.some((v) => holdsReference(v, depth + 1));
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).some((v) => holdsReference(v, depth + 1));
  }
  return false;
}

/** `${addr}` followed by an attribute, an index, or the closing brace — the address itself, not a longer one. */
function mentions(text: string, address: string): boolean {
  const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\$\\{${escaped}(?:[.\\[}\\s)\\],]|$)`).test(text);
}

/** One `${…}` and nothing else: the value the account holds *is* the target's identity. */
const WHOLE_INTERPOLATION = /^\$\{[^{}]*\}$/;

/**
 * The body with every resolvable reference replaced by the identifier it
 * stands for, so `reconstructEdges` can match it against the node that owns
 * that identifier.
 *
 * A leaf string is replaced only when the reference **is** the whole value:
 * the string is one `${…}` and nothing else, exactly one of the block's
 * references under the same top-level argument is the one it names, and that
 * reference resolves. Then the value in the account really is the target's
 * identity, and matching it against the node holding that identity is a
 * statement about the estate.
 *
 * Everything else is left alone, and the two cases it leaves alone are
 * different. `"${a.id}-${b.id}"` and `"${a.id}-suffix"` are composed values —
 * a name derived from an identity is not that identity, and substituting the
 * bare identity into one would hand the resolver a value the account does not
 * hold and get back an edge nothing points along. A string naming a reference
 * that does not resolve keeps its `${…}`, which is what makes a reference to a
 * target the account is missing come back from the resolver as `dangling` with
 * the address in `value` rather than vanishing.
 */
export function substituteReferences(
  body: Record<string, unknown>,
  references: readonly EntityReference[],
  addressOf: (to: string) => string | undefined,
  resolve: (to: string) => string | undefined,
): Record<string, unknown> {
  const leaf = (value: string, via: string): string => {
    if (!WHOLE_INTERPOLATION.test(value)) return value;
    const matched = references.filter((r) => {
      if ((r.viaAttr ?? "") !== via) return false;
      const address = addressOf(r.to);
      return address !== undefined && mentions(value, address);
    });
    if (matched.length !== 1) return value;
    return resolve(matched[0].to) ?? value;
  };
  const walk = (value: unknown, via: string, depth: number): unknown => {
    if (depth > 12) return value;
    if (typeof value === "string") return leaf(value, via);
    if (Array.isArray(value)) return value.map((v) => walk(v, via, depth + 1));
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        out[key] = walk(inner, depth === 0 ? key : via, depth + 1);
      }
      return out;
    }
    return value;
  };
  return walk(body, "", 0) as Record<string, unknown>;
}

/**
 * The provider type a resource block declares — `aws_subnet` — or undefined
 * for any other block.
 *
 * Read off the address, because the block carries no `type` field:
 * `../hcl/parse.ts` composes a resource's address as `${type}.${name}` and
 * keeps it unqualified even inside a descended child module, where the calling
 * chain lives on `props.callers` and the `module.<name>` segments live in the
 * entity's key. An address with no dot is a live row's identity standing in
 * for an address it had none of, and is not a type.
 *
 * This is the kind a node is given for `reconstructEdges`, and it is the same
 * derivation `./kinds.ts`'s `resolveType` runs to look a coverage row up,
 * so the graph and the coverage table agree on what a block is. A live row
 * states its own type instead, on `props.resourceType`, the name
 * `observeAmbient` already uses for it.
 */
function providerTypeOf(entity: TerraformBehaviourEntity): string | undefined {
  if (entity.entityType !== RESOURCE_TYPE) return undefined;
  const stated = asString(entity.props.resourceType);
  if (stated !== undefined) return stated;
  const address = asString(entity.props.address);
  if (address === undefined) return undefined;
  const dot = address.indexOf(".");
  return dot > 0 ? address.slice(0, dot) : undefined;
}

/** One root's worth of the request, on either side. */
interface RootPart {
  nodes: GraphNode[];
  entities: Map<string, TerraformBehaviourEntity>;
  sources: Record<string, "live" | "declared">;
  absent: string[];
  unpredicted: Record<string, UnpredictedEntity>;
  /** Kinds nothing was looked for on: no rule, or no body to look in. */
  unresolvedKinds: Set<string>;
}

function emptyPart(): RootPart {
  return { nodes: [], entities: new Map(), sources: {}, absent: [], unpredicted: {}, unresolvedKinds: new Set() };
}

/** The verdict `describe-resources.ts` gives a block, aggregated over its instances in the same precedence. */
interface LiveVerdict {
  kind: "present" | "absent" | "unobserved";
  status?: LiveResourceStatus;
  ownership?: LiveResourceFacts["ownership"];
  identity?: string;
  heldBy?: string;
  instances: string[];
  reason?: UnpredictedEntity["reason"];
  detail?: string;
}

function liveVerdictOf(address: string, plan: LivePlanIndex): LiveVerdict {
  const instances = instancesOf(address, plan);
  if (instances.length === 0) return { kind: "absent", instances };
  const verdicts = instances.map((a) => classifyLiveInstance(a, plan));

  const unobserved = verdicts.find((v) => v.kind === "unobserved");
  if (unobserved && unobserved.kind === "unobserved") {
    return {
      kind: "unobserved",
      instances,
      // `no-credentials` is an observation reason and not a prediction one;
      // the credential wording stays in the detail.
      reason: unobserved.reason === "no-credentials" ? "read-failed" : unobserved.reason,
      detail: unobserved.detail,
    };
  }
  const foreign = verdicts.find((v) => v.kind === "foreign");
  if (foreign && foreign.kind === "foreign") {
    return {
      kind: "present",
      status: "foreign",
      ownership: "foreign",
      instances,
      ...(foreign.row.identity ? { identity: foreign.row.identity } : {}),
      ...(foreign.row.heldBy ? { heldBy: foreign.row.heldBy } : {}),
    };
  }
  const adoptable = verdicts.find((v) => v.kind === "adoptable");
  if (adoptable && adoptable.kind === "adoptable") {
    return {
      kind: "present",
      status: "adoptable",
      ownership: "unknown",
      instances,
      ...(adoptable.row.identity ? { identity: adoptable.row.identity } : {}),
    };
  }
  const owned = verdicts.filter((v) => v.kind === "owned");
  if (owned.length === 0) return { kind: "absent", instances };
  const single = owned.length === 1 && instances.length === 1 ? owned[0] : undefined;
  return {
    kind: "present",
    status: "bound",
    ownership: "owned",
    instances,
    ...(single && single.kind === "owned" && single.row.identity ? { identity: single.row.identity } : {}),
  };
}

/**
 * A live root: the declared resources the account holds, at their live
 * identities, plus everything the listing holds that nothing declares.
 */
function liveRootPart(
  root: string,
  declared: TerraformDeclared[],
  entities: ReadonlyMap<string, TerraformBehaviourEntity>,
  read: TerraformLiveRead,
  owned: boolean | undefined,
): RootPart {
  const part = emptyPart();
  const { listing, plan } = read;
  const estate = plan.estate || listing.estate;

  // The listing, by block address: a `count` block has one item per instance.
  const listed = new Map<string, LiveLsItem[]>();
  for (const item of listing.items) {
    if (!item.address) continue;
    const block = blockAddressOf(item.address);
    (listed.get(block) ?? listed.set(block, []).get(block)!).push(item);
  }

  // Live identity per entity key, for reference substitution below. Filled as
  // declared blocks are placed; an orphan can be the target of nothing.
  const identity = new Map<string, string | undefined>();
  const placed: Array<{ name: string; entity: TerraformBehaviourEntity; declared: TerraformDeclared; facts: LiveResourceFacts }> = [];

  for (const d of declared) {
    const entity = entities.get(d.name);
    if (!entity) continue;
    if (entity.entityType !== RESOURCE_TYPE) {
      // A variable, an output, a data block: not a thing the account holds,
      // so the account has nothing to say about it. It rides through as
      // declared, and the coverage rows decline it by name on both sides alike.
      part.sources[d.name] = "live";
      part.entities.set(d.name, entity);
      continue;
    }
    const verdict = liveVerdictOf(d.address, plan);
    if (verdict.kind === "absent") {
      part.absent.push(d.name);
      continue;
    }
    if (verdict.kind === "unobserved") {
      part.unpredicted[d.name] = { type: RESOURCE_TYPE, reason: verdict.reason!, detail: verdict.detail! };
      continue;
    }
    if (owned && verdict.ownership !== "owned") {
      part.unpredicted[d.name] = {
        type: RESOURCE_TYPE,
        reason: "filtered",
        detail: `this address read \`${verdict.ownership}\` on the root's live markers and --owned was requested`,
      };
      continue;
    }
    const items = listed.get(d.address) ?? [];
    const single = items.length === 1 && verdict.instances.length === 1 ? items[0] : undefined;
    const facts: LiveResourceFacts = {
      status: verdict.status!,
      ownership: verdict.ownership!,
      ...(verdict.identity ? { identity: verdict.identity } : {}),
      ...(single ? { arn: single.id } : {}),
      ...(single && regionOfArn(single.id) ? { region: regionOfArn(single.id) } : {}),
      ...(verdict.instances.length > 1 || verdict.instances[0] !== d.address ? { instances: verdict.instances } : {}),
      ...(verdict.heldBy ? { heldBy: verdict.heldBy } : {}),
    };
    identity.set(d.name, verdict.identity);
    part.sources[d.name] = "live";
    placed.push({ name: d.name, entity, declared: d, facts });
  }

  const addressOf = (to: string): string | undefined => asString(entities.get(to)?.props.address);
  // A bound target resolves to its live identity; a target that is live but
  // carries none (a marker read the tagging index had not settled, choudoufu
  // #1014) resolves to its node id; a target not in the account resolves to
  // nothing, and the reference stays in the body for the resolver to report.
  const resolve = (to: string): string | undefined =>
    identity.has(to) ? (identity.get(to) ?? to) : undefined;

  for (const { name, entity, declared: d, facts } of placed) {
    const kind = providerTypeOf(entity) ?? "";
    const references = referencesOf(entity);
    const body = bodyOf(entity.props);
    if (references.length === 0 && holdsReference(body)) part.unresolvedKinds.add(kind);
    else if (isUnresolvedKind(kind)) part.unresolvedKinds.add(kind);
    part.nodes.push({
      id: name,
      kind,
      lexicon: "terraform",
      attrs: substituteReferences(body, references, addressOf, resolve),
      ...(facts.identity ? { physicalId: facts.identity } : {}),
    });
    part.entities.set(name, {
      entityType: entity.entityType,
      props: { ...entity.props, address: d.address, live: facts },
      ...(entity.references ? { references: entity.references } : {}),
    });
  }

  // What the account holds that nothing declares: the owned orphans. No body,
  // so nothing to look for references in.
  for (const item of listing.items) {
    if (item.declared) continue;
    const address = item.address ? blockAddressOf(item.address) : item.id;
    const name = entityKeyFor(root, address);
    if (part.entities.has(name) || entities.has(name)) continue;
    const facts: LiveResourceFacts = {
      status: "orphan",
      ownership: "owned",
      arn: item.id,
      ...(regionOfArn(item.id) ? { region: regionOfArn(item.id) } : {}),
      ...(item.address && item.address !== address ? { instances: [item.address] } : {}),
      tags: item.tags,
    };
    if (isUnresolvedKind(item.type)) part.unresolvedKinds.add(item.type);
    part.sources[name] = "live";
    part.nodes.push({ id: name, kind: item.type, lexicon: "terraform", attrs: {}, physicalId: item.id });
    part.entities.set(name, {
      entityType: RESOURCE_TYPE,
      props: {
        address,
        root,
        estate,
        // `resourceType`, the name `observeAmbient` gives the same fact
        // (`../describe-resources.ts`). An undeclared resource has no
        // terraform address for a type to be read out of, so the listing's
        // own statement of it is the only one there is.
        resourceType: item.type,
        mode: "live",
        live: facts,
      },
    });
  }

  return part;
}

/** A declared root: every entity as declared, references resolved to the entity keys they name. */
function declaredRootPart(
  declared: TerraformDeclared[],
  entities: ReadonlyMap<string, TerraformBehaviourEntity>,
): RootPart {
  const part = emptyPart();
  const addressOf = (to: string): string | undefined => asString(entities.get(to)?.props.address);
  const resolve = (to: string): string | undefined => (entities.has(to) ? to : undefined);
  for (const d of declared) {
    const entity = entities.get(d.name);
    if (!entity) continue;
    part.sources[d.name] = "declared";
    part.entities.set(d.name, entity);
    const kind = providerTypeOf(entity);
    if (kind === undefined) continue;
    const references = referencesOf(entity);
    const body = bodyOf(entity.props);
    if (references.length === 0 && holdsReference(body)) part.unresolvedKinds.add(kind);
    else if (isUnresolvedKind(kind)) part.unresolvedKinds.add(kind);
    part.nodes.push({
      id: d.name,
      kind,
      lexicon: "terraform",
      attrs: substituteReferences(body, references, addressOf, resolve),
    });
  }
  return part;
}

/**
 * The coverage claim, from the reconstruction and the kinds nothing was
 * looked for on. `partial` names what is missing; `complete` is claimed only
 * when nothing is.
 */
export function edgeCoverageOf(
  reconstructed: Pick<ReconstructedEdges, "dangling" | "containmentEdges">,
  unresolvedKinds: readonly string[],
): BehaviourEdgeCoverage {
  const dangling = reconstructed.dangling;
  const kinds = [...unresolvedKinds].sort(byCodeUnit);
  return {
    verdict: dangling.length > 0 || kinds.length > 0 ? "partial" : "complete",
    ...(dangling.length > 0 ? { dangling } : {}),
    ...(kinds.length > 0 ? { unresolvedKinds: kinds } : {}),
    containmentEdges: reconstructed.containmentEdges,
  };
}

/**
 * Build the request. Pure: the documents are already parsed and nothing here
 * reads a clock, the environment or the filesystem, so the same declaration
 * and the same two documents give the same request forever.
 */
export function terraformBehaviourRequest(options: TerraformBehaviourRequestOptions): TerraformBehaviourRequest {
  const live = new Map((options.live ?? []).map((read) => [read.root, read]));
  const byRoot = new Map<string, TerraformDeclared[]>();
  const rootless: string[] = [];
  for (const name of options.entityNames) {
    const entity = options.entities.get(name);
    const d = declaredOf(name, entity);
    if (!d.root) {
      rootless.push(name);
      continue;
    }
    (byRoot.get(d.root) ?? byRoot.set(d.root, []).get(d.root)!).push(d);
  }

  const parts: RootPart[] = [];
  for (const [root, declared] of byRoot) {
    const read = live.get(root);
    parts.push(read ? liveRootPart(root, declared, options.entities, read, options.owned) : declaredRootPart(declared, options.entities));
  }

  const entities = new Map<string, TerraformBehaviourEntity>();
  const sources: Record<string, "live" | "declared"> = {};
  const absent: string[] = [];
  const unpredicted: Record<string, UnpredictedEntity> = {};
  const unresolved = new Set<string>();
  const nodes: GraphNode[] = [];
  for (const part of parts) {
    for (const [name, entity] of part.entities) entities.set(name, entity);
    Object.assign(sources, part.sources);
    absent.push(...part.absent);
    Object.assign(unpredicted, part.unpredicted);
    for (const kind of part.unresolvedKinds) unresolved.add(kind);
    nodes.push(...part.nodes);
  }
  // A name carrying no root came from somewhere other than `buildRoots()`. It
  // is passed through as it came, so the engine-fronting lexicon reports it
  // rather than this builder dropping it.
  for (const name of rootless) {
    const entity = options.entities.get(name);
    if (entity) entities.set(name, entity);
    sources[name] = "declared";
  }

  nodes.sort((a, b) => byCodeUnit(a.id, b.id));
  const reconstructed = reconstructEdges(nodes, TERRAFORM_REFERENCE_CATALOG);

  const entityNames = [...new Set([...entities.keys(), ...rootless])].sort(byCodeUnit);
  const request: PredictBehaviourOptions = {
    environment: options.environment,
    buildOutput: options.buildOutput,
    entityNames,
    entities: entities as Map<string, { entityType: string; props: Record<string, unknown> }>,
    ...(options.stack !== undefined ? { stack: options.stack } : {}),
    ...(options.region !== undefined ? { region: options.region } : {}),
    ...(options.owned !== undefined ? { owned: options.owned } : {}),
    traffic: options.traffic,
    edges: reconstructed.edges,
    edgeCoverage: edgeCoverageOf(reconstructed, [...unresolved]),
  };

  return { request, sources, absent: absent.sort(byCodeUnit), unpredicted };
}
