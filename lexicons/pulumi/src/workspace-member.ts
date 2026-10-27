/**
 * Reading a pulumi workspace member into the graph (#3179).
 *
 * `chant workspace graph` writes a reader project for a member of kind
 * `pulumi`, with `pulumi.member` in its config (see `workspace-kinds.json`).
 * The plugin's `buildRoots` hook calls {@link readPulumiMember}, which reads
 * the `pulumi stack export` JSON the member has checked in, at
 * {@link PULUMI_EXPORT_FILE} in its directory. The graph read never runs the
 * program or `pulumi`: with no export there are no nodes, and
 * `meta.pulumiMember` says `exported: false` and why.
 *
 * The kind lived in the terraform lexicon until #4453 moved it here. The
 * ruling on #4450 lets chant run `pulumi preview` and `pulumi refresh
 * --preview-only` for a Pulumi member, so the old "chant never calls
 * `pulumi`" rule now covers this graph read only. The change set
 * (`./change-set.ts`) and drift (`./drift-record.ts`) run those two
 * commands, which change nothing, and the outputs read (`./member-outputs.ts`,
 * #4455) adds `pulumi stack output --json --show-secrets=false`; nothing else.
 *
 * Nodes are the export's resources, keyed `<label>/<urn tail>`, where the tail
 * is the URN after its stack and project (`aws:s3/bucket:Bucket::assets`).
 * That is the rule in `@intentius/chant/pulumi-urn` (#4456), which a
 * change set over `pulumi preview --json` and a drift record use too, so all
 * three put a resource on the same node. Provider resources
 * (`pulumi:providers:*`) and the root `pulumi:pulumi:Stack` are left out; the
 * resources that name them are not edged to them. Edges come from each
 * resource's `dependencies` and `parent`, kept only when the target is a node,
 * each with `grain: "instance"` (#4529): it joins two resources, not two
 * blocks of source. Inputs and outputs are not copied into the node, since an
 * export can hold secrets.
 *
 * A member on plunge may also check in {@link PULUMI_ENGINE_GRAPH_FILE}
 * beside the export: what `plunge graph --json --stack <stack>` printed
 * (#4529, the document designed on #4520). When it is there, each node whose
 * URN it lists gets the engine's facts (`IRNode.facts`: ownership, the
 * markers plunge's record says it wrote, how ownership is known, cloud IDs,
 * record versions), and its `property` edges join the graph with `grain:
 * "property"` and the property's name as `viaAttr`. Its `dependencies`,
 * `parent` and `provider` edges are not taken: the export already gives the
 * first two, and providers have no node. The read still runs nothing. A
 * stock member's `engine-graph.json`, if one is there, is not read.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { EntityReference } from "@intentius/chant/graph-ir";
import type { EngineFacts } from "@intentius/chant/engine-facts";
import { isPulumiNodeless, pulumiNodeKey } from "@intentius/chant/pulumi-urn";
import { PULUMI_ENGINE_GRAPH_FILE, readPlungeEngineGraph } from "./engine-graph";
import { pulumiMemberEngine } from "./member-engine";

/** The conventional place of the export, in the member's directory. */
export const PULUMI_EXPORT_FILE = "stack-export.json";

export interface PulumiMemberConfig {
  /** The member's directory, absolute. */
  dir: string;
  /** Names the entities (`<label>/...`): the member's name. */
  label?: string;
  /** What runs the stack, when the config says; see `./run.ts`'s `pulumiMemberEngine`. The graph read ignores it. */
  engine?: "pulumi" | "plunge";
  /** The stack the drift read passes as `--stack`, when the config says. The graph read ignores it. */
  stack?: string;
}

/** What the read found, carried on the graph's `meta.pulumiMember`. */
export interface PulumiMemberReport {
  /** The export read, relative to the member's directory. */
  export?: string;
  objects: number;
  /** False when the member has no readable export. */
  exported: boolean;
  /** Why nothing was read; set with `exported: false`. */
  reason?: string;
  /**
   * How many `deployment.pending_operations` the export records, set only
   * when there are some (#4468). Pulumi writes one for each step an update
   * started and never finished, so a non-zero count means the last update was
   * interrupted and the stack may hold resources its state does not. PUL002
   * reports it.
   */
  pendingOperations?: number;
  /**
   * The member's checked-in {@link PULUMI_ENGINE_GRAPH_FILE} (#4529), set
   * only for a member on plunge that has one. `read: false` with `reason`
   * when it could not be read; the graph is then the export's alone.
   */
  engineGraph?: PulumiMemberEngineGraphReport;
}

