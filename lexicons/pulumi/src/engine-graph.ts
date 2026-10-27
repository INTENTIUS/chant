/**
 * Reading plunge's engine graph document (#4529): what `plunge graph --json`
 * prints (INTENTIUS/plunge#40, #43), in the shape chant#4520 designed and
 * `@intentius/chant/engine-facts` types. It is a `GraphIR` at version 1 whose
 * `meta.engineGraph` names the engine and the stack, whose node ids are full
 * URNs, and whose nodes carry the engine's facts under `facts`.
 *
 * Two readers use it:
 *
 * - the member graph read (`./workspace-member.ts`), from a checked-in
 *   {@link PULUMI_ENGINE_GRAPH_FILE} beside `stack-export.json`. It takes the
 *   facts and the `property` edges; `dependencies` and `parent` edges keep
 *   coming from the export;
 * - the lexicon's `describeResources` (`./describe-resources.ts`), from one
 *   `plunge graph --json --stack <stack>` run per member.
 *
 * Only what the schema names is copied. A fact with a value outside its
 * set is dropped, never guessed at, so a newer plunge that adds a field or a
 * value cannot put anything else on a node. The document holds no output
 * value and no secret (plunge#40's rule), and this reader carries no `attrs`
 * across, so none can reach the graph through it.
 *
 * Nothing in chant decides from these facts (ruled on #4520, Q1): they ride
 * on `IRNode.facts` for people and for readers that show the graph.
 */
import type { EdgeGrain, EngineFacts, EngineMarkers } from "@intentius/chant/engine-facts";

/** The conventional place of a plunge member's engine graph, beside the export. */
export const PULUMI_ENGINE_GRAPH_FILE = "engine-graph.json";

/** One node of the document: a URN, its type, and what plunge's records say about it. */
export interface PlungeGraphNode {
  urn: string;
  kind: string;
  physicalId?: string;
  facts?: EngineFacts;
}

/** One `ref` edge of the document, between two URNs. */
export interface PlungeGraphEdge {
  from: string;
  to: string;
  /** `dependencies`, `parent`, `provider`, or the property name of a `property` edge. */
  viaAttr: string;
  grain: EdgeGrain;
}

/** The parts of a plunge engine graph document chant reads. */
export interface PlungeEngineGraph {
  /** `meta.engineGraph.engine.version`, when plunge printed it. */
  engineVersion?: string;
  /** `meta.engineGraph.scope`: the stack plunge read. */
  scope?: { project: string; stack: string };
  /** `meta.engineGraph.observedAt`: when the record read started. */
  observedAt?: string;
  nodes: PlungeGraphNode[];
  edges: PlungeGraphEdge[];
  /** How many records plunge listed under `meta.engineGraph.gaps` (it could not describe them). */
  gaps: number;
}

