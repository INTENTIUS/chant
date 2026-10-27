/**
 * Live edge reconstruction (#778, the crux of epic #776).
 *
 * A source-derived IR gets its edges from declared AttrRefs. A live IR
 * (`chant graph --live`) has none — observed resources reference each other by
 * **physical identifier** buried in their attributes (a subnet's `VpcId`, an
 * ALB listener's `TargetGroupArn`, an ECS service's `ClusterArn`). This module
 * reconstructs those relationships from a per-lexicon **reference catalog**.
 *
 * Provider-agnostic: the engine here is pure and knows nothing about AWS; each
 * lexicon ships its own `ReferenceCatalog` (data). Given the live nodes and a
 * catalog, `reconstructEdges` returns:
 *   - `edges`       — peer references → IR edges (holder → referenced)
 *   - `containment` — "inside" references (subnet ∈ VPC) → boundary hints for #779
 *   - `dangling`    — references whose target isn't in the observed set
 *
 * The containment / edge split keeps subnet-in-VPC a boundary box (#779), not a
 * cluttering line. Deterministic given a fixed node set.
 */
import type { IRNode, IREdge } from "./graph-ir";

/** Which attribute paths identify a resource kind (its id / ARN / name / DNS). */
export interface IdentityRule {
  kind: string;
  /** Attr paths whose values are identifiers others reference this kind by. */
  ids: string[];
}

/** A reference: an attr path on `from` whose value points at another resource. */
export interface RefRule {
  /** Holder kind. */
  from: string;
  /** Attr path — supports `a.b` and `arr[].id`. */
  path: string;
  /** Which identifier the value is (currently informational; matching is exact). */
  match?: "id" | "arn" | "name" | "any";
  /** Constrain the target kind (disambiguates identifier collisions). */
  targetKind?: string;
  /**
   * The target kind when the rule runs over indexed nodes (#4522, ruled on
   * INTENTIUS/behold#1023 Q4), for a rule that has no {@link targetKind}
   * because its values are logical ids (`enrichLiveAttrs`), which are unique.
   * Over an index the same path holds a physical value, often a name, so the
   * target kind is what keeps it from joining whatever else has that name.
   */
  indexedTargetKind?: string;
  /** `reference` → an edge; `containment` → a boundary hint (#779), not an edge. */
  relation: "reference" | "containment";
  /** Edge / containment label (e.g. "in VPC", "sg", "targets"). */
  label?: string;
  /**
   * What the reconstructed edge's `viaAttr` should be, when traversal needs a
   * different string than rendering does (#1275).
   *
   * `viaAttr` defaulted to `label ?? path`, which serves a renderer well and a
   * traversal badly. The labels here are human-facing — "sg", "via", "in VPC" —
   * while a fold like `enrichEffectiveTopology` matches provider attribute
   * names: `SecurityGroupIds`, `SubnetId`, `LaunchTemplateId`. One field could
   * not be both, so a rule that is traversed declares the name explicitly and
   * keeps its label for the picture.
   *
   * On a `containment` rule this additionally opts the relation into producing
   * an edge, on top of the boundary pair it already produces. Containment is
   * not an edge by default and should not become one — but a fold's first hop
   * is sometimes exactly a containment relation (an instance is *in* a subnet),
   * and that hop has to be traversable without duplicating the rule as a
   * reference and drawing the line twice.
   */
  viaAttr?: string;
}

/**
 * A typed tag rule (#4522, ruled on INTENTIUS/behold#1023 Q5): a tag whose
 * key names a cloud id, read off an indexed node's `tags`. Tags make edges
 * only through these, never by matching equal tag values, because two
 * objects can carry the same value for any reason.
 */
export interface TagRefRule {
  /** Holder kind; absent for every kind of this lexicon. */
  from?: string;
  /** The exact tag key, or a key prefix ending in `/` whose remainder is the value. */
  key: string;
  /** `value`: the tag's value is the id. `key-suffix`: the key after {@link key} is (`kubernetes.io/cluster/<name>`). */
  read: "value" | "key-suffix";
  targetKind: string;
  label?: string;
}

/** A lexicon's reference knowledge — its identity map and reference rules. */
export interface ReferenceCatalog {
  identities: IdentityRule[];
  refs: RefRule[];
  /** Typed tag rules, used over indexed nodes only (#4522). */
  tagRefs?: TagRefRule[];
}

