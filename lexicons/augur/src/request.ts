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
import {
  byCodeUnit,
  coverageFor,
  coverageLabel,
  TERRAFORM_RESOURCE_TYPE,
  terraformResourceType,
  unmappedDetail,
  type EngineKind,
} from "./mapping";

/** The wire version. Bumped when the shape changes, the way `behaviour: "v1"` is. */
export const AUGUR_REQUEST_VERSION = "augur/v1" as const;

/** One entity, in the engine's four words: a kind, a provider, a region and a size. */
export interface EngineNode {
  /** The chant entity name, which is also the key `edges` uses. */
  name: string;
  /** The declared type it was translated from, so an engine can say what it choked on. */
  entityType: string;
  /**
   * The provider's own type, where the declared type does not carry it: a
   * terraform `resource` block is `Terraform::Resource` whatever it declares,
   * and `aws_instance` is what an engine can say it choked on (#2360).
   */
  resourceType?: string;
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
  /** The provider's own type, for a terraform block. See {@link EngineNode.resourceType}. */
  resourceType?: string;
  /**
   * Which of the coverage table's three not-sent verdicts this is:
   * `declared-unmapped` (looked at, and it carries no rate),
   * `provider-not-modelled` (a substrate augur states it does not cover), or
   * `unknown-type` (a modelled provider's type with no row — the only one that
   * is a defect). See `./mapping.ts` for why they are not one.
   */
  status: "declared-unmapped" | "provider-not-modelled" | "unknown-type";
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
 * `sizeType` says which type the row's property holds, and a value of the
 * other type is **absent** rather than coerced. Without that, a
 * `DBInstanceClass: 42` — a wrong-typed declaration, or a parameter that
 * folded to a number — rendered as `"42"` and went to the engine to be matched
 * against a price table of instance-class names it does not appear in. That is
 * the outcome the paragraph below is written against, arriving through the
 * door the paragraph left open.
 *
 * Anything else — an object, an array, an unresolved intrinsic, a `NaN` — is
 * absent too, because a size an engine cannot read is worse than no size: it
 * will either be ignored silently or matched against nothing.
 *
 * A terraform block's unresolved reference is a string, `"${var.size}"`, and
 * is absent for the same reason a CloudFormation intrinsic object is: it is
 * the name of a value, not the value (#2360).
 */
export function sizeOf(
  props: Record<string, unknown>,
  sizeProp: string | undefined,
  sizeType?: "string" | "number",
): string | undefined {
  if (!sizeProp) return undefined;
  const raw = readPath(props, sizeProp);
  if (sizeType === "number") {
    return typeof raw === "number" && Number.isFinite(raw) ? String(raw) : undefined;
  }
  // `string`, and the default for a row naming a property and no type.
  return isLiteral(raw) ? raw : undefined;
}

/** A non-empty string that is a value rather than a terraform `${…}` reference to one. */
function isLiteral(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length > 0 && !raw.includes("${");
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

  for (const name of [...options.entityNames].sort(byCodeUnit)) {
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
    const verdict = coverageFor(declared.entityType, declared.props);
    // A terraform block's provider type rides beside the entity type, on the
    // wire and in the withheld list, because `Terraform::Resource` alone
    // names nothing an engine or a reader can act on (#2360).
    const resourceType =
      declared.entityType === TERRAFORM_RESOURCE_TYPE ? terraformResourceType(declared.props) : undefined;
    if (verdict.status !== "mapped") {
      withheld.push({
        name,
        entityType: declared.entityType,
        ...(resourceType ? { resourceType } : {}),
        status: verdict.status,
        detail: unmappedDetail(coverageLabel(declared.entityType, declared.props), verdict),
      });
      continue;
    }
    const { mapping } = verdict;
    const declaredRegion = mapping.regionProp
      ? readPath(declared.props, mapping.regionProp)
      : undefined;
    const region = isLiteral(declaredRegion) ? declaredRegion : options.region;
    const size = sizeOf(declared.props, mapping.sizeProp, mapping.sizeType);
    nodes.push({
      name,
      entityType: declared.entityType,
      ...(resourceType ? { resourceType } : {}),
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
    // By code unit, like the node order above. `localeCompare` reads the
    // ambient locale, so two machines with different `LANG` values produced
    // two different byte streams from one estate — in a module whose whole
    // claim is that its bytes are a function of its content and nothing else.
    .sort(
      (a, b) =>
        byCodeUnit(a.from, b.from) ||
        byCodeUnit(a.to, b.to) ||
        byCodeUnit(a.via ?? "", b.via ?? "") ||
        byCodeUnit(a.toAttr ?? "", b.toAttr ?? ""),
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
