/**
 * Declared entities matched to indexed resources by identity (#4523, tier 2
 * of INTENTIUS/behold#1025, rule written out on behold#1025's design comment,
 * join rules ruled on behold#1023 2026-10-26).
 *
 * A lexicon whose live read needs a stack chant deployed (aws: the
 * CloudFormation stack named after the environment) cannot see source that
 * was never deployed. Its identity fallback (#1647, lexicons/aws/src/
 * identity-observe.ts) asks Cloud Control `GetResource` for the identifier
 * the declared props spell. {@link matchDeclaredToIndex} is that rule run
 * against an index version instead of a live call:
 *
 *     A declared entity of type T with props P matches the indexed node whose
 *     `listedType` is T, whose `location` is the entity's region (or `global`
 *     for a global type), and whose `nativeId` equals the identifier P spells.
 *
 * - one node binds;
 * - two or more are refused, naming every candidate. A refusal never reads
 *   as absent or as bound;
 * - no node is absent only when the index's coverage lists (T, location) as
 *   `listed` ({@link indexCoverageFor}, where `"*"` matches every type or
 *   location). Otherwise the entity is not observed, with the coverage's
 *   reason: `filtered` when the scope left the type or location out (or the
 *   read had a tag filter, which cannot tell an untagged object from a
 *   missing one), `not-reached` when nothing covered it;
 * - an identity the declaration does not spell (a server-assigned id such as
 *   an instance id or a queue URL, a Ref, an intrinsic) cannot match: not
 *   observed, reason `no-binding`.
 *
 * The lexicon says how its props spell an identifier ({@link IndexIdentity},
 * a plugin's `indexIdentity`); this module holds the rule. Pure.
 */
import type { IRNode } from "../graph-ir";
import type { NodeIdentityValue } from "../graph-refs";
import type { UnobservedReason } from "../observation";
import { indexCoverageFor, type CloudIndexScope, type IndexDocument } from "./index-document";

/** What a declared entity's props say about its identity. */
export type DeclaredIdentity =
  | {
      kind: "identifier";
      /** The inventory API's type name the identifier belongs to (the CloudFormation type for aws). */
      listedType: string;
      /** The identifier as the index's `nativeId` spells it (Cloud Control's, `|`-joined for a multi-part one). */
      identifier: string;
      /** A global type is indexed once per account at location `global`. */
      global: boolean;
      /**
       * The location the declaration itself names, ahead of the entity's
       * region: a Kubernetes namespace, or `cluster` for a cluster-scoped
       * kind. Absent: `global` or the region.
       */
      location?: string;
      /**
       * Match indexed nodes by this lexicon kind instead of by
       * `listedType`, for a substrate whose listed type carries a version
       * the kind does not (Kubernetes' `apps/v1/Deployment` is
       * `K8s::Apps::Deployment` at any version). Coverage is still read for
       * `listedType`, so a version the index did not list reads not
       * observed, never absent.
       */
      entityKind?: string;
    }
  | {
      kind: "unmatchable";
      /** `no-binding` for an identity the declaration does not spell; `unsupported-kind` for a type with none on record. */
      reason: UnobservedReason;
      detail: string;
    };

/**
 * How a lexicon matches its declared entities to its substrate's indexed
 * nodes (a plugin's `indexIdentity`). Data plus pure functions.
 */
export interface IndexIdentity {
  substrate: CloudIndexScope["substrate"];
  /** The identifier a declared entity's props spell, or why there is none. */
  declaredIdentity(entityType: string, props: Record<string, unknown>): DeclaredIdentity;
  /**
   * The values that name an indexed node of this lexicon, for the
   * identity-match edge pass (../graph-refs.ts `reconstructIdentityEdges`).
   * Absent: its native id and its ARN cloud ids.
   */
  nodeIdentities?(node: IRNode): NodeIdentityValue[];
}