/** `child` is contained by `parent` (subnet ∈ VPC). For #779's boundary boxes. */
export interface ContainmentPair {
  child: string;
  parent: string;
  label?: string;
}

/** A reference whose target isn't in the observed set (cross-account, unmanaged,
 * deleted) — surfaced, never turned into a wrong edge. */
export interface DanglingRef {
  from: string;
  path: string;
  value: string;
  targetKind?: string;
}

export interface ReconstructedEdges {
  edges: IREdge[];
  containment: ContainmentPair[];
  /**
   * The same containment pairs, as edges a query can walk.
   *
   * Containment is a boundary when you are drawing it and a relationship when
   * you are asking about it, and those two consumers had been served by one
   * decision. `edges` is what a renderer draws as lines, so putting "is in this
   * VPC" there would draw a line from every resource to its VPC and undo the
   * boxes; that is why containment is kept out of it, and why it stays out.
   *
   * But `->`/`<-` is asking which nodes reach which, and being inside something
   * is a way of reaching it. "Which subnets have no network interfaces in them"
   * and "which VPCs have no instances in them" are the same question, and both
   * are containment. With only `edges` to walk, the negation matched everything
   * and reported an estate where nothing is anywhere.
   *
   * The escape hatch this replaces was per-rule: a containment rule could set
   * `viaAttr` and become a real edge. That put the query layer's needs in a
   * field the renderer also reads, and it had to be remembered per rule —
   * `AWS::EC2::Instance -> Subnet` had it and `AWS::EC2::NetworkInterface ->
   * Subnet` did not, which is the kind of gap hand-maintained lists always
   * develop. Deriving them here means a containment rule is traversable because
   * it is a containment rule, not because someone remembered.
   */
  containmentEdges: IREdge[];
  dangling: DanglingRef[];
}

