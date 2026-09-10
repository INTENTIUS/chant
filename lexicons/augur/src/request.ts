/**
 * The engine's request, built offline from chant's typed source (#2357).
 *
 * `chant build` reaches no network and is byte-identical on re-run
 * (`packages/core/src/components/verbs/reproducibility.ts`, the
 * `deterministic-synthesis` basis). The request an engine is handed is built
 * the same way and holds itself to the same property, for a reason that is not
 * tidiness: the epic wants the declared prediction and the live prediction
 * shown as a delta, and a delta is only a statement about the estate if both
 * sides were assembled the same way from the same source. A request carrying a
 * timestamp, an unsorted map or a floating-point rendering that depends on the
 * platform makes every re-run look like drift.
 *
 * So everything here is pure. No clock, no `Math.random`, no environment, no
 * filesystem, no network. {@link renderEngineRequest} is the only place bytes
 * are produced, and it produces them through a canonical writer that sorts
 * every object key and every list.
 *
 * ## What is in the request, and why the withheld list is in it too
 *
 * Nodes, edges, the traffic level, the caller's edge-coverage claim — and
 * `withheld`, the entities the caller asked about that this lexicon is not
 * asking the engine about, each with the reason from the coverage table.
 *
 * That last one is the same argument `edgeCoverage` won on the contract
 * (#2365, review finding 6). An engine handed twelve nodes cannot tell whether
 * the estate has twelve or twenty, and a resilience verdict computed over a
 * graph with eight nodes missing is a confident answer to a question nobody
 * asked. Omitting them would make the request's own coverage invisible one
 * level down from where the contract made it visible.
 */

import type { IREdge } from "@intentius/chant/graph-ir";
import type { BehaviourEdgeCoverage, PredictBehaviourOptions } from "@intentius/chant/behaviour";
import { coverageFor, unmappedDetail, type EngineKind } from "./mapping";

/** The wire version. Bumped when the shape changes, the way `behaviour: "v1"` is. */
export const AUGUR_REQUEST_VERSION = "augur/v1" as const;

/** One entity, in the engine's four words: a kind, a provider, a region and a size. */
export interface EngineNode {
  /** The chant entity name, which is also the key `edges` uses. */
  name: string;
  /** The declared type it was translated from, so an engine can say what it choked on. */
  entityType: string;
  kind: EngineKind;
  provider: string;
  /** Absent where neither the entity nor the caller states one. Never defaulted. */
  region?: string;
  /**
   * The size in the provider's own words, verbatim. A string where the
   * declaration holds one; absent where it holds none. Never parsed, never
   * converted, never guessed — see the note in `./mapping.ts`.
   */
  size?: string;
}

/** One edge, flattened from `IREdge` to the two fields an engine reads. */
export interface EngineEdge {
  from: string;
  to: string;
  /** The referring attribute, where the edge came from a declared reference. */
  via?: string;
  /** The referenced attribute on the far end. */
  toAttr?: string;
}

/** One entity the caller asked about that is not on the wire, and why. */
export interface WithheldEntity {
  name: string;
  entityType: string;
  /**
   * `declared-unmapped` when the coverage table has looked at this type and
   * decided; `unknown-type` when it has not. See `./mapping.ts` for why the
   * two are not one.
   */
  status: "declared-unmapped" | "unknown-type";
  detail: string;
}

/** What goes on the wire. */
export interface EngineRequest {
  request: typeof AUGUR_REQUEST_VERSION;
  /** The level to predict at, verbatim from the caller. chant parses nothing. */
  traffic: string;
  /** Present only when the caller named one; the engine's own default is not chant's to pick. */
  region?: string;
  nodes: EngineNode[];
  edges: EngineEdge[];
  /** The caller's claim about how complete `edges` is, passed through unchanged. */
  coverage: BehaviourEdgeCoverage;
  withheld: WithheldEntity[];
}

