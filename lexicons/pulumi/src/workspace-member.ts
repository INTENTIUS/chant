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
 * resource's `dependencies` and `parent`, kept only when the target is a node.
 * Inputs and outputs are not copied into the node, since an export can hold
 * secrets.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { EntityReference } from "@intentius/chant/graph-ir";
import { isPulumiNodeless, pulumiNodeKey } from "@intentius/chant/pulumi-urn";

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

  const entities = new Map<string, Declarable>();
  for (const r of resources) {
    const key = typeof r?.urn === "string" ? keyOf.get(r.urn) : undefined;
    if (!key) continue;
    const references = new Map<string, EntityReference>();
    const add = (urn: unknown, via: string) => {
      const to = typeof urn === "string" ? keyOf.get(urn) : undefined;
      if (to && to !== key) references.set(`${to}|${via}`, { to, viaAttr: via });
    };
    add(r.parent, "parent");
    for (const d of Array.isArray(r.dependencies) ? r.dependencies : []) add(d, "dependencies");
    entities.set(key, {
      lexicon: "pulumi",
      entityType: r.type as string,
      kind: "resource",
      props: {},
      references: [...references.values()],
      [DECLARABLE_MARKER]: true,
    } as unknown as Declarable);
  }

  const report: PulumiMemberReport = { export: PULUMI_EXPORT_FILE, objects: entities.size, exported: true };
  if (pendingOperations > 0) report.pendingOperations = pendingOperations;
  return { entities, warnings: [], report, doc };
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
