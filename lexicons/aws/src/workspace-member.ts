/**
 * Reading a cloudformation workspace member into the graph (#3179).
 *
 * `chant workspace graph` writes a reader project for a member of kind
 * `cloudformation`, with `aws.member` in its config (see `workspace-kinds.json`).
 * The plugin's `buildRoots` hook calls {@link readCloudFormationMember}: each
 * CloudFormation template directly in the member's directory is parsed with the
 * import parser's YAML schema (short-form tags included), and every resource
 * becomes a node keyed `<label>/<LogicalId>`.
 *
 * Edges come from what the template says: `Ref`, `Fn::GetAtt` and the `${...}`
 * references in `Fn::Sub`, wherever they sit in a resource's properties, plus
 * `DependsOn`. Parameters, pseudo parameters and names that are not a resource
 * of the same template (`AWS::Region`, an `Fn::ImportValue`) draw no edge.
 * Nothing runs and no AWS call is made.
 *
 * A `cdk` member is read the same way from the cloud assembly its app already
 * synthesized (`cdk.out`, or the `output` its cdk.json names): the assembly's
 * `*.template.json` files are CloudFormation templates, and core's CDK
 * assembly reader says whether the directory is one. chant does not run the
 * app. With no assembly there is nothing to read, and the report says
 * `synthesized: false` with the reason.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import yaml from "js-yaml";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { EntityReference } from "@intentius/chant/graph-ir";
import { isCloudAssembly } from "@intentius/chant/cdk/assembly";
import { CF_SCHEMA } from "./import/parser";

export interface AwsMemberConfig {
  /** `cloudformation` (the default) or `cdk`. */
  kind?: "cloudformation" | "cdk";
  /** The member's directory, absolute. */
  dir: string;
  /** Names the entities (`<label>/Bucket`): the member's name. */
  label?: string;
}

/** What the read found, carried on the graph's `meta.awsMember`. */
export interface AwsMemberReport {
  /** The template files read, relative to the member's directory (or its assembly's). */
  templates: string[];
  objects: number;
  /** CDK only: false when the app has no synthesized assembly to read. */
  synthesized?: boolean;
  /** Why nothing was read; set with `synthesized: false`. */
  reason?: string;
}

type Template = { Resources?: Record<string, { Type?: unknown; Properties?: Record<string, unknown>; DependsOn?: unknown }> };
type Name = { id: string; attr?: string };

function parseTemplate(text: string): Template | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = yaml.load(text, { schema: CF_SCHEMA });
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const t = parsed as Record<string, unknown>;
  // The probe's two claims: a format version, or a Resources section.
  const resources = t.Resources;
  if (t.AWSTemplateFormatVersion === undefined && (!resources || typeof resources !== "object")) return undefined;
  return t as Template;
}

/** Logical ids named by `${X}` and `${X.Attr}` in an `Fn::Sub` string, with the attribute when one is named. */
function subReferences(text: string): Name[] {
  const out: Name[] = [];
  for (const m of text.matchAll(/\$\{([^}!][^}]*)\}/g)) {
    const [id, ...rest] = m[1]!.trim().split(".");
    if (id) out.push({ id, ...(rest.length ? { attr: rest.join(".") } : {}) });
  }
  return out;
}