function toStr(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/**
 * Read all scalar values at an attr path. Supports nested keys (`a.b`) and array
 * fan-out (`arr[]`, `arr[].id`). Returns every scalar found — a path through an
 * array yields one value per element.
 */
export function readPath(obj: unknown, path: string): string[] {
  let cur: unknown[] = [obj];
  for (const part of path.split(".")) {
    const isArr = part.endsWith("[]");
    const key = isArr ? part.slice(0, -2) : part;
    const next: unknown[] = [];
    for (const c of cur) {
      if (c == null || typeof c !== "object") continue;
      const val = (c as Record<string, unknown>)[key];
      if (isArr) {
        if (Array.isArray(val)) next.push(...val);
      } else if (val !== undefined) {
        next.push(val);
      }
    }
    cur = next;
  }
  const out: string[] = [];
  for (const c of cur) {
    const s = toStr(c);
    if (s !== undefined) out.push(s);
  }
  return out;
}

/** Merge several lexicons' catalogs into one (concatenate identities + refs). */
export function mergeCatalogs(catalogs: ReferenceCatalog[]): ReferenceCatalog {
  return {
    identities: catalogs.flatMap((c) => c.identities),
    refs: catalogs.flatMap((c) => c.refs),
  };
}

/**
 * Reconstruct edges + containment from live nodes and a catalog. Pure and
 * deterministic. Matching is exact on identifier value; identifier collisions
 * across kinds are disambiguated by `targetKind`. Self-references are dropped.
 */
export function reconstructEdges(nodes: IRNode[], catalog: ReferenceCatalog): ReconstructedEdges {
  // Identity index: identifier value → the node(s) that own it.
  const index = new Map<string, Array<{ id: string; kind: string }>>();
  const add = (value: string, id: string, kind: string) => {
    (index.get(value) ?? index.set(value, []).get(value)!).push({ id, kind });
  };
  for (const node of nodes) {
    // Every node is identified by its own logical id — so references resolved to
    // a logical id (e.g. a CloudFormation `{Ref: LogicalId}` from exportResources,
    // #784) match directly — plus its physical id and any catalog identity attrs.
    add(node.id, node.id, node.kind);
    if (node.physicalId) add(node.physicalId, node.id, node.kind);
    for (const rule of catalog.identities) {
      if (rule.kind !== node.kind) continue;
      for (const p of rule.ids) for (const v of readPath(node.attrs, p)) add(v, node.id, node.kind);
    }
  }

  const edges: IREdge[] = [];
  const containment: ContainmentPair[] = [];
  const containmentEdges: IREdge[] = [];
  const seenContEdge = new Set<string>();
  const dangling: DanglingRef[] = [];
  const seenEdge = new Set<string>();
  const seenCont = new Set<string>();

  for (const node of nodes) {
    for (const rule of catalog.refs) {
      if (rule.from !== node.kind) continue;
      for (const value of readPath(node.attrs, rule.path)) {
        const candidates = index.get(value) ?? [];
        // `chant graph --live` keeps its first-candidate pick: its values are
        // logical ids and physical ids, which name one node. An index refuses
        // the pick instead (reconstructIndexedEdges, #4522).
        const match = rule.targetKind ? candidates.find((c) => c.kind === rule.targetKind) : candidates[0];
        if (!match) {
          dangling.push({ from: node.id, path: rule.path, value, ...(rule.targetKind ? { targetKind: rule.targetKind } : {}) });
          continue;
        }
        if (match.id === node.id) continue; // self-reference (e.g. an SG rule to its own group)
        const pushEdge = (via: string): void => {
          const k = `${node.id}|${match.id}|${via}`;
          if (seenEdge.has(k)) return;
          seenEdge.add(k);
          edges.push({ from: node.id, to: match.id, kind: "ref", viaAttr: via });
        };
        if (rule.relation === "containment") {
          const k = `${node.id}|${match.id}`;
          if (!seenCont.has(k)) {
            seenCont.add(k);
            containment.push({ child: node.id, parent: match.id, ...(rule.label ? { label: rule.label } : {}) });
          }
          // Traversable by construction. The attribute the containment was read
          // through is its traversal name, so `<-attr:` can still discriminate
          // between two ways of being inside something.
          const via = rule.viaAttr ?? rule.path;
          const ke = `${node.id}|${match.id}|${via}`;
          if (!seenContEdge.has(ke)) {
            seenContEdge.add(ke);
            containmentEdges.push({ from: node.id, to: match.id, kind: "ref", viaAttr: via });
          }
          // A containment relation is a boundary hint, not an edge — unless the
          // rule declares a traversal name (#1275). A fold's first hop is
          // sometimes exactly a containment ("an instance is in a subnet"), and
          // it must be traversable without duplicating the rule as a reference
          // and drawing the line twice.
          if (rule.viaAttr) pushEdge(rule.viaAttr);
        } else {
          // Traversal name wins over the rendering label: the labels are
          // human-facing ("sg", "via"), and a fold matches provider attribute
          // names (#1275).
          pushEdge(rule.viaAttr ?? rule.label ?? rule.path);
        }
      }
    }
  }

  edges.sort((a, b) => `${a.from}|${a.to}|${a.viaAttr}`.localeCompare(`${b.from}|${b.to}|${b.viaAttr}`));
  containmentEdges.sort((a, b) => `${a.from}|${a.to}|${a.viaAttr}`.localeCompare(`${b.from}|${b.to}|${b.viaAttr}`));
  containment.sort((a, b) => `${a.child}|${a.parent}`.localeCompare(`${b.child}|${b.parent}`));
  dangling.sort((a, b) => `${a.from}|${a.path}|${a.value}`.localeCompare(`${b.from}|${b.path}|${b.value}`));

  return { edges, containment, containmentEdges, dangling };
}

/**
 * Invert containment pairs into grouping metadata (#779): container node id → the
 * node ids directly inside it. The result is the `IRGroups.byContainer` shape a
 * renderer draws as boundary boxes. It represents the full nesting *flatly* — a
 * subnet is both a member of its VPC's entry and a key with its own members —
 * so a boundary-box renderer recurses it (VPC ⊃ subnet ⊃ resources). Sorted for
 * determinism.
 */
export function containmentGroups(pairs: ContainmentPair[]): Record<string, string[]> {
  const byParent = new Map<string, Set<string>>();
  for (const { child, parent } of pairs) {
    (byParent.get(parent) ?? byParent.set(parent, new Set()).get(parent)!).add(child);
  }
  const out: Record<string, string[]> = {};
  for (const parent of [...byParent.keys()].sort()) out[parent] = [...byParent.get(parent)!].sort();
  return out;
}

// ── Indexed nodes (#4522) ────────────────────────────────────────────────────

/** One lexicon's catalog, named, so a derived edge can say which rule made it. */
export interface NamedCatalog {
  lexicon: string;
  catalog: ReferenceCatalog;
}

/**
 * Where an indexed node's identifiers are unique (INTENTIUS/behold#1023 Q2):
 * its substrate and account, subscription, project or cluster, plus its
 * region for a regional type. A global type (IAM, Route 53, CloudFront) has
 * no region, and is matched by account only.
 */
export interface IndexedNodeScope {
  /** `<substrate>/<scopeId>`. */
  account: string;
  /** The region or location; undefined for a global type. */
  region?: string;
}

/** A reference whose value matched several nodes: no edge is drawn (behold#1023 Q3). */
export interface AmbiguousRef {
  from: string;
  rule: string;
  path: string;
  value: string;
  /** Every node the value matched, sorted. */
  candidates: string[];
}

/** A reference whose target is not in the index, with the rule that read it. */
export interface IndexedDanglingRef extends DanglingRef {
  rule: string;
}

export interface IndexedEdges {
  /** Reference and containment edges, each `origin: "derived"` with its `rule`. */
  edges: IREdge[];
  containment: ContainmentPair[];
  dangling: IndexedDanglingRef[];
  ambiguous: AmbiguousRef[];
}

/** Values a masking or normalization pass wrote: never an identifier. */
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set(["[REDACTED]", "<chant:unresolved>", "<masked>"]);

/** The attribute a rule reads through, as a declared graph's `viaAttr` names it: `SecurityGroupIds[]` is `SecurityGroupIds`. */
function topAttr(path: string): string {
  const first = path.split(".")[0];
  return first.endsWith("[]") ? first.slice(0, -2) : first;
}

/** `<lexicon>:<from kind>:<path>`, the id a derived edge carries. */
export function refRuleId(lexicon: string, from: string, path: string): string {
  return `${lexicon}:${from}:${path}`;
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Derive edges over indexed nodes (#4522) with each lexicon's catalog, under
 * the rules ruled on INTENTIUS/behold#1023:
 *
 * - the join key is the scoped value: a reference on a node in region R
 *   matches nodes of the same account in R, and global nodes of the same
 *   account; a reference on a global node matches global nodes only;
 * - a rule's target kind is `targetKind`, else `indexedTargetKind`;
 * - a value that matches more than one node draws no edge and is returned in
 *   `ambiguous` with every candidate, in place of {@link reconstructEdges}'
 *   first-candidate pick, so two reads of one account in another node order
 *   give the same edges;
 * - tags make edges only through a catalog's typed `tagRefs`.
 *
 * A node is matched by its id, physical id, native id, cloud ids, and the
 * catalog's identity paths. Rules apply to nodes of their own lexicon. Pure.
 */
export function reconstructIndexedEdges(
  nodes: readonly IRNode[],
  catalogs: readonly NamedCatalog[],
  scopeOf: (node: IRNode) => IndexedNodeScope,
): IndexedEdges {
  const sorted = [...nodes].sort((a, b) => byString(a.id, b.id));
  const keyOf = (scope: IndexedNodeScope, value: string) => `${scope.account}\u0000${scope.region ?? ""}\u0000${value}`;
  const index = new Map<string, Map<string, string>>();
  const add = (scope: IndexedNodeScope, value: string | undefined, node: IRNode): void => {
    if (value === undefined || value === "" || PLACEHOLDER_VALUES.has(value)) return;
    const k = keyOf(scope, value);
    (index.get(k) ?? index.set(k, new Map()).get(k)!).set(node.id, node.kind);
  };
  const identities = catalogs.flatMap((c) => c.catalog.identities);
  for (const node of sorted) {
    const scope = scopeOf(node);
    add(scope, node.id, node);
    add(scope, node.physicalId, node);
    add(scope, node.nativeId, node);
    for (const c of node.facts?.cloudIds ?? []) add(scope, c.value, node);
    for (const rule of identities) {
      if (rule.kind !== node.kind) continue;
      for (const p of rule.ids) for (const v of readPath(node.attrs, p)) add(scope, v, node);
    }
  }

  const lookup = (holder: IRNode, value: string): Map<string, string> => {
    const scope = scopeOf(holder);
    const out = new Map<string, string>();
    const keys = scope.region !== undefined ? [keyOf(scope, value), keyOf({ account: scope.account }, value)] : [keyOf(scope, value)];
    for (const k of keys) for (const [id, kind] of index.get(k) ?? []) out.set(id, kind);
    return out;
  };

  const edges = new Map<string, IREdge>();
  const containment = new Map<string, ContainmentPair>();
  // Keyed by holder, rule and value: two rules with one id (the describe-shape
  // and template-shape rules for the same path) report a reference once.
  const dangling = new Map<string, IndexedDanglingRef>();
  const ambiguous = new Map<string, AmbiguousRef>();

  const resolve = (
    holder: IRNode,
    value: string,
    rule: { id: string; path: string; targetKind?: string; relation: "reference" | "containment"; via: string; label?: string },
  ): void => {
    if (PLACEHOLDER_VALUES.has(value)) return;
    const found = lookup(holder, value);
    let candidates = [...found.entries()].filter(([, kind]) => rule.targetKind === undefined || kind === rule.targetKind).map(([id]) => id);
    if (candidates.includes(holder.id)) {
      if (candidates.length === 1) return; // a self-reference (an SG rule to its own group)
      candidates = candidates.filter((id) => id !== holder.id);
    }
    candidates.sort(byString);
    if (candidates.length === 0) {
      dangling.set(`${holder.id}|${rule.id}|${value}`, { from: holder.id, path: rule.path, value, rule: rule.id, ...(rule.targetKind ? { targetKind: rule.targetKind } : {}) });
      return;
    }
    if (candidates.length > 1) {
      ambiguous.set(`${holder.id}|${rule.id}|${value}`, { from: holder.id, rule: rule.id, path: rule.path, value, candidates });
      return;
    }
    const to = candidates[0];
    const key = `${holder.id}|${to}|${rule.via}|${rule.relation}`;
    const prev = edges.get(key);
    // Two rules can draw one edge (the describe-shape and template-shape rules
    // read the same attribute); the smaller rule id is kept, so the result
    // does not depend on catalog order.
    if (!prev || byString(rule.id, prev.rule!) < 0) {
      edges.set(key, {
        from: holder.id,
        to,
        kind: "ref",
        viaAttr: rule.via,
        grain: "property",
        origin: "derived",
        rule: rule.id,
        relation: rule.relation,
      });
    }
    if (rule.relation === "containment") {
      const ck = `${holder.id}|${to}`;
      const prevPair = containment.get(ck);
      if (!prevPair || (rule.label !== undefined && (prevPair.label === undefined || byString(rule.label, prevPair.label) < 0))) {
        containment.set(ck, { child: holder.id, parent: to, ...(rule.label ? { label: rule.label } : {}) });
      }
    }
  };

  for (const node of sorted) {
    for (const { lexicon, catalog } of catalogs) {
      if (node.lexicon !== lexicon) continue;
      for (const rule of catalog.refs) {
        if (rule.from !== node.kind) continue;
        const spec = {
          id: refRuleId(lexicon, rule.from, rule.path),
          path: rule.path,
          targetKind: rule.targetKind ?? rule.indexedTargetKind,
          relation: rule.relation,
          via: rule.viaAttr ?? topAttr(rule.path),
          ...(rule.label ? { label: rule.label } : {}),
        };
        for (const value of new Set(readPath(node.attrs, rule.path))) resolve(node, value, spec);
      }
      for (const rule of catalog.tagRefs ?? []) {
        if (rule.from !== undefined && rule.from !== node.kind) continue;
        const tags = node.tags ?? {};
        const spec = {
          id: refRuleId(lexicon, rule.from ?? node.kind, `tag:${rule.key}`),
          path: `tag:${rule.key}`,
          targetKind: rule.targetKind,
          relation: "reference" as const,
          via: "Tags",
          ...(rule.label ? { label: rule.label } : {}),
        };
        if (rule.read === "value") {
          const v = tags[rule.key];
          if (typeof v === "string" && v !== "") resolve(node, v, spec);
        } else {
          for (const k of Object.keys(tags).sort()) {
            if (k.startsWith(rule.key) && k.length > rule.key.length) resolve(node, k.slice(rule.key.length), spec);
          }
        }
      }
    }
  }

  const edgeKey = (e: IREdge) => `${e.from}|${e.to}|${e.viaAttr ?? ""}|${e.relation ?? ""}`;
  return {
    edges: [...edges.values()].sort((a, b) => byString(edgeKey(a), edgeKey(b))),
    containment: [...containment.values()].sort((a, b) => byString(`${a.child}|${a.parent}`, `${b.child}|${b.parent}`)),
    dangling: [...dangling.values()].sort((a, b) => byString(`${a.from}|${a.rule}|${a.value}`, `${b.from}|${b.rule}|${b.value}`)),
    ambiguous: [...ambiguous.values()].sort((a, b) => byString(`${a.from}|${a.rule}|${a.value}`, `${b.from}|${b.rule}|${b.value}`)),
  };
}

// ── Identity matches over indexed nodes (#4523) ──────────────────────────────

/** One value that names an indexed node: its native id, or one of its cloud ids. */
export interface NodeIdentityValue {
  /** `native-id`, or the cloud id's kind (`arn`, `provider-id`, ...). */
  kind: string;
  value: string;
}

/** The lexicon whose nodes can be identity-matched, and the values that name each one. */
export interface IdentityOwners {
  lexicon: string;
  /** The values that name a node of this lexicon. Absent: its native id and its ARN cloud ids. */
  identities?(node: IRNode): NodeIdentityValue[];
}

/** A value that named several nodes: no identity-match edge is drawn (behold#1023 Q3). */
export interface AmbiguousIdentityRef {
  from: string;
  path: string;
  value: string;
  /** Every node the value named, sorted. */
  candidates: string[];
}

export interface IdentityEdges {
  /** Each `origin: "derived"`, `rule: "identity-match:..."`. */
  edges: IREdge[];
  ambiguous: AmbiguousIdentityRef[];
}

/** The label every edge of the identity pass carries, as the prefix of its `rule`. */
export const IDENTITY_MATCH_RULE = "identity-match";

/** `identity-match:<owner lexicon>:<owner kind>:<identity kind>`. */
export function identityMatchRuleId(lexicon: string, kind: string, identityKind: string): string {
  return `${IDENTITY_MATCH_RULE}:${lexicon}:${kind}:${identityKind}`;
}

/** The default identities of an indexed node: the native id, and any ARN among its cloud ids. */
export function defaultNodeIdentities(node: IRNode): NodeIdentityValue[] {
  const out: NodeIdentityValue[] = [];
  if (node.nativeId) out.push({ kind: "native-id", value: node.nativeId });
  for (const c of node.facts?.cloudIds ?? []) if (c.kind === "arn") out.push({ kind: "arn", value: c.value });
  return out;
}

/** Top-level keys whose values the identity pass never reads: tags make edges only through typed rules (behold#1023 Q5). */
const IDENTITY_SKIPPED_KEYS: ReadonlySet<string> = new Set(["Tags", "tags", "TagSet", "labels", "Labels"]);

/** Short values are names anything can carry (`default`, `app`); whitespace means prose, not an identifier. */
const MIN_IDENTITY_VALUE = 6;
const MAX_IDENTITY_VALUE = 2048;

function identityCandidateValue(v: string): boolean {
  return v.length >= MIN_IDENTITY_VALUE && v.length <= MAX_IDENTITY_VALUE && !/\s/.test(v) && !PLACEHOLDER_VALUES.has(v);
}

/** Every string leaf under `attrs` with its path (`a.b`, `arr[].c`), skipping tag subtrees. */
function stringLeaves(attrs: Record<string, unknown>): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      out.push({ path, value: v });
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, `${path}[]`);
    } else if (v && typeof v === "object") {
      for (const k of Object.keys(v as Record<string, unknown>).sort()) walk((v as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
    }
  };
  for (const k of Object.keys(attrs).sort()) {
    if (IDENTITY_SKIPPED_KEYS.has(k)) continue;
    walk(attrs[k], k);
  }
  return out;
}

/**
 * The identity-match pass (#4523, ruled on INTENTIUS/behold#1023 Q1-Q3): the
 * second pass over indexed nodes, after {@link reconstructIndexedEdges}. A
 * string attribute on one node equal to a value that names another node (its
 * native id, which for aws is the CloudFormation `primaryIdentifier`, or its
 * ARN) draws an edge labelled `identity-match`:
 *
 * - only nodes of a lexicon in `owners` are named; holders are any node;
 * - the join key is the scoped value, as in the catalog pass: a holder in
 *   region R reaches nodes of its account in R and global nodes of its
 *   account; a global holder reaches global nodes only;
 * - a value naming more than one node draws no edge and is returned in
 *   `ambiguous` with every candidate;
 * - tag subtrees are never read, values under {@link MIN_IDENTITY_VALUE}
 *   characters or with whitespace are skipped, and a value naming the holder
 *   itself is not a reference;
 * - a pair the catalog pass already joined (`existing`) gets no second edge.
 *
 * Pure, and independent of node order.
 */
export function reconstructIdentityEdges(
  nodes: readonly IRNode[],
  owners: readonly IdentityOwners[],
  scopeOf: (node: IRNode) => IndexedNodeScope,
  existing: readonly IREdge[] = [],
): IdentityEdges {
  const sorted = [...nodes].sort((a, b) => byString(a.id, b.id));
  const ownerBy = new Map(owners.map((o) => [o.lexicon, o]));
  const keyOf = (scope: IndexedNodeScope, value: string) => `${scope.account}\u0000${scope.region ?? ""}\u0000${value}`;
  // key -> node id -> the rule that names it
  const index = new Map<string, Map<string, string>>();
  const own = new Map<string, Set<string>>();
  for (const node of sorted) {
    const owner = ownerBy.get(node.lexicon);
    if (!owner || node.unmappedKind) continue;
    const scope = scopeOf(node);
    const values = (owner.identities ?? defaultNodeIdentities)(node);
    own.set(node.id, new Set(values.map((v) => v.value)));
    for (const { kind, value } of values) {
      if (!identityCandidateValue(value)) continue;
      const k = keyOf(scope, value);
      const m = index.get(k) ?? index.set(k, new Map()).get(k)!;
      const rule = identityMatchRuleId(owner.lexicon, node.kind, kind);
      const prev = m.get(node.id);
      if (prev === undefined || byString(rule, prev) < 0) m.set(node.id, rule);
    }
  }

  const joined = new Set(existing.map((e) => `${e.from}|${e.to}`));
  const edges = new Map<string, IREdge>();
  const ambiguous = new Map<string, AmbiguousIdentityRef>();

  for (const holder of sorted) {
    const scope = scopeOf(holder);
    const keys = scope.region !== undefined ? (v: string) => [keyOf(scope, v), keyOf({ account: scope.account }, v)] : (v: string) => [keyOf(scope, v)];
    const mine = own.get(holder.id) ?? new Set<string>([holder.nativeId ?? "", holder.physicalId ?? ""]);
    for (const { path, value } of stringLeaves(holder.attrs ?? {})) {
      if (!identityCandidateValue(value) || mine.has(value)) continue;
      const found = new Map<string, string>();
      for (const k of keys(value)) for (const [id, rule] of index.get(k) ?? []) if (id !== holder.id) found.set(id, rule);
      if (found.size === 0) continue;
      if (found.size > 1) {
        ambiguous.set(`${holder.id}|${path}|${value}`, { from: holder.id, path, value, candidates: [...found.keys()].sort(byString) });
        continue;
      }
      const [[to, rule]] = [...found.entries()];
      if (joined.has(`${holder.id}|${to}`)) continue;
      const via = topAttr(path);
      const key = `${holder.id}|${to}|${via}`;
      const prev = edges.get(key);
      if (!prev || byString(rule, prev.rule!) < 0) {
        edges.set(key, { from: holder.id, to, kind: "ref", viaAttr: via, grain: "property", origin: "derived", rule, relation: "reference" });
      }
    }
  }

  const edgeKey = (e: IREdge) => `${e.from}|${e.to}|${e.viaAttr ?? ""}`;
  return {
    edges: [...edges.values()].sort((a, b) => byString(edgeKey(a), edgeKey(b))),
    ambiguous: [...ambiguous.values()].sort((a, b) => byString(`${a.from}|${a.path}|${a.value}`, `${b.from}|${b.path}|${b.value}`)),
  };
}
