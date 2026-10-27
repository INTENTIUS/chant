/**
 * Drift without a deploy (#4526, tier 2 of INTENTIUS/behold#1025): the deep
 * diff of declared source against an index version, for source chant never
 * applied. `chant lifecycle diff <env> --index <ref>` is the command.
 *
 * Three steps, all pure:
 *
 * 1. Every declared entity is joined to the index through its lexicon's
 *    index match, with {@link joinDeclaredToIndex} (./index-join.ts, #4525).
 *    `chant search --index` joins the same way, so a row that binds there
 *    binds here.
 * 2. A bound row's declared property tree is compared with its indexed
 *    node's `attrs` by the live deep diff ({@link diffDeepObservation},
 *    ./deep-observe.ts): both sides normalized with the lexicon's own hooks,
 *    and the observation baseline (`.chant/observation-baseline/<env>.json`,
 *    #4519) subtracted, value-bound. An accepted deviation stays quiet until
 *    the indexed value moves again.
 * 3. Every row becomes one drift record (`drift: "v1"`, ../drift-record.ts).
 *
 * A row that is not bound is reported with its join verdict and never
 * diffed. The verdict rides in `evidence.engineCode`:
 *
 * - `absent`: the index's coverage listed the type and location and holds
 *   no resource with the identity the declaration spells. The record is
 *   `pending` (declared, confirmed absent). The rule is
 *   {@link indexAbsence}, the one `chant index diff` reads "removed" by
 *   (./index-diff.ts, #4533);
 * - `not-observed`: the index did not look there (filtered, not reached, a
 *   read failure), or the lexicon has no index match. An uncovered entity is
 *   not observed, never drifted and never in sync;
 * - `no-binding`: the declaration spells no identity to join on;
 * - `ambiguous`: two or more indexed resources carry the identity, and chant
 *   will not pick one.
 *
 * The last three are status `not-observed` with a reason from the
 * observation contract's closed list. `not-observed` is also the index
 * diff's word ({@link IndexChangeKind}), so the two comparisons against an
 * index use one vocabulary.
 *
 * Every record's read is `live-read`, observed at the index's
 * `stamp.observedAt`: an index version is a read of the provider, taken
 * then. `evidence.command` names the index version that answered.
 */
import type { ChangeSetGraphNodes } from "../change-set-graph";
import type { DeepNormalizationHooks, DeepResourceObservation } from "../deep-observation";
import {
  deepDiffDriftRecords,
  driftDocument,
  driftRecord,
  placeDriftRecord,
  type DriftDocument,
  type DriftRecord,
  type DriftStatus,
  type DriftUnobserved,
} from "../drift-record";
import type { GraphIR, IRNode } from "../graph-ir";
import { isUnobservedReason } from "../observation";
import { countPropertyDrift, type DeepDiffResult } from "./deep-diff";
import { diffDeepObservation, type DeclaredEntities } from "./deep-observe";
import { indexAbsence, type IndexChangeKind } from "./index-diff";
import type { IndexDocument } from "./index-document";
import { formatIndexRef, joinDeclaredToIndex, type IndexJoin, type JoinLexicon } from "./index-join";
import { baselineForLexicon, type ObservationBaseline } from "./observation-baseline";

/** The status an unbound row takes when the index could not say: the index diff's word and the drift record's. */
export const INDEX_NOT_OBSERVED: Extract<IndexChangeKind, DriftStatus> = "not-observed";

/** What the drift read needs of a lexicon: its index match and its deep hooks. A `LexiconPlugin` is one. */
export interface IndexDriftLexicon extends JoinLexicon {
  deepNormalizationHooks?: DeepNormalizationHooks;
}

export interface IndexDriftInput {
  /** The index version to compare against, as {@link readIndexRef} returned it. */
  doc: IndexDocument;
  /** Its version name, with or without `.json`. */
  version: string;
  /** Declared entities per lexicon, as the live deep diff takes them. */
  entities: ReadonlyMap<string, DeclaredEntities>;
  lexicons: readonly IndexDriftLexicon[];
  /** The environment's accepted deviations, or null when none are recorded. */
  baseline?: ObservationBaseline | null;
  /** The drift record's `member`. */
  member: string;
  /** A stack of a multi-stack project: record addresses are `<stack>::<name>`, as search ids are. */
  stack?: string;
  /** The region the entities live in, from the stack (or the single stack) they belong to. */
  region?: string;
  /** The chant version, for `evidence.version` and the document's `chant`. */
  chant?: string;
  /** The member's graph, to place each record. Omit to leave `node` null. */
  graph?: ChangeSetGraphNodes | null;
}