/** What the read took from a plunge member's engine graph (#4529). */
export interface PulumiMemberEngineGraphReport {
  /** The file, relative to the member's directory. */
  file: string;
  read: boolean;
  /** Why it was not read; set with `read: false`. */
  reason?: string;
  /** The stack plunge read, from `meta.engineGraph.scope`. */
  stack?: string;
  /** When plunge's record read started, from `meta.engineGraph.observedAt`. */
  observedAt?: string;
  /** How many of the graph's nodes carry facts the document gave. */
  facts?: number;
  /** How many `property` edges joined the graph. */
  propertyEdges?: number;
}

interface ExportedResource {
  urn?: unknown;
  type?: unknown;
  parent?: unknown;
  dependencies?: unknown;
}

export function readPulumiMember(opts: { member: PulumiMemberConfig }): {
  entities: Map<string, Declarable>;
  warnings: string[];
  report: PulumiMemberReport;
  /** The parsed export, when there is one that reads as JSON. The post-synth checks read it; `meta` does not carry it. */
  doc?: unknown;
} {
  const { member } = opts;
  const label = member.label ?? basename(member.dir);
  const missing = (reason: string) => ({
    entities: new Map<string, Declarable>(),
    warnings: [`pulumi member "${label}" was not read: ${reason}`],
    report: { objects: 0, exported: false, reason } as PulumiMemberReport,
  });

  const file = join(member.dir, PULUMI_EXPORT_FILE);
  if (!existsSync(file)) {
    return missing(`no ${PULUMI_EXPORT_FILE} in the member; run \`pulumi stack export --file ${PULUMI_EXPORT_FILE}\` and check it in, and chant will read it (the graph read does not run the program)`);
  }
  let resources: ExportedResource[];
  let pendingOperations = 0;
  let doc: { deployment?: { resources?: unknown; pending_operations?: unknown } };
  try {
    doc = JSON.parse(readFileSync(file, "utf-8")) as { deployment?: { resources?: unknown; pending_operations?: unknown } };
    const list = doc?.deployment?.resources;
    if (list !== undefined && !Array.isArray(list)) return missing(`${PULUMI_EXPORT_FILE} has a deployment.resources that is not a list`);
    resources = (list ?? []) as ExportedResource[];
    const pending = doc?.deployment?.pending_operations;
    pendingOperations = Array.isArray(pending) ? pending.length : 0;
  } catch (e) {
    return missing(`${PULUMI_EXPORT_FILE} is not readable JSON: ${(e as Error).message}`);
  }

  const keyOf = new Map<string, string>();
  for (const r of resources) {
    if (typeof r?.urn !== "string" || typeof r.type !== "string" || isPulumiNodeless(r.type)) continue;
    const tail = pulumiNodeKey(r.urn);
    if (tail !== null) keyOf.set(r.urn, `${label}/${tail}`);
  }

  const warnings: string[] = [];
  const engine = pulumiMemberEngine(member.dir, member.engine).engine === "plunge" ? readMemberEngineGraph(member.dir, label, warnings) : undefined;

  const entities = new Map<string, Declarable>();
  let withFacts = 0;
  let propertyEdges = 0;
  for (const r of resources) {
    const key = typeof r?.urn === "string" ? keyOf.get(r.urn) : undefined;
    if (!key) continue;
    const urn = r.urn as string;
    const references = new Map<string, EntityReference>();
    const add = (to: string | undefined, via: string, grain: "instance" | "property") => {
      if (to && to !== key) references.set(`${to}|${via}|${grain}`, { to, viaAttr: via, grain });
    };
    const node = (u: unknown) => (typeof u === "string" ? keyOf.get(u) : undefined);
    add(node(r.parent), "parent", "instance");
    for (const d of Array.isArray(r.dependencies) ? r.dependencies : []) add(node(d), "dependencies", "instance");
    for (const e of engine?.propertyEdges.get(urn) ?? []) {
      const before = references.size;
      add(node(e.to), e.viaAttr, "property");
      if (references.size > before) propertyEdges++;
    }
    const entity = {
      lexicon: "pulumi",
      entityType: r.type as string,
      kind: "resource",
      props: {},
      references: [...references.values()],
      [DECLARABLE_MARKER]: true,
    } as unknown as Declarable;
    const facts = engine?.facts.get(urn);
    if (facts) {
      // Not enumerable: core's `entityFacts` reads it onto `IRNode.facts`, and a
      // chant older than #4529 does not project it into the node's attrs.
      Object.defineProperty(entity, "facts", { value: facts, enumerable: false });
      withFacts++;
    }
    entities.set(key, entity);
  }

  const report: PulumiMemberReport = { export: PULUMI_EXPORT_FILE, objects: entities.size, exported: true };
  if (pendingOperations > 0) report.pendingOperations = pendingOperations;
  if (engine) report.engineGraph = engine.report.read ? { ...engine.report, facts: withFacts, propertyEdges } : engine.report;
  return { entities, warnings, report, doc };
}

