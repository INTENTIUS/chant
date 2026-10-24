/**
 * Reading a pulumi workspace member into the graph (#3179).
 *
 * `chant workspace graph` writes a reader project for a member of kind
 * `pulumi`, with `terraform.pulumiMember` in its config (see
 * `workspace-kinds.json`). The plugin's `buildRoots` hook calls
 * {@link readPulumiMember}, which reads the `pulumi stack export` JSON the
 * member has checked in, at {@link PULUMI_EXPORT_FILE} in its directory. chant
 * never runs the program and never calls `pulumi`: with no export there are no
 * nodes, and `meta.pulumiMember` says `exported: false` and why.
 *
 * Nodes are the export's resources, keyed `<label>/<urn tail>`, where the tail
 * is the URN after its stack and project (`aws:s3/bucket:Bucket::assets`).
 * Provider resources (`pulumi:providers:*`) are left out; the resources that
 * name them are not edged to them. Edges come from each resource's
 * `dependencies` and `parent`, kept only when the target is a node. Inputs and
 * outputs are not copied into the node, since an export can hold secrets.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { EntityReference } from "@intentius/chant/graph-ir";

/** The conventional place of the export, in the member's directory. */
export const PULUMI_EXPORT_FILE = "stack-export.json";

export interface PulumiMemberConfig {
  /** The member's directory, absolute. */
  dir: string;
  /** Names the entities (`<label>/...`): the member's name. */
  label?: string;
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
}

interface ExportedResource {
  urn?: unknown;
  type?: unknown;
  parent?: unknown;
  dependencies?: unknown;
}

const PROVIDER = /^pulumi:providers:/;

/** `urn:pulumi:<stack>::<project>::<tail>`: the tail, or the whole URN when it has another shape. */
function urnTail(urn: string): string {
  const parts = urn.split("::");
  return urn.startsWith("urn:pulumi:") && parts.length >= 4 ? parts.slice(2).join("::") : urn;
}

export function readPulumiMember(opts: { member: PulumiMemberConfig }): {
  entities: Map<string, Declarable>;
  warnings: string[];
  report: PulumiMemberReport;
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
    return missing(`no ${PULUMI_EXPORT_FILE} in the member; run \`pulumi stack export --file ${PULUMI_EXPORT_FILE}\` and check it in, and chant will read it (chant does not run the program)`);
  }
  let resources: ExportedResource[];
  try {
    const doc = JSON.parse(readFileSync(file, "utf-8")) as { deployment?: { resources?: unknown } };
    const list = doc?.deployment?.resources;
    if (list !== undefined && !Array.isArray(list)) return missing(`${PULUMI_EXPORT_FILE} has a deployment.resources that is not a list`);
    resources = (list ?? []) as ExportedResource[];
  } catch (e) {
    return missing(`${PULUMI_EXPORT_FILE} is not readable JSON: ${(e as Error).message}`);
  }

  const keyOf = new Map<string, string>();
  for (const r of resources) {
    if (typeof r?.urn !== "string" || typeof r.type !== "string" || PROVIDER.test(r.type)) continue;
    keyOf.set(r.urn, `${label}/${urnTail(r.urn)}`);
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
      lexicon: "terraform",
      entityType: r.type as string,
      kind: "resource",
      props: {},
      references: [...references.values()],
      [DECLARABLE_MARKER]: true,
    } as unknown as Declarable);
  }

  return { entities, warnings: [], report: { export: PULUMI_EXPORT_FILE, objects: entities.size, exported: true } };
}

let lastReport: PulumiMemberReport | undefined;

/** The report of the read in this process, left for `graphMeta` (see the aws member reader). */
export function setLastMemberReport(report: PulumiMemberReport | undefined): void {
  lastReport = report;
}

export function lastMemberReport(): PulumiMemberReport | undefined {
  return lastReport;
}
