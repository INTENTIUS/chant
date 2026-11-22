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
 *
 * A `cloudformation` member can also name deployed stacks (#5455): a
 * `cloudformation-stacks.json` in its directory, `{ "stacks": ["<name>"],
 * "region": "<region>" }`. For a stack another pipeline deployed, whose
 * template is not in the repository, {@link readDeployedStacks} reads the
 * template CloudFormation holds (`GetTemplate`, the processed stage, so a
 * transform's resources are in it), the resources with their physical ids
 * (`DescribeStackResources`) and the outputs (`DescribeStacks`). The template
 * goes through the same reader as a file, so the edges are the same ones.
 * The three calls only read; a stack that cannot be read is named in a warning
 * and in `meta.awsMember.stacks`, with the credentials and region the read
 * needs, and does not fail the graph.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import yaml from "js-yaml";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { EntityReference } from "@intentius/chant/graph-ir";
import { isCloudAssembly } from "@intentius/chant/cdk/assembly";
import { CF_SCHEMA } from "./import/parser";
import { AwsReadError, cfnQuery, describeStackResources, xmlLeaves, xmlMembers, type AwsReadClientOptions } from "./api/read-client";

/** The file in a member's directory that names the deployed stacks to read (#5455). */
export const STACKS_FILE = "cloudformation-stacks.json";

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
  /** Set when the member names deployed stacks: what each read found. */
  stacks?: DeployedStackReport[];
}

/** One resource of a deployed stack: the node it is drawn as, and what CloudFormation says it is. */
export interface DeployedResource {
  /** The graph node's id, `<member>/<LogicalId>` (`<member>/<stack>/<LogicalId>` with several templates). */
  node: string;
  logicalId: string;
  type: string;
  physicalId?: string;
  status?: string;
}

/** What reading one named stack found, on `meta.awsMember.stacks`. */
export interface DeployedStackReport {
  name: string;
  region?: string;
  /** True when the template was read and drawn. */
  read: boolean;
  /** `StackStatus`, such as `UPDATE_COMPLETE`. */
  status?: string;
  /** Why the stack was not read; set with `read: false`. */
  reason?: string;
  resources: DeployedResource[];
  outputs: Record<string, string>;
}

/** A deployed stack's template, read and parsed, ready to join the member's templates. */
export interface DeployedStack {
  name: string;
  template: Template;
  resources: Array<{ logicalId: string; type: string; physicalId?: string; status?: string }>;
  report: DeployedStackReport;
}

export type Template = { Resources?: Record<string, { Type?: unknown; Properties?: Record<string, unknown>; DependsOn?: unknown }> };
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

export function readCloudFormationMember(opts: { member: AwsMemberConfig; deployed?: DeployedStack[]; stackReports?: DeployedStackReport[] }): {
  entities: Map<string, Declarable>;
  warnings: string[];
  report: AwsMemberReport;
} {
  const { member } = opts;
  const deployed = opts.deployed ?? [];
  const stackReports = opts.stackReports ?? (deployed.length > 0 ? deployed.map((d) => d.report) : undefined);
  const label = member.label ?? basename(member.dir);
  const warnings: string[] = [];
  const templates: Array<{ file: string; template: Template; deployed?: DeployedStack }> = [];
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
  for (const d of deployed) templates.push({ file: d.name, template: d.template, deployed: d });

  const entities = new Map<string, Declarable>();
  for (const { file, template, deployed: stack } of templates) {
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
    if (stack) {
      const live = new Map(stack.resources.map((r) => [r.logicalId, r]));
      for (const [id] of resources) {
        const found = live.get(id);
        stack.report.resources.push({
          node: keyOf.get(id)!,
          logicalId: id,
          type: found?.type || String((template.Resources?.[id] as { Type?: unknown }).Type),
          ...(found?.physicalId ? { physicalId: found.physicalId } : {}),
          ...(found?.status ? { status: found.status } : {}),
        });
      }
    }
  }
  if (templates.length === 0) warnings.push(`${member.kind ?? "cloudformation"} member "${label}" has no CloudFormation template directly in ${source}`);

  return {
    entities,
    warnings,
    report: {
      templates: templates.filter((t) => !t.deployed).map((t) => t.file),
      objects: entities.size,
      ...(member.kind === "cdk" ? { synthesized: true } : {}),
      ...(stackReports ? { stacks: stackReports } : {}),
    },
  };
}

/** What a member's `cloudformation-stacks.json` says. */
export interface StacksFile {
  stacks: string[];
  region?: string;
}

/**
 * The member's `cloudformation-stacks.json`, or undefined when it has none.
 * A file that is not `{ "stacks": [string, ...], "region"?: string }` is an
 * error with the reason, so the member is not silently read as empty.
 */
export function readStacksFile(dir: string): StacksFile | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, STACKS_FILE), "utf-8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${STACKS_FILE} is not JSON: ${(e as Error).message}`);
  }
  const o = parsed as { stacks?: unknown; region?: unknown };
  if (!o || typeof o !== "object" || !Array.isArray(o.stacks) || o.stacks.length === 0 || !o.stacks.every((n) => typeof n === "string" && n.length > 0)) {
    throw new Error(`${STACKS_FILE} must be { "stacks": ["<stack name>", ...], "region": "<region>" } with at least one stack name`);
  }
  if (o.region !== undefined && (typeof o.region !== "string" || !o.region)) throw new Error(`${STACKS_FILE}: "region" must be a region name`);
  return { stacks: o.stacks as string[], ...(o.region ? { region: o.region as string } : {}) };
}