/** One declared entity, as the build output names it. */
export interface DeclaredEntity {
  name: string;
  entityType: string;
  props: Record<string, unknown>;
  /** The entity's region; falls back to the match's `region` option. */
  region?: string;
}

interface MatchBase {
  entity: string;
  entityType: string;
}

/** The verdict for one declared entity. */
export type IdentityMatch =
  | (MatchBase & { verdict: "bound"; identifier: string; listedType: string; location: string; node: string; nativeId: string })
  | (MatchBase & { verdict: "refused"; identifier: string; listedType: string; candidates: string[]; detail: string })
  | (MatchBase & { verdict: "absent"; identifier: string; listedType: string; location: string })
  | (MatchBase & { verdict: "not-observed"; reason: UnobservedReason; detail: string; identifier?: string; listedType?: string; location?: string });

export interface IdentityMatchResult {
  /** Keyed by entity name, in name order. */
  matches: Record<string, IdentityMatch>;
}

export interface MatchOptions {
  /** The region of an entity that names none. */
  region?: string;
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The documents must be cloud reads of one substrate, one account and one read, or a candidate from another read would bind. */
function cloudScopes(docs: readonly IndexDocument[], substrate: CloudIndexScope["substrate"]): CloudIndexScope[] {
  const scopes: CloudIndexScope[] = [];
  for (const d of docs) {
    const s = d.stamp.scope;
    if (s.kind !== "cloud") throw new Error(`identity matching reads cloud index documents; ${d.stamp.scopeKey} is a ${s.kind} source`);
    if (s.substrate !== substrate) throw new Error(`identity matching for ${substrate} was given a ${s.substrate} index (${d.stamp.scopeKey})`);
    scopes.push(s);
  }
  for (const d of docs) {
    const s = d.stamp.scope as CloudIndexScope;
    if (s.scopeId !== scopes[0].scopeId) throw new Error(`identity matching runs over one account: ${scopes[0].scopeId} and ${s.scopeId} are two`);
    if (d.stamp.observedAt !== docs[0].stamp.observedAt) {
      throw new Error(`identity matching runs over one read: ${docs[0].stamp.observedAt} and ${d.stamp.observedAt} are two`);
    }
  }
  return scopes;
}

function scopeIncludes(list: readonly string[] | "*", value: string): boolean {
  return list === "*" || list.includes(value);
}

/**
 * Whether the index looked at (type, location), from its coverage. `listed`
 * means a missing node is absent; anything else is a reason it is not
 * observed.
 */
export function indexCoverageVerdict(
  docs: readonly IndexDocument[],
  listedType: string,
  location: string,
): { listed: true } | { listed: false; reason: UnobservedReason; detail: string } {
  let firstRefusal: { reason: UnobservedReason; detail: string } | undefined;
  let tagFiltered: string | undefined;
  let scoped = false;
  for (const d of docs) {
    const scope = d.stamp.scope;
    if (scope.kind !== "cloud") continue;
    const entry = indexCoverageFor(d.coverage, listedType, location);
    if (entry?.verdict === "listed") {
      if (scope.tagFilter && Object.keys(scope.tagFilter).length > 0) {
        tagFiltered ??= Object.entries(scope.tagFilter).map(([k, v]) => `${k}=${v}`).join(",");
        continue;
      }
      return { listed: true };
    }
    if (entry && !firstRefusal) {
      firstRefusal = {
        reason: entry.verdict as UnobservedReason,
        detail: entry.detail ?? `the index read ${listedType} in ${location} as ${entry.verdict}`,
      };
    }
    // A global type sits at location `global`, which a region list never names.
    if (scopeIncludes(scope.types, listedType) && (location === "global" || scopeIncludes(scope.locations, location))) scoped = true;
  }
  if (firstRefusal) return { listed: false, ...firstRefusal };
  if (tagFiltered !== undefined) {
    return {
      listed: false,
      reason: "filtered",
      detail: `the index listed ${listedType} in ${location} under the tag filter ${tagFiltered}, so an untagged object and a missing one look the same`,
    };
  }
  if (!scoped) return { listed: false, reason: "filtered", detail: `the index scope left out ${listedType} in ${location}` };
  return { listed: false, reason: "not-reached", detail: `the index has no coverage for ${listedType} in ${location}` };
}

/** The node's listed type: `listedType` on an indexed node, else its kind. */
const listedTypeOf = (n: IRNode): string => n.listedType ?? n.kind;

/**
 * Match each declared entity to the index by identity. `docs` are the
 * documents of one read of one account (one `behold index` run, or its
 * regional and account-level documents); `identity` is the lexicon's.
 */
export function matchDeclaredToIndex(
  entities: readonly DeclaredEntity[],
  docs: readonly IndexDocument[],
  identity: IndexIdentity,
  options: MatchOptions = {},
): IdentityMatchResult {
  cloudScopes(docs, identity.substrate);

  // listedType -> nativeId -> nodes, and the same keyed by lexicon kind
  const byIdentity = new Map<string, Map<string, IRNode[]>>();
  const byKind = new Map<string, Map<string, IRNode[]>>();
  const add = (index: Map<string, Map<string, IRNode[]>>, t: string, n: IRNode) => {
    const m = index.get(t) ?? index.set(t, new Map()).get(t)!;
    (m.get(n.nativeId!) ?? m.set(n.nativeId!, []).get(n.nativeId!)!).push(n);
  };
  for (const d of docs) {
    for (const n of d.graph.nodes) {
      if (n.nativeId === undefined) continue;
      add(byIdentity, listedTypeOf(n), n);
      if (!n.unmappedKind) add(byKind, n.kind, n);
    }
  }

  const matches: Record<string, IdentityMatch> = {};
  for (const entity of [...entities].sort((a, b) => byString(a.name, b.name))) {
    const base = { entity: entity.name, entityType: entity.entityType };
    const declared = identity.declaredIdentity(entity.entityType, entity.props ?? {});
    if (declared.kind === "unmatchable") {
      matches[entity.name] = { ...base, verdict: "not-observed", reason: declared.reason, detail: declared.detail };
      continue;
    }
    const { listedType, identifier } = declared;
    const region = entity.region ?? options.region;
    const location = declared.location ?? (declared.global ? "global" : region);
    const all = (declared.entityKind !== undefined ? byKind.get(declared.entityKind) : byIdentity.get(listedType))?.get(identifier) ?? [];
    const inScope = location === undefined ? all : all.filter((n) => n.location === location);
    const candidates = [...new Set(inScope.map((n) => n.id))].sort(byString);

    if (candidates.length > 1) {
      matches[entity.name] = {
        ...base,
        verdict: "refused",
        identifier,
        listedType,
        candidates,
        detail: `${listedType} ${identifier} names ${candidates.length} indexed resources (${candidates.join(", ")}); none is bound`,
      };
      continue;
    }
    if (candidates.length === 1) {
      const node = inScope.find((n) => n.id === candidates[0])!;
      matches[entity.name] = {
        ...base,
        verdict: "bound",
        identifier,
        listedType,
        location: node.location ?? location ?? "",
        node: node.id,
        nativeId: node.nativeId!,
      };
      continue;
    }
    if (location === undefined) {
      // No region, so there is no (type, location) whose coverage could make absence true.
      matches[entity.name] = {
        ...base,
        verdict: "not-observed",
        reason: "no-binding",
        detail: `${entity.name} names no region and no match option gives one, so absence of ${listedType} ${identifier} cannot be scoped`,
        identifier,
        listedType,
      };
      continue;
    }
    const coverage = indexCoverageVerdict(docs, listedType, location);
    matches[entity.name] = coverage.listed
      ? { ...base, verdict: "absent", identifier, listedType, location }
      : { ...base, verdict: "not-observed", reason: coverage.reason, detail: coverage.detail, identifier, listedType, location };
  }
  return { matches };
}