/** Read a dotted path out of a declared property bag. Returns `undefined` for any miss. */
function readPath(props: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = props;
  for (const segment of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * A declared size, as a string, or absent.
 *
 * A string passes through. A finite number renders through `String`, which is
 * what a `MemorySize: 512` or a PVC's `Size: 100` is. Anything else — an
 * object, an unresolved intrinsic, a `NaN` — is **absent** rather than
 * `JSON.stringify`d into the request, because a size an engine cannot read is
 * worse than no size: it will either be ignored silently or matched against a
 * price table it does not appear in.
 */
export function sizeOf(props: Record<string, unknown>, sizeProp: string | undefined): string | undefined {
  if (!sizeProp) return undefined;
  const raw = readPath(props, sizeProp);
  if (typeof raw === "string") return raw.length > 0 ? raw : undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return undefined;
}

/**
 * Translate one request's worth of chant entities and edges into the engine's
 * shape. Pure, and the same input gives the same output forever.
 *
 * Every name in `entityNames` comes out in exactly one of `nodes` or
 * `withheld`. The caller in `./predict-behaviour.ts` depends on that to satisfy
 * `behaviourReport`'s totality check, and a name the caller asked about that is
 * missing from `options.entities` is `withheld` with an `unknown-type` detail
 * rather than dropped — a `continue` in this loop is the exact silent hole the
 * contract's totality refusal exists to catch.
 */
export function buildEngineRequest(
  options: Pick<
    PredictBehaviourOptions,
    "entityNames" | "entities" | "edges" | "edgeCoverage" | "traffic" | "region"
  >,
): EngineRequest {
  const nodes: EngineNode[] = [];
  const withheld: WithheldEntity[] = [];

  for (const name of [...options.entityNames].sort()) {
    const declared = options.entities.get(name);
    if (!declared) {
      withheld.push({
        name,
        entityType: "(undeclared)",
        status: "unknown-type",
        detail:
          `${name} was named in entityNames and is not in the entities map, so this lexicon has ` +
          "nothing to translate. It is reported rather than dropped: an entity that vanished " +
          "between the build and the request is a defect in the caller, and a silent omission " +
          "hides it behind an estate that looks smaller.",
      });
      continue;
    }
    const verdict = coverageFor(declared.entityType);
    if (verdict.status !== "mapped") {
      withheld.push({
        name,
        entityType: declared.entityType,
        status: verdict.status === "declared-unmapped" ? "declared-unmapped" : "unknown-type",
        detail: unmappedDetail(declared.entityType, verdict),
      });
      continue;
    }
    const { mapping } = verdict;
    const declaredRegion = mapping.regionProp
      ? readPath(declared.props, mapping.regionProp)
      : undefined;
    const region = typeof declaredRegion === "string" && declaredRegion.length > 0
      ? declaredRegion
      : options.region;
    const size = sizeOf(declared.props, mapping.sizeProp);
    nodes.push({
      name,
      entityType: declared.entityType,
      kind: mapping.kind,
      provider: mapping.provider,
      ...(region ? { region } : {}),
      ...(size ? { size } : {}),
    });
  }

  const edges: EngineEdge[] = options.edges
    .map((edge: IREdge) => ({
      from: edge.from,
      to: edge.to,
      ...(edge.viaAttr ? { via: edge.viaAttr } : {}),
      ...(edge.toAttr ? { toAttr: edge.toAttr } : {}),
    }))
    .sort(
      (a, b) =>
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to) ||
        (a.via ?? "").localeCompare(b.via ?? "") ||
        (a.toAttr ?? "").localeCompare(b.toAttr ?? ""),
    );

  return {
    request: AUGUR_REQUEST_VERSION,
    traffic: options.traffic,
    ...(options.region ? { region: options.region } : {}),
    nodes,
    edges,
    coverage: options.edgeCoverage,
    withheld,
  };
}

/**
 * Canonical JSON: object keys sorted, arrays in the order they were built,
 * two-space indent, one trailing newline.
 *
 * Key order is where a "deterministic" serializer usually is not. `JSON.stringify`
 * preserves insertion order, and insertion order here follows the order a
 * property bag was assembled in, which follows discovery order, which follows
 * the filesystem. Sorting the keys makes the bytes a function of the content
 * and nothing else — which is what `chant build`'s own reproducibility claim
 * means, and what makes a re-run comparable rather than merely re-run.
 */
export function renderEngineRequest(request: EngineRequest): string {
  return `${JSON.stringify(canonical(request), null, 2)}\n`;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner === undefined) continue;
      out[key] = canonical(inner);
    }
    return out;
  }
  return value;
}