/** The error codes that mean the credentials, not the stack, are the trouble. */
const CREDENTIAL_CODES = new Set([
  "MissingAuthenticationToken",
  "InvalidClientTokenId",
  "ExpiredToken",
  "ExpiredTokenException",
  "AccessDenied",
  "AccessDeniedException",
  "UnrecognizedClientException",
  "SignatureDoesNotMatch",
  "IncompleteSignature",
]);

const NEEDS =
  "the read needs AWS credentials that allow cloudformation:DescribeStacks, cloudformation:DescribeStackResources and cloudformation:GetTemplate (set AWS_PROFILE, or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY) and the stack's region";

/** Test seam: the read options the plugin's `buildRoots` reads deployed stacks with (a fake `http`, an endpoint). */
let stackReadOptions: AwsReadClientOptions = {};
export function setStackReadOptions(options: AwsReadClientOptions): void {
  stackReadOptions = options;
}

/**
 * Read each stack the member's `cloudformation-stacks.json` names: its
 * template, resources and outputs. Read only, three CloudFormation calls per
 * stack. One stack that cannot be read is a warning and a `read: false` entry
 * with the reason, and the rest are still read.
 */
export async function readDeployedStacks(
  member: AwsMemberConfig,
  options: AwsReadClientOptions = stackReadOptions,
): Promise<{ deployed: DeployedStack[]; reports: DeployedStackReport[]; warnings: string[] } | undefined> {
  if (member.kind === "cdk") return undefined;
  const file = readStacksFile(member.dir);
  if (!file) return undefined;
  const label = member.label ?? basename(member.dir);
  const env = options.env ?? process.env;
  const region = file.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  const deployed: DeployedStack[] = [];
  const reports: DeployedStackReport[] = [];
  const warnings: string[] = [];
  for (const name of file.stacks) {
    const report: DeployedStackReport = { name, ...(region ? { region } : {}), read: false, resources: [], outputs: {} };
    reports.push(report);
    if (!region) {
      report.reason = `no region: name one in ${STACKS_FILE} ("region") or set AWS_REGION`;
      warnings.push(`cloudformation member "${label}": stack "${name}" was not read: ${report.reason}`);
      continue;
    }
    try {
      const client: AwsReadClientOptions = { ...options, region };
      const described = await cfnQuery("DescribeStacks", { StackName: name }, client);
      report.status = /<StackStatus>([^<]*)<\/StackStatus>/.exec(described)?.[1];
      for (const m of xmlMembers(described, "Outputs")) if (m.OutputKey) report.outputs[m.OutputKey] = m.OutputValue ?? "";
      const body = xmlLeaves(await cfnQuery("GetTemplate", { StackName: name, TemplateStage: "Processed" }, client)).TemplateBody;
      const template = body ? parseTemplate(body) : undefined;
      if (!template) throw new Error(`the template CloudFormation holds for ${name} is not one chant can read`);
      const resources = await describeStackResources(name, client);
      report.read = true;
      deployed.push({ name, template, resources, report });
    } catch (e) {
      const err = e as Error;
      const code = err instanceof AwsReadError ? err.code : undefined;
      const needsCredentials = err instanceof AwsReadError && (CREDENTIAL_CODES.has(code ?? "") || err.status === 401 || err.status === 403);
      report.reason =
        code === "ValidationError" && /does not exist/i.test(err.message)
          ? `no stack named ${name} in ${region}`
          : needsCredentials
            ? `${err.message}; ${NEEDS}`
            : err.message;
      warnings.push(`cloudformation member "${label}": stack "${name}" in ${region} was not read: ${report.reason}`);
    }
  }
  return { deployed, reports, warnings };
}

export { lastMemberReport, setLastMemberReport } from "./member-report";