/** One lexicon's half of the read. */
export interface IndexDriftLexiconResult {
  /** Every declared entity's join verdict, by entity name. */
  joins: Record<string, IndexJoin>;
  /** The deep diff over the bound rows only. Unbound rows are never in it. */
  deep: DeepDiffResult;
}

export interface IndexDriftCounts {
  /** Declared entities compared. */
  declared: number;
  bound: number;
  /** Reported property differences across every bound row. */
  properties: number;
  /** Bound rows with at least one reported difference. */
  drifted: number;
  /** Differences the baseline suppressed. */
  accepted: number;
  /** Rows the index listed the place of and does not hold. */
  pending: number;
  /** Rows the index could not say anything about. */
  notObserved: number;
}

export interface IndexDriftResult {
  /** `<scope key>@<version>`. */
  ref: string;
  observedAt: string;
  byLexicon: Record<string, IndexDriftLexiconResult>;
  /** One record per declared entity, sorted by address. */
  records: DriftRecord[];
  counts: IndexDriftCounts;
}

/** The command an index read's records name. */
export function indexDriftCommand(ref: string): string {
  return `chant lifecycle diff --index ${ref}`;
}

function declaredGraph(lexicon: string, entities: DeclaredEntities): GraphIR {
  const nodes: IRNode[] = [...entities.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, e]) => ({ id: name, kind: e.entityType, lexicon, attrs: e.props ?? {} }));
  return { nodes, edges: [], groups: { byLexicon: { [lexicon]: nodes.map((n) => n.id) } } };
}

function queriedOf(j: IndexJoin): string | undefined {
  if (!j.listedType) return undefined;
  return `${j.listedType}${j.identifier !== undefined ? ` ${j.identifier}` : ""}${j.location ? ` @ ${j.location}` : ""}`;
}

/** An unbound row's status and why, from its verdict. Never diffed. */
function unboundStatus(doc: IndexDocument, j: Exclude<IndexJoin, { verdict: "bound" }>): { status: DriftStatus; unobserved?: DriftUnobserved } {
  const queried = queriedOf(j);
  const q = queried ? { queried } : {};
  switch (j.verdict) {
    case "absent": {
      // The join said absent from the index's coverage. Read it again with the
      // index diff's rule, so "absent" means one thing in both comparisons.
      const a = j.listedType && j.location ? indexAbsence(doc.coverage, j.listedType, j.location) : ({ kind: "removed" } as const);
      if (a.kind === "removed") return { status: "pending" };
      return {
        status: INDEX_NOT_OBSERVED,
        unobserved: {
          reason: isUnobservedReason(a.verdict) ? a.verdict : "not-reached",
          detail: a.detail ?? `the index's coverage says ${a.verdict} for ${j.listedType} at ${j.location}`,
          ...q,
        },
      };
    }
    case "not-observed":
      return { status: INDEX_NOT_OBSERVED, unobserved: { reason: j.reason, detail: j.detail, ...q } };
    case "no-binding":
      return { status: INDEX_NOT_OBSERVED, unobserved: { reason: "no-binding", detail: j.detail, ...q } };
    case "ambiguous":
      return {
        status: INDEX_NOT_OBSERVED,
        unobserved: { reason: "no-binding", detail: `${j.detail} (candidates: ${j.candidates.join(", ")})`, ...q },
      };
  }
}

/**
 * Compare every declared entity with the index version, lexicon by lexicon.
 * Deterministic: the same index, declaration and baseline give the same
 * records.
 */