const OWNERSHIP = new Set(["bound", "unowned", "pending", "foreign"]);
const OWNED_BY = new Set(["marker", "record", "name"]);
const ENCODING = new Set(["plain", "escaped", "digest"]);
const SOURCE = new Set(["live", "record"]);
const CLOUD_ID_KIND = new Set(["import-id", "arn", "provider-id", "self-link", "k8s-uid"]);
const GRAIN = new Set(["block", "instance", "property"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function markersOf(v: unknown): EngineMarkers | undefined {
  if (!isObject(v) || !ENCODING.has(v.encoding as string) || !SOURCE.has(v.source as string)) return undefined;
  return {
    ...(str(v.owner) ? { owner: v.owner } : {}),
    ...(str(v.address) ? { address: v.address } : {}),
    encoding: v.encoding as EngineMarkers["encoding"],
    source: v.source as EngineMarkers["source"],
  };
}

/**
 * The facts one node carries, with only the fields and values the schema
 * names. Undefined when none is left.
 */
export function engineFactsOf(v: unknown): EngineFacts | undefined {
  if (!isObject(v)) return undefined;
  const facts: EngineFacts = {};
  if (OWNERSHIP.has(v.ownership as string)) facts.ownership = v.ownership as EngineFacts["ownership"];
  const markers = markersOf(v.markers);
  if (markers) facts.markers = markers;
  if (OWNED_BY.has(v.ownedBy as string)) facts.ownedBy = v.ownedBy as EngineFacts["ownedBy"];
  if (Array.isArray(v.cloudIds)) {
    const ids = v.cloudIds
      .filter((c): c is Record<string, unknown> => isObject(c) && CLOUD_ID_KIND.has(c.kind as string) && str(c.value))
      .map((c) => ({ kind: c.kind as NonNullable<EngineFacts["cloudIds"]>[number]["kind"], value: c.value as string }));
    if (ids.length > 0) facts.cloudIds = ids;
  }
  const rv = v.recordVersions;
  if (isObject(rv) && typeof rv.kept === "boolean" && Array.isArray(rv.versions)) {
    facts.recordVersions = {
      kept: rv.kept,
      versions: rv.versions
        .filter((x): x is Record<string, unknown> => isObject(x) && str(x.id) && str(x.writtenAt) && typeof x.current === "boolean" && typeof x.deleted === "boolean")
        .map((x) => ({ id: x.id as string, writtenAt: x.writtenAt as string, current: x.current as boolean, deleted: x.deleted as boolean })),
    };
  }
  if (str(v.observedAt)) facts.observedAt = v.observedAt;
  return Object.keys(facts).length > 0 ? facts : undefined;
}

/**
 * The document, read, or why it can't be: it must be a version 1 graph whose
 * `meta.engineGraph` is format 1 and names plunge. A node or edge that does
 * not have the shape is skipped.
 */
export function readPlungeEngineGraph(doc: unknown): { graph: PlungeEngineGraph } | { error: string } {
  if (!isObject(doc)) return { error: "it is not a JSON object" };
  if (doc.version !== 1) return { error: `its version is ${JSON.stringify(doc.version)}, and chant reads version 1` };
  const meta = isObject(doc.meta) && isObject(doc.meta.engineGraph) ? doc.meta.engineGraph : undefined;
  if (!meta) return { error: "it has no meta.engineGraph, so it is not an engine graph" };
  if (meta.format !== 1) return { error: `its meta.engineGraph.format is ${JSON.stringify(meta.format)}, and chant reads format 1` };
  const engine = isObject(meta.engine) ? meta.engine : {};
  if (engine.name !== "plunge") return { error: `it was printed by ${JSON.stringify(engine.name)}, not plunge` };
  if (!Array.isArray(doc.nodes)) return { error: "it has no nodes list" };

  const nodes: PlungeGraphNode[] = [];
  for (const n of doc.nodes) {
    if (!isObject(n) || !str(n.id) || !str(n.kind)) continue;
    const facts = engineFactsOf(n.facts);
    nodes.push({ urn: n.id, kind: n.kind, ...(str(n.physicalId) ? { physicalId: n.physicalId } : {}), ...(facts ? { facts } : {}) });
  }
  const edges: PlungeGraphEdge[] = [];
  for (const e of Array.isArray(doc.edges) ? doc.edges : []) {
    if (!isObject(e) || e.kind !== "ref" || !str(e.from) || !str(e.to) || !str(e.viaAttr) || !GRAIN.has(e.grain as string)) continue;
    edges.push({ from: e.from, to: e.to, viaAttr: e.viaAttr, grain: e.grain as EdgeGrain });
  }
  const scope = isObject(meta.scope) && str(meta.scope.project) && str(meta.scope.stack) ? { project: meta.scope.project, stack: meta.scope.stack } : undefined;
  return {
    graph: {
      ...(str(engine.version) ? { engineVersion: engine.version } : {}),
      ...(scope ? { scope } : {}),
      ...(str(meta.observedAt) ? { observedAt: meta.observedAt } : {}),
      nodes,
      edges,
      gaps: Array.isArray(meta.gaps) ? meta.gaps.length : 0,
    },
  };
}
