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
import { NEXT_RELEASE } from "./release-floors";

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
  /**
   * The path holds a reference only sometimes (#4535): an env var's value, a
   * selector's label, a binding subject that may be a user. A value that
   * names no node of the rule's kind is then not reported as dangling, since
   * most such values are not references at all, and a path read by several
   * rules (one per target kind) would otherwise report every value matched by
   * one rule as dangling under the others. A match is still a typed, scoped
   * match, and two candidates still draw no edge.
   */
  optional?: boolean;
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
  /**
   * Reads the references itself, for a rule whose value does not name its
   * target by one identifier (#5098): an ExternalSecret's key names a cloud
   * secret only inside the project of the store it reads through, so the
   * match spans the holder, a second node and the target. `path` and
   * `targetKind` still name the rule (its id, its entry in a document's
   * `catalog.rules`, the kind a dangling entry looks for), but the pass does
   * not read `path` itself: it calls `join` with the holder and `find`, which
   * returns the nodes a value names from the holder's scope, the way the
   * pass's own lookup would. Each {@link JoinedRef} it returns is then
   * resolved like a value read from `path`: no target is dangling (unless
   * `optional`), two are ambiguous, one is an edge. Only the catalog pass
   * over indexed nodes and declared graphs calls it. Pure.
   */
  join?(holder: IRNode, find: FindNodes): JoinedRef[];
}

/**
 * What a {@link RefRule.join} looks nodes up with. `find(value)` returns the
 * nodes `value` names from the holder's own scope. `find(value, scope)`
 * returns those named inside the scope called `scope` (a Kubernetes
 * namespace), whatever scope the holder sits in, for a holder that names its
 * target's namespace itself (#5099): a cloud IAM binding naming
 * `<ns>/<name>`.
 */
export type FindNodes = (value: string, scope?: string) => readonly IRNode[];