/**
 * A plunge member's checked-in engine graph, indexed by URN, or undefined
 * when the member has none. One that does not read leaves a warning and a
 * report saying why, and the graph is the export's alone.
 */
function readMemberEngineGraph(
  dir: string,
  label: string,
  warnings: string[],
): { facts: Map<string, EngineFacts>; propertyEdges: Map<string, { to: string; viaAttr: string }[]>; report: PulumiMemberEngineGraphReport } | undefined {
  const file = join(dir, PULUMI_ENGINE_GRAPH_FILE);
  if (!existsSync(file)) return undefined;
  const unread = (reason: string) => {
    warnings.push(`pulumi member "${label}": ${PULUMI_ENGINE_GRAPH_FILE} was not read: ${reason}; the graph has no engine facts`);
    return { facts: new Map(), propertyEdges: new Map(), report: { file: PULUMI_ENGINE_GRAPH_FILE, read: false, reason } };
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
  } catch (e) {
    return unread(`it is not readable JSON: ${(e as Error).message}`);
  }
  const read = readPlungeEngineGraph(parsed);
  if ("error" in read) return unread(read.error);
  const { graph } = read;
  const facts = new Map<string, EngineFacts>();
  for (const n of graph.nodes) if (n.facts) facts.set(n.urn, n.facts);
  const propertyEdges = new Map<string, { to: string; viaAttr: string }[]>();
  for (const e of graph.edges) {
    if (e.grain !== "property") continue;
    const list = propertyEdges.get(e.from) ?? [];
    list.push({ to: e.to, viaAttr: e.viaAttr });
    propertyEdges.set(e.from, list);
  }
  return {
    facts,
    propertyEdges,
    report: {
      file: PULUMI_ENGINE_GRAPH_FILE,
      read: true,
      ...(graph.scope ? { stack: graph.scope.stack } : {}),
      ...(graph.observedAt ? { observedAt: graph.observedAt } : {}),
    },
  };
}

/**
 * What the last member read in this process saw, for the post-synth checks
 * PUL003 to PUL015 (`./lint/post-synth/`). It holds the parsed export, so it
 * stays in the process and never reaches the graph's `meta`, which carries
 * only {@link PulumiMemberReport}.
 */
export interface PulumiMemberRead {
  /** The member's directory, absolute. */
  dir: string;
  /** The label the entities are keyed by. */
  label: string;
  /** `pulumi.member.engine`, when the config sets it. */
  engine?: "pulumi" | "plunge";
  /** `pulumi.member.stack`, when the config sets it. */
  stack?: string;
  /** The parsed `stack-export.json`; undefined when there is none or it is not JSON. */
  doc?: unknown;
}

let lastRead: PulumiMemberRead | undefined;

/** Left by the plugin's `buildRoots` beside the report; see {@link PulumiMemberRead}. */
export function setLastMemberRead(read: PulumiMemberRead | undefined): void {
  lastRead = read;
}

export function lastMemberRead(): PulumiMemberRead | undefined {
  return lastRead;
}

let lastReport: PulumiMemberReport | undefined;

/** The report of the read in this process, left for `graphMeta` (see the aws member reader). */
export function setLastMemberReport(report: PulumiMemberReport | undefined): void {
  lastReport = report;
}

export function lastMemberReport(): PulumiMemberReport | undefined {
  return lastReport;
}
