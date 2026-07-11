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
  /** `reference` → an edge; `containment` → a boundary hint (#779), not an edge. */
  relation: "reference" | "containment";
  /** Edge / containment label (e.g. "in VPC", "sg", "targets"). */
  label?: string;
}

/** A lexicon's reference knowledge — its identity map and reference rules. */
export interface ReferenceCatalog {
  identities: IdentityRule[];
  refs: RefRule[];
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
    if (node.physicalId) add(node.physicalId, node.id, node.kind);
    for (const rule of catalog.identities) {
      if (rule.kind !== node.kind) continue;
      for (const p of rule.ids) for (const v of readPath(node.attrs, p)) add(v, node.id, node.kind);
    }
  }

  const edges: IREdge[] = [];
  const containment: ContainmentPair[] = [];
  const dangling: DanglingRef[] = [];
  const seenEdge = new Set<string>();
  const seenCont = new Set<string>();

  for (const node of nodes) {
    for (const rule of catalog.refs) {
      if (rule.from !== node.kind) continue;
      for (const value of readPath(node.attrs, rule.path)) {
        const candidates = index.get(value) ?? [];
        const match = rule.targetKind ? candidates.find((c) => c.kind === rule.targetKind) : candidates[0];
        if (!match) {
          dangling.push({ from: node.id, path: rule.path, value, ...(rule.targetKind ? { targetKind: rule.targetKind } : {}) });
          continue;
        }
        if (match.id === node.id) continue; // self-reference (e.g. an SG rule to its own group)
        if (rule.relation === "containment") {
          const k = `${node.id}|${match.id}`;
          if (seenCont.has(k)) continue;
          seenCont.add(k);
          containment.push({ child: node.id, parent: match.id, ...(rule.label ? { label: rule.label } : {}) });
        } else {
          const via = rule.label ?? rule.path;
          const k = `${node.id}|${match.id}|${via}`;
          if (seenEdge.has(k)) continue;
          seenEdge.add(k);
          edges.push({ from: node.id, to: match.id, kind: "ref", viaAttr: via });
        }
      }
    }
  }

  edges.sort((a, b) => `${a.from}|${a.to}|${a.viaAttr}`.localeCompare(`${b.from}|${b.to}|${b.viaAttr}`));
  containment.sort((a, b) => `${a.child}|${a.parent}`.localeCompare(`${b.child}|${b.parent}`));
  dangling.sort((a, b) => `${a.from}|${a.path}|${a.value}`.localeCompare(`${b.from}|${b.path}|${b.value}`));

  return { edges, containment, dangling };
}