/** Every name a value reaches through Ref, Fn::GetAtt or Fn::Sub. */
function collectNames(value: unknown, out: Name[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collectNames(v, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (k === "Ref" && typeof v === "string") {
      out.push({ id: v });
    } else if (k === "Fn::GetAtt") {
      const [id, attr] = Array.isArray(v) ? v : typeof v === "string" ? [v.slice(0, v.indexOf(".")), v.slice(v.indexOf(".") + 1)] : [];
      if (typeof id === "string" && id) out.push({ id, ...(typeof attr === "string" && attr ? { attr } : {}) });
    } else if (k === "Fn::Sub") {
      const text = Array.isArray(v) ? v[0] : v;
      if (typeof text === "string") out.push(...subReferences(text));
      if (Array.isArray(v)) collectNames(v[1], out);
    } else {
      collectNames(v, out);
    }
  }
}

/** The directory a CDK app synthesizes into: cdk.json's `output`, else `cdk.out`. */
function cdkOutput(dir: string): string {
  try {
    const output = (JSON.parse(readFileSync(join(dir, "cdk.json"), "utf-8")) as { output?: unknown }).output;
    if (typeof output === "string" && output) return output;
  } catch {
    /* no readable cdk.json: the default */
  }
  return "cdk.out";
}

export function readCloudFormationMember(opts: { member: AwsMemberConfig }): {
  entities: Map<string, Declarable>;
  warnings: string[];
  report: AwsMemberReport;
} {
  const { member } = opts;
  const label = member.label ?? basename(member.dir);
  const warnings: string[] = [];
  const templates: Array<{ file: string; template: Template }> = [];
  let source = member.dir;
  if (member.kind === "cdk") {
    source = join(member.dir, cdkOutput(member.dir));
    if (!isCloudAssembly(source)) {
      const reason = `no synthesized cloud assembly at ${source}; run \`cdk synth\` in the app, and chant will read the templates it writes`;
      warnings.push(`cdk member "${label}" was not read: ${reason}`);
      return { entities: new Map(), warnings, report: { templates: [], objects: 0, synthesized: false, reason } };
    }
  }
  const pattern = member.kind === "cdk" ? /\.template\.json$/ : /\.(ya?ml|json|template)$/;
  for (const file of readdirSync(source).filter((f) => pattern.test(f)).sort()) {
    const template = parseTemplate(readFileSync(join(source, file), "utf-8"));
    if (template) templates.push({ file, template });
  }

  const entities = new Map<string, Declarable>();
  for (const { file, template } of templates) {
    // One template per member is the usual case and keeps ids short; two share a directory, so the file name qualifies them.
    const prefix = templates.length === 1 ? label : `${label}/${basename(file, extname(file)).replace(/\.template$/, "")}`;
    const resources = Object.entries(template.Resources ?? {}).filter(([, r]) => typeof r?.Type === "string");
    const keyOf = new Map(resources.map(([id]) => [id, `${prefix}/${id}`]));
    for (const [id, resource] of resources) {
      const references = new Map<string, EntityReference>();
      const add = (name: Name, via: string) => {
        const to = keyOf.get(name.id);
        if (!to || to === keyOf.get(id)) return;
        references.set(`${to}|${via}|${name.attr ?? ""}`, { to, viaAttr: via, ...(name.attr ? { toAttr: name.attr } : {}) });
      };
      for (const [prop, value] of Object.entries(resource.Properties ?? {})) {
        const names: Name[] = [];
        collectNames(value, names);
        for (const n of names) add(n, prop);
      }
      const dependsOn = resource.DependsOn;
      for (const d of Array.isArray(dependsOn) ? dependsOn : dependsOn === undefined ? [] : [dependsOn]) {
        if (typeof d === "string") add({ id: d }, "DependsOn");
      }
      const entity = {
        lexicon: "aws",
        entityType: resource.Type as string,
        kind: "resource",
        props: { ...(resource.Properties ?? {}) },
        references: [...references.values()],
        [DECLARABLE_MARKER]: true,
      } as unknown as Declarable;
      entities.set(keyOf.get(id)!, entity);
    }
  }
  if (templates.length === 0) warnings.push(`${member.kind ?? "cloudformation"} member "${label}" has no CloudFormation template directly in ${source}`);

  return {
    entities,
    warnings,
    report: { templates: templates.map((t) => t.file), objects: entities.size, ...(member.kind === "cdk" ? { synthesized: true } : {}) },
  };
}

let lastReport: AwsMemberReport | undefined;

/**
 * The report of the read in this process. `graphMeta` receives only the
 * entities, so the hook that read the member leaves its report here for the
 * hook that publishes it; `chant graph` runs the two in order in one process.
 */
export function setLastMemberReport(report: AwsMemberReport | undefined): void {
  lastReport = report;
}

export function lastMemberReport(): AwsMemberReport | undefined {
  return lastReport;
}