/** One reference a {@link RefRule.join} found on a holder. */
export interface JoinedRef {
  /** What the holder wrote, as a dangling or ambiguous entry reports it. */
  value: string;
  /** The nodes it names, from `find`; none is dangling. */
  targets: readonly IRNode[];
  /** The edge's `viaAttr`, when the first step of the rule's path does not say enough. */
  via?: string;
  /** A node the value was read through, named on a dangling entry (the store a key is read from). */
  through?: IRNode;
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

/**
 * A kind whose names are unique only inside a scope the node names itself
 * (#5097): a namespaced Kubernetes kind, whose scope is the value at
 * `metadata.namespace`. Read on a declared graph, where nothing else says
 * where a node sits. Over an index the node's location says it instead.
 */
export interface ScopeRule {
  kind: string;
  /**
   * The attr path whose value names the scope. With none (#5100), the kind's
   * names are unique inside the member that holds the node, which is what a
   * namespaced kind with no namespace on the node gets.
   */
  path?: string;
}

/**
 * What the catalog pass on a declared graph reads for one node, when the
 * node as printed is not what the rules are written against (#5097). A
 * declared terraform block is `Terraform::Resource` with its arguments under
 * `body`; its view has the provider type as `kind` and the literal arguments
 * as `attrs`.
 */
export interface DeclaredCatalogNode {
  kind: string;
  attrs: Record<string, unknown>;
  /** Arguments left out of `attrs` because their value is not literal (an interpolation, a reference). */
  nonLiteral: number;
}

/**
 * A node a lexicon adds to a declared workspace graph because several members
 * name the same thing (#5100): one Helm chart that a kustomization, an Argo CD
 * Application and a Terraform `helm_release` all name is one node, owned by
 * none of them. The catalog pass draws an edge to it from each holder.
 */
export interface SharedCatalogNode {
  /** The node's own id; the pass places it as `<member>/<id>`, in the member of its first holder. */
  id: string;
  kind: string;
  attrs: Record<string, unknown>;
  /** The nodes that name it, by the id the pass read them under, with the attribute each reads it through. */
  holders: Array<{ from: string; via: string; label?: string }>;
}

/** A lexicon's reference knowledge — its identity map and reference rules. */
export interface ReferenceCatalog {
  identities: IdentityRule[];
  refs: RefRule[];
  /** Typed tag rules, used over indexed nodes only (#4522). */
  tagRefs?: TagRefRule[];
  /**
   * How this lexicon's ids are unique in an index (#5286). `regionless`: an id
   * is unique in the whole account, so a node with no location, or in any
   * location, joins with every node of its account (an ARM id names its
   * subscription). `caseInsensitive`: two ids that differ only in case are one
   * (ARM compares ids that way). Over an index only.
   */
  indexIds?: { regionless?: boolean; caseInsensitive?: boolean };
  /** Kinds whose names are scoped by a value on the node, on a declared graph (#5097). */
  scopes?: ScopeRule[];
  /**
   * The node the catalog reads for a declared node of this lexicon, or
   * undefined to read the node as it is (#5097). An instance node
   * (`instanceOf`) carries no attrs of its own, so it is handed its block
   * node as `block` (#5117). Pure.
   */
  declaredNode?(node: IRNode, block?: IRNode): DeclaredCatalogNode | undefined;
  /**
   * True for a node of this lexicon that registers a cluster, the one a
   * workspace member runs on (an Argo CD cluster Secret, #5101). A member's
   * `runsOn` draws a declared edge from each such node to the cluster
   * resource it names. Reads the node as the document holds it. Pure.
   */
  registersCluster?(node: IRNode): boolean;
  /**
   * Nodes of this catalog's lexicon that the declared graph has none of until
   * every member is read (#5100), each with the nodes that name it. Called with
   * every node the pass reads, after `declaredNode`. Pure. An edge from a holder
   * carries the rule id `<lexicon>:<holder kind>:<via>`.
   */
  sharedNodes?(nodes: readonly IRNode[]): SharedCatalogNode[];
  /** Nodes a node of this lexicon makes, on a declared graph (#5102): the Applications an ApplicationSet generates. */
  generates?: GenerateRule[];
  /** Paths in the repository a node of this lexicon names, on a declared graph (#5102): an Application's source path. */
  pathRefs?: PathRule[];
}

/**
 * A node that stands for several the system it declares will make (#5102):
 * an Argo CD ApplicationSet, whose generators yield parameter sets that its
 * template turns into Applications. `from`, `path`, `targetKind` and `label`
 * name the rule as a {@link RefRule}'s do, and the edge from the holder to
 * each node it makes carries its id. `generate` is handed the holder and
 * every node the pass reads (as `declaredNode` gives them), so a generator
 * can select from nodes of any member. Only the catalog pass over a declared
 * graph calls it. Pure.
 */
export interface GenerateRule {
  from: string;
  path: string;
  targetKind: string;
  label?: string;
  generate(holder: IRNode, nodes: readonly IRNode[]): Generated;
  /**
   * The rule of the edge from a generated node to the cluster registration
   * its generator selected it for ({@link GeneratedNode.cluster}): its id is
   * `<lexicon>:<from>:<path>`. The selection names the registration, so the
   * edge is drawn whatever the node's own references say, and an edge another
   * rule draws for the same pair is left out.
   */
  cluster?: { path: string; targetKind: string; label?: string };
  /**
   * The nodes the files a generated node names make (#5094): a generated
   * Application's Helm values file and the objects under its `extraObjects`,
   * as the reader makes them for one written by hand. `readFile` returns a
   * workspace-relative file's text, or undefined when it is not in the
   * workspace's repository; `nodes` are every node the pass reads, so a file
   * a node already holds is not read twice. The pass gives each the id
   * `<holder id>/<key>`, so one file named by several of a holder's
   * generated nodes is one node. Only the catalog pass over a declared graph
   * calls it, and only when its caller can read the repository.
   */
  files?(node: IRNode, readFile: (path: string) => string | undefined, nodes: readonly IRNode[]): FileNode[];
}

/** One node a {@link GenerateRule.files} read from a file. */
export interface FileNode {
  /** Unique among the holder's file nodes: `values/<path>`, and `values/<path>/<object>` for an object in it. */
  key: string;
  kind: string;
  /** The lexicon whose node it is: a values file is the helm lexicon's, the objects in it the holder's. */
  lexicon: string;
  attrs: Record<string, unknown>;
}

/** What a {@link GenerateRule} made of one holder. */
export interface Generated {
  nodes: GeneratedNode[];
  /** What the rule left unexpanded and why, one line each: a generator it does not read, a template function it does not know. */
  notExpanded: string[];
}

/**
 * One node a {@link GenerateRule} made. The pass gives it the id
 * `<holder id>/<key>`, the holder's lexicon and member, and reads it with the
 * other nodes, so the catalog's rules join it as they join a declared node
 * of its kind.
 */
export interface GeneratedNode {
  /** Unique among the holder's nodes: a generated Application's name. */
  key: string;
  kind: string;
  attrs: Record<string, unknown>;
  /** The generator that yielded it, such as `clusters` or `list`. */
  generator: string;
  /** The parameters it was made with, flattened to `a.b.c` keys. */
  params: Record<string, string>;
  /** With a generator that reads cluster registrations: the node it was made for, when there is one. */
  cluster?: IRNode;
}

/**
 * A path in a repository that a node names (#5102): an Argo CD Application's
 * `spec.source.path`, a values file. `from` and `path` name the rule as a
 * {@link RefRule}'s do. `read` returns each path the holder names; the pass
 * looks for it in the workspace's repository and reports one that is not
 * there as dangling. Pure.
 */
export interface PathRule {
  from: string;
  path: string;
  label?: string;
  read(holder: IRNode): RepoPathRef[];
}

/** One path a {@link PathRule} read. */
export interface RepoPathRef {
  /** The path from the repository's root, as the holder resolves it. */
  value: string;
  /** The repository the path is in, as the holder writes it (`repoURL`). */
  repo: string;
  /** Whether the path names a directory or a file. */
  type: "dir" | "file";
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
  /** The id of the node the value was read through (#5098): the store whose cloud secret a key names. */
  through?: string;
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

/** One step of an attr path: a key, and whether the value under it fans out as an array. */
export interface PathStep {
  key: string;
  fanOut: boolean;
}

/** Catalog paths, parsed once: a catalog is a fixed list, so this stays small. */
const parsedPaths = new Map<string, PathStep[]>();

/** The index of the closing quote of the quoted key opened at `i`, when `"]` closes it and it parses as JSON. */
function quotedEnd(path: string, i: number): number | undefined {
  let j = i + 2;
  while (j < path.length && path[j] !== '"') j += path[j] === "\\" ? 2 : 1;
  if (path[j] !== '"' || path[j + 1] !== "]") return undefined;
  try {
    return typeof JSON.parse(path.slice(i + 1, j + 1)) === "string" ? j : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Split an attr path into its steps. A bare step runs to the next `.`, `[]`
 * or quoted step; `[]` after a step fans it out over an array. A quoted step,
 * `["iam.gke.io/gcp-service-account"]`, is one key whatever it holds (#5097):
 * a JSON string in brackets, so `\"` and `\\` escape as they do in JSON. It
 * follows the step before it with no `.`, and can fan out too (`["a.b"][]`).
 */
export function parsePath(path: string): PathStep[] {
  const steps: PathStep[] = [];
  let bare = "";
  let inBare = false;
  const endBare = (): void => {
    if (inBare) steps.push({ key: bare, fanOut: false });
    bare = "";
    inBare = false;
  };
  let i = 0;
  while (i < path.length) {
    const c = path[i];
    if (c === ".") {
      endBare();
      i++;
    } else if (c === "[" && path[i + 1] === "]") {
      endBare();
      if (steps.length > 0) steps[steps.length - 1].fanOut = true;
      else steps.push({ key: "", fanOut: true });
      i += 2;
    } else if (c === "[" && path[i + 1] === '"' && quotedEnd(path, i) !== undefined) {
      endBare();
      const j = quotedEnd(path, i)!;
      steps.push({ key: JSON.parse(path.slice(i + 1, j + 1)) as string, fanOut: false });
      i = j + 2;
    } else {
      bare += c;
      inBare = true;
      i++;
    }
  }
  endBare();
  return steps;
}

/**
 * Read all scalar values at an attr path. Supports nested keys (`a.b`), array
 * fan-out (`arr[]`, `arr[].id`) and quoted keys for a key that holds dots or
 * slashes (`metadata.annotations["eks.amazonaws.com/role-arn"]`, #5097).
 * Returns every scalar found: a path through an array yields one value per
 * element.
 */
export function readPath(obj: unknown, path: string): string[] {
  let steps = parsedPaths.get(path);
  if (!steps) parsedPaths.set(path, (steps = parsePath(path)));
  let cur: unknown[] = [obj];
  for (const { key, fanOut } of steps) {
    const next: unknown[] = [];
    for (const c of cur) {
      if (c == null || typeof c !== "object") continue;
      const val = (c as Record<string, unknown>)[key];
      if (fanOut) {
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
      if (rule.from !== node.kind || rule.join) continue;
      for (const value of readPath(node.attrs, rule.path)) {
        const candidates = index.get(value) ?? [];
        // `chant graph --live` keeps its first-candidate pick: its values are
        // logical ids and physical ids, which name one node. An index refuses
        // the pick instead (reconstructIndexedEdges, #4522).
        const match = rule.targetKind ? candidates.find((c) => c.kind === rule.targetKind) : candidates[0];
        if (!match) {
          if (rule.optional) continue;
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
  /**
   * Other lexicon names whose nodes this catalog also reads (#5340). A
   * choudoufu roster node carries `lexicon: "choudoufu"` and the provider
   * type as its `kind`, so `{ lexicon: "terraform", catalog, aliases: ["choudoufu"] }`
   * applies the terraform catalog to it. A derived edge keeps the catalog's
   * own lexicon in its `rule` (`terraform:aws_db_instance:db_subnet_group_name`).
   */
  aliases?: readonly string[];
}

/**
 * The first chant whose reference passes take a lexicon alias (#5340):
 * `NamedCatalog.aliases` and `IdentityOwners.aliases` read nodes of another
 * lexicon name with one lexicon's catalog, so `runCatalogPass`
 * (`@intentius/chant/workspace/catalog-edges`), `reconstructIndexedEdges` and
 * `reconstructIdentityEdges` apply the terraform catalog to choudoufu roster
 * nodes.
 */
export const GRAPH_REFS_LEXICON_ALIAS_FLOOR = NEXT_RELEASE;

/** True when a catalog (or identity owner) reads nodes of `lexicon`: its own name or an alias. */
export function readsLexicon(c: { lexicon: string; aliases?: readonly string[] }, lexicon: string): boolean {
  return c.lexicon === lexicon || (c.aliases?.includes(lexicon) ?? false);
}

/** Catalogs by every lexicon name they read; an own name wins over another catalog's alias. */
export function catalogsByLexicon(catalogs: readonly NamedCatalog[]): Map<string, ReferenceCatalog> {
  const out = new Map<string, ReferenceCatalog>();
  for (const c of catalogs) for (const a of c.aliases ?? []) if (!out.has(a)) out.set(a, c.catalog);
  for (const c of catalogs) out.set(c.lexicon, c.catalog);
  return out;
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
  /**
   * The member that holds the node, on a declared graph (#5100). A holder also
   * looks in {@link memberRegion} of its own member, whatever its own region, so
   * a node that names no scope but its member (a values file) is reached by a
   * holder scoped by namespace.
   */
  member?: string;
  /** Compare values case-insensitively in this scope (#5286). */
  foldCase?: boolean;
}

/** The region of a node held by one member (a `ScopeRule` with no `path`). */
export const memberRegion = (member: string): string => `member:${member}`;

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
  return parsePath(path)[0]?.key ?? path;
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
  const keyOf = (scope: IndexedNodeScope, value: string) => `${scope.account}\u0000${scope.region ?? ""}\u0000${scope.foldCase ? value.toLowerCase() : value}`;
  const index = new Map<string, Map<string, string>>();
  // The same nodes by the name of the scope they sit in (the text after the
  // first `:` of a region), for a join that names a scope itself.
  const named = new Map<string, Map<string, string>>();
  const add = (scope: IndexedNodeScope, value: string | undefined, node: IRNode): void => {
    if (value === undefined || value === "" || PLACEHOLDER_VALUES.has(value)) return;
    const k = keyOf(scope, value);
    (index.get(k) ?? index.set(k, new Map()).get(k)!).set(node.id, node.kind);
    const colon = scope.region?.indexOf(":") ?? -1;
    if (scope.region !== undefined && colon > 0) {
      const nk = `${scope.region.slice(colon + 1)}\u0000${value}`;
      (named.get(nk) ?? named.set(nk, new Map()).get(nk)!).set(node.id, node.kind);
    }
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

  const byId = new Map(sorted.map((n) => [n.id, n]));
  const lookup = (holder: IRNode, value: string): Map<string, string> => {
    const scope = scopeOf(holder);
    const out = new Map<string, string>();
    const keys = scope.region !== undefined ? [keyOf(scope, value), keyOf({ account: scope.account }, value)] : [keyOf(scope, value)];
    if (scope.member !== undefined) keys.push(keyOf({ account: scope.account, region: memberRegion(scope.member) }, value));
    for (const k of keys) for (const [id, kind] of index.get(k) ?? []) out.set(id, kind);
    return out;
  };

  const edges = new Map<string, IREdge>();
  const containment = new Map<string, ContainmentPair>();
  // Keyed by holder, rule and value: two rules with one id (the describe-shape
  // and template-shape rules for the same path) report a reference once.
  const dangling = new Map<string, IndexedDanglingRef>();
  const ambiguous = new Map<string, AmbiguousRef>();
  // A value some rule of an id found a node for. Rules of one id and different
  // target kinds are alternatives (a cluster Secret's name is a GKE, an EKS or
  // an AKS cluster), so the kinds that found nothing do not report it dangling.
  const found = new Set<string>();

  const resolve = (
    holder: IRNode,
    value: string,
    rule: { id: string; path: string; targetKind?: string; relation: "reference" | "containment"; via: string; label?: string; optional?: boolean },
    joined?: { targets: readonly IRNode[]; through?: IRNode },
  ): void => {
    if (PLACEHOLDER_VALUES.has(value)) return;
    let candidates = joined
      ? joined.targets.map((t) => t.id)
      : [...lookup(holder, value).entries()].filter(([, kind]) => rule.targetKind === undefined || kind === rule.targetKind).map(([id]) => id);
    const through = joined?.through ? { through: joined.through.id } : {};
    if (candidates.includes(holder.id)) {
      if (candidates.length === 1) return; // a self-reference (an SG rule to its own group)
      candidates = candidates.filter((id) => id !== holder.id);
    }
    candidates.sort(byString);
    if (candidates.length === 0) {
      if (rule.optional) return;
      dangling.set(`${holder.id}|${rule.id}|${value}|${through.through ?? ""}`, { from: holder.id, path: rule.path, value, rule: rule.id, ...(rule.targetKind ? { targetKind: rule.targetKind } : {}), ...through });
      return;
    }
    found.add(`${holder.id}|${rule.id}|${value}`);
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
    for (const nc of catalogs) {
      const { lexicon, catalog } = nc;
      if (!readsLexicon(nc, node.lexicon)) continue;
      for (const rule of catalog.refs) {
        // `from: "*"` is a rule that reads every node of the lexicon (#5286); its `join` picks the nodes.
        if (rule.from !== node.kind && !(rule.from === "*" && rule.join)) continue;
        const spec = {
          id: refRuleId(lexicon, rule.from, rule.path),
          path: rule.path,
          targetKind: rule.targetKind ?? rule.indexedTargetKind,
          relation: rule.relation,
          via: rule.viaAttr ?? topAttr(rule.path),
          ...(rule.label ? { label: rule.label } : {}),
          ...(rule.optional ? { optional: true } : {}),
        };
        if (rule.join) {
          const find: FindNodes = (value, scope) => {
            if (scope === undefined) return [...lookup(node, value).keys()].map((id) => byId.get(id)!);
            // Over an index a namespace is the whole region (a node's location), so the holder's account and that region name the scope too (#5284).
            const ids = new Map([...(named.get(`${scope}\u0000${value}`) ?? []), ...(index.get(keyOf({ account: scopeOf(node).account, region: scope }, value)) ?? [])]);
            return [...ids.keys()].map((id) => byId.get(id)!);
          };
          for (const j of rule.join(node, find)) resolve(node, j.value, { ...spec, via: j.via ?? spec.via }, j);
          continue;
        }
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
    dangling: [...dangling.values()].filter((d) => !found.has(`${d.from}|${d.rule}|${d.value}`)).sort((a, b) => byString(`${a.from}|${a.rule}|${a.value}|${a.through ?? ""}`, `${b.from}|${b.rule}|${b.value}|${b.through ?? ""}`)),
    ambiguous: [...ambiguous.values()].sort((a, b) => byString(`${a.from}|${a.rule}|${a.value}`, `${b.from}|${b.rule}|${b.value}`)),
  };
}

// ── Identity matches over indexed nodes (#4523) ──────────────────────────────

/** One value that names an indexed node: its native id, or one of its cloud ids. */
export interface NodeIdentityValue {
  /** `native-id`, or the cloud id's kind (`arn`, `provider-id`, ...). */
  kind: string;
  value: string;
  /**
   * The attribute paths this value names the node at (#5250): a holder's
   * string at `path` joins only when `path` is one of these or ends in `.`
   * plus one. For a name that is unique only among objects of one kind (a
   * Kubernetes cluster-scoped name), where the same string at another field
   * names something else. Absent: the value names the node wherever it
   * appears.
   */
  paths?: readonly string[];
}

/** The lexicon whose nodes can be identity-matched, and the values that name each one. */
export interface IdentityOwners {
  lexicon: string;
  /** Other lexicon names whose nodes this owner also names (#5340). */
  aliases?: readonly string[];
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
  const ownerBy = new Map<string, IdentityOwners>();
  for (const o of owners) for (const a of o.aliases ?? []) if (!ownerBy.has(a)) ownerBy.set(a, o);
  for (const o of owners) ownerBy.set(o.lexicon, o);
  const keyOf = (scope: IndexedNodeScope, value: string) => `${scope.account}\u0000${scope.region ?? ""}\u0000${scope.foldCase ? value.toLowerCase() : value}`;
  // key -> node id -> the rule that names it, and the paths it names the node at
  const index = new Map<string, Map<string, { rule: string; paths?: readonly string[] }>>();
  const own = new Map<string, Set<string>>();
  for (const node of sorted) {
    const owner = ownerBy.get(node.lexicon);
    if (!owner || node.unmappedKind) continue;
    const scope = scopeOf(node);
    const values = (owner.identities ?? defaultNodeIdentities)(node);
    own.set(node.id, new Set(values.map((v) => v.value)));
    for (const { kind, value, paths } of values) {
      if (!identityCandidateValue(value)) continue;
      const k = keyOf(scope, value);
      const m = index.get(k) ?? index.set(k, new Map()).get(k)!;
      const rule = identityMatchRuleId(owner.lexicon, node.kind, kind);
      const prev = m.get(node.id);
      if (prev === undefined || byString(rule, prev.rule) < 0) m.set(node.id, { rule, paths });
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
      for (const k of keys(value)) {
        for (const [id, { rule, paths }] of index.get(k) ?? []) {
          if (id !== holder.id && (paths === undefined || paths.some((p) => path === p || path.endsWith(`.${p}`)))) found.set(id, rule);
        }
      }
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