export function diffDeclaredAgainstIndex(input: IndexDriftInput): IndexDriftResult {
  const { doc } = input;
  const ref = formatIndexRef(doc.stamp.scopeKey, input.version.endsWith(".json") ? input.version : `${input.version}.json`);
  const observedAt = doc.stamp.observedAt;
  const command = indexDriftCommand(ref);
  const address = (name: string) => (input.stack ? `${input.stack}::${name}` : name);
  const indexed = new Map(doc.graph.nodes.map((n) => [n.id, n]));
  const byLexicon: Record<string, IndexDriftLexiconResult> = {};
  const records: DriftRecord[] = [];
  const counts: IndexDriftCounts = { declared: 0, bound: 0, properties: 0, drifted: 0, accepted: 0, pending: 0, notObserved: 0 };
  const adapter = {
    member: input.member,
    observedAt,
    ...(input.graph !== undefined ? { graph: input.graph } : {}),
    ...(input.chant ? { version: input.chant } : {}),
  };
  const evidence = (engineCode?: string) => ({ tool: "chant", ...(input.chant ? { version: input.chant } : {}), command, ...(engineCode ? { engineCode } : {}) });

  for (const lexicon of [...input.entities.keys()].sort()) {
    const entities = input.entities.get(lexicon)!;
    if (entities.size === 0) continue;
    const plugin = input.lexicons.find((l) => l.name === lexicon) ?? { name: lexicon };
    const { joins } = joinDeclaredToIndex(declaredGraph(lexicon, entities), doc, [plugin], {
      regionOf: () => input.region,
    });

    // The bound rows are the observed side, each its indexed node's tree.
    const bound: DeclaredEntities = new Map();
    const resources: Record<string, DeepResourceObservation> = {};
    for (const [name, entity] of entities) {
      const j = joins[name];
      if (j?.verdict !== "bound") continue;
      const hit = indexed.get(j.node);
      if (!hit) continue;
      bound.set(name, entity);
      resources[name] = { type: entity.entityType, physicalId: hit.physicalId ?? j.nativeId, properties: (hit.attrs ?? {}) as Record<string, unknown> };
    }
    const deep = diffDeepObservation(bound, { resources, unobserved: {} }, plugin.deepNormalizationHooks, baselineForLexicon(input.baseline, lexicon));
    byLexicon[lexicon] = { joins, deep };

    // Bound rows: the deep diff's records, and in-sync for a row whose every
    // difference is accepted (the deep diff lists it under neither).
    const deepRecords = new Map(deepDiffDriftRecords({ ...adapter, diff: deep, command }).map((r) => [r.address, r]));
    for (const name of [...entities.keys()].sort()) {
      const entity = entities.get(name)!;
      const j = joins[name];
      counts.declared++;
      const at = { ...placeDriftRecord(adapter, "chant", address(name)) };
      if (j?.verdict === "bound" && bound.has(name)) {
        counts.bound++;
        const r = deepRecords.get(name);
        records.push(
          driftRecord({
            ...(r ?? {
              member: input.member,
              engine: "chant" as const,
              address: name,
              observedAt,
              read: "live-read" as const,
              status: "in-sync" as const,
              evidence: evidence(),
            }),
            address: address(name),
            ...at,
            resourceType: entity.entityType,
          }),
        );
        continue;
      }
      // Unbound: the verdict, never a diff.
      const verdict = j ?? { verdict: "not-observed" as const, reason: "not-reached" as const, detail: "the join gave this row no verdict" };
      if (verdict.verdict === "bound") {
        // Bound to a node the index does not hold: the document disagrees with itself.
        records.push(
          driftRecord({
            member: input.member,
            engine: "chant",
            address: address(name),
            ...at,
            resourceType: entity.entityType,
            observedAt,
            read: "live-read",
            status: INDEX_NOT_OBSERVED,
            unobserved: { reason: "read-failed", detail: `the index binds ${name} to ${verdict.node}, which its graph does not hold` },
            evidence: evidence("bound"),
          }),
        );
        counts.notObserved++;
        continue;
      }
      const s = unboundStatus(doc, verdict);
      if (s.status === "pending") counts.pending++;
      else counts.notObserved++;
      records.push(
        driftRecord({
          member: input.member,
          engine: "chant",
          address: address(name),
          ...at,
          resourceType: entity.entityType,
          observedAt,
          read: "live-read",
          status: s.status,
          ...(s.unobserved ? { unobserved: s.unobserved } : {}),
          evidence: evidence(verdict.verdict),
        }),
      );
    }
    counts.properties += countPropertyDrift(deep);
    counts.drifted += deep.drifted.length;
    counts.accepted += deep.accepted.reduce((n, e) => n + e.changes.length, 0);
  }

  records.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return { ref, observedAt, byLexicon, records, counts };
}

/** The records as one drift document. */
export function indexDriftDocument(results: Iterable<IndexDriftResult>, chant?: string): DriftDocument {
  const records: DriftRecord[] = [];
  for (const r of results) records.push(...r.records);
  return driftDocument(records, chant ? { chant } : {});
}
