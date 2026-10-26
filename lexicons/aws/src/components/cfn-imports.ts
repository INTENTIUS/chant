/**
 * `Fn::ImportValue` between stacks (#4466): which exports a template
 * declares, which it imports, and the names they go by.
 *
 * A stack that imports another stack's export reads that stack, the way a
 * CDK app wires its stacks. The read sits inside the template, so core does
 * not see it in the step. `cfn-deploy`'s `declaredReads` finds it here: an
 * import of a name another `cfn-deploy` step's template exports is a read of
 * `<component>.<output>`, which core writes into the importer's step under
 * `imports` (`CfnDeployInput.imports`) and orders, holds and lists like any
 * other read.
 *
 * A name is a string, or an `Fn::Sub` (or `Fn::Join`, or `Ref`) over
 * parameters and pseudo parameters. It resolves where the values it reads
 * are known: a parameter with a plain value in the step's `inputs` or a
 * `Default` in the template, `AWS::StackName`, and the region's pseudo
 * parameters when `AWS_REGION` or `AWS_DEFAULT_REGION` names the region.
 * Anything else (`AWS::AccountId`, a resource attribute, a parameter wired
 * from another stack, an intrinsic this does not follow) leaves the name
 * unresolved, and the plan says so in a hole.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** A name an export or import goes by: resolved, or why not. */
export type CfnName = { name: string } | { unresolved: string };

/** One export a template declares: the output it is, and its name. */
export type CfnExport = { output: string } & CfnName;

/** One import in a template: where it sits, as a dotted path, the logical id it sits under, and its name. */
export type CfnImport = { at: string; logicalId: string } & CfnName;

/** The template at `path`, read against `root` when relative, as JSON; `undefined` for one that cannot be read or parsed, or an archive reference. */
export function readCfnTemplate(path: unknown, root?: string): Record<string, unknown> | undefined {
  if (typeof path !== "string" || path.startsWith("archive:")) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(root && !isAbsolute(path) ? resolve(root, path) : path, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The region the plan runs against, when the environment names it. */
function regionOf(env: NodeJS.ProcessEnv): string | undefined {
  return env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined;
}

/**
 * The pseudo parameters this plan knows for `stack`: `AWS::StackName`, and
 * `AWS::Region`, `AWS::Partition` and `AWS::URLSuffix` when the region is
 * named. `AWS::AccountId` and `AWS::StackId` are not known before apply.
 */
export function cfnPseudoParameters(stack: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { "AWS::StackName": stack };
  const region = regionOf(env);
  if (region) {
    out["AWS::Region"] = region;
    out["AWS::Partition"] = region.startsWith("cn-") ? "aws-cn" : region.startsWith("us-gov-") ? "aws-us-gov" : "aws";
    out["AWS::URLSuffix"] = region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
  }
  return out;
}

/**
 * The values a name in `template` can read for `stack`: each parameter's
 * `Default`, overlaid by the step's plain inputs (a string, a number or a
 * boolean; a wired reference or `undefined` is not known), and the pseudo
 * parameters.
 */
export function cfnKnownValues(
  template: Record<string, unknown> | undefined,
  stack: string,
  inputs: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  const plain = (v: unknown): string | undefined =>
    typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;
  const params = (template?.Parameters ?? {}) as Record<string, { Default?: unknown } | undefined>;
  for (const [k, p] of Object.entries(params)) {
    const d = plain(p?.Default);
    if (d !== undefined) out[k] = d;
  }
  for (const [k, v] of Object.entries(inputs ?? {})) {
    const s = plain(v);
    if (s !== undefined) out[k] = s;
  }
  return { ...out, ...cfnPseudoParameters(stack, env) };
}

/** Why a variable a name reads has no value here. */
function unknownVariable(v: string, known: Record<string, string>): string | undefined {
  if (v in known) return undefined;
  if (v.includes(".")) return `reads ${v}, a resource attribute`;
  if (v.startsWith("AWS::")) return `reads ${v}, which is known only at apply`;
  return `reads parameter ${v}, which has no value the plan knows`;
}

/**
 * The name `value` resolves to against `known`, or why it does not. A
 * string is itself; `Fn::Sub` substitutes `${X}` from `known` and its own
 * variables (`${!X}` is the literal `${X}`); `Ref` reads `known`;
 * `Fn::Join` joins what it resolves. Any other shape is unresolved.
 */
export function resolveCfnName(value: unknown, known: Record<string, string>): CfnName {
  if (typeof value === "string") return { name: value };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { unresolved: "is not a string or an intrinsic" };
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1) return { unresolved: "is not a string or an intrinsic" };
  const [key, arg] = entries[0]!;
  if (key === "Ref") {
    if (typeof arg !== "string") return { unresolved: "is a Ref without a name" };
    const why = unknownVariable(arg, known);
    return why ? { unresolved: why } : { name: known[arg]! };
  }
  if (key === "Fn::Sub") {
    const text = typeof arg === "string" ? arg : Array.isArray(arg) && typeof arg[0] === "string" ? arg[0] : undefined;
    if (text === undefined) return { unresolved: "is an Fn::Sub this plan cannot read" };
    const vars: Record<string, string> = { ...known };
    if (Array.isArray(arg) && arg[1] && typeof arg[1] === "object") {
      for (const [k, v] of Object.entries(arg[1] as Record<string, unknown>)) {
        const r = resolveCfnName(v, known);
        if ("unresolved" in r) return { unresolved: `its Fn::Sub variable ${k} ${r.unresolved}` };
        vars[k] = r.name;
      }
    }
    let why: string | undefined;
    const name = text.replace(/\$\{(!?)([^}]*)\}/g, (whole, bang: string, v: string) => {
      if (bang) return "${" + v + "}";
      const w = unknownVariable(v, vars);
      if (w) {
        why ??= w;
        return whole;
      }
      return vars[v]!;
    });
    return why ? { unresolved: why } : { name };
  }
  if (key === "Fn::Join") {
    if (!Array.isArray(arg) || typeof arg[0] !== "string" || !Array.isArray(arg[1])) return { unresolved: "is an Fn::Join this plan cannot read" };
    const parts: string[] = [];
    for (const part of arg[1] as unknown[]) {
      const r = resolveCfnName(part, known);
      if ("unresolved" in r) return r;
      parts.push(r.name);
    }
    return { name: parts.join(arg[0]) };
  }
  return { unresolved: `uses ${key}, which this plan does not follow` };
}

/** Every export `template` declares (`Outputs.<name>.Export.Name`), by output, sorted. */
export function cfnExports(template: Record<string, unknown> | undefined, known: Record<string, string>): CfnExport[] {
  const outputs = (template?.Outputs ?? {}) as Record<string, { Export?: { Name?: unknown } } | undefined>;
  const out: CfnExport[] = [];
  for (const [output, o] of Object.entries(outputs).sort(([a], [b]) => a.localeCompare(b))) {
    if (o?.Export === undefined) continue;
    out.push({ output, ...resolveCfnName(o.Export.Name, known) });
  }
  return out;
}

/**
 * Every `Fn::ImportValue` in `template`'s resources, outputs and conditions,
 * with where it sits and the name it imports, in template order. An import
 * whose argument is itself an import is listed once, unresolved.
 */
export function cfnImports(template: Record<string, unknown> | undefined, known: Record<string, string>): CfnImport[] {
  const out: CfnImport[] = [];
  const walk = (v: unknown, path: string, logicalId: string): void => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}.${i}`, logicalId));
    if (v === null || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "Fn::ImportValue") {
        out.push({ at: path, logicalId, ...resolveCfnName(x, known) });
        continue;
      }
      walk(x, `${path}.${k}`, logicalId);
    }
  };
  for (const section of ["Resources", "Outputs", "Conditions"] as const) {
    const s = template?.[section];
    if (s === null || typeof s !== "object") continue;
    for (const [id, body] of Object.entries(s as Record<string, unknown>)) walk(body, `${section}.${id}`, id);
  }
  return out;
}

/** The JSON Pointer `CfnDeployInput.imports[name]` sits at in a `cfn-deploy` step. */
export function cfnImportPointer(name: string): string {
  return "/imports/" + name.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** The stand-in parameter that takes an import's place in a preview: `ChantImport`, the name's letters and digits, and a short digest so two names never share one. */
export function cfnStandInParameter(name: string): string {
  return `ChantImport${name.replace(/[^A-Za-z0-9]/g, "").slice(0, 200)}${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
}

/**
 * A copy of `template` for a preview (#4466b): each `Fn::ImportValue` of a
 * name in `names` is a `Ref` to a stand-in `String` parameter, which the
 * preview fills with `cfnPlaceholder`. CloudFormation refuses a change set
 * that imports an export that does not exist yet, so the importer of a stack
 * the same change creates is planned against this copy. `standIns` maps each
 * stand-in parameter to the export it stands for; a name the template never
 * imports gets none.
 */
export function cfnTemplateWithStandIns(
  template: Record<string, unknown>,
  names: readonly string[],
  known: Record<string, string>,
): { template: Record<string, unknown>; standIns: Record<string, string> } {
  const wanted = new Set(names);
  const standIns: Record<string, string> = {};
  const swap = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(swap);
    if (v === null || typeof v !== "object") return v;
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 1 && entries[0]![0] === "Fn::ImportValue") {
      const r = resolveCfnName(entries[0]![1], known);
      if ("name" in r && wanted.has(r.name)) {
        const param = cfnStandInParameter(r.name);
        standIns[param] = r.name;
        return { Ref: param };
      }
      return v;
    }
    return Object.fromEntries(entries.map(([k, x]) => [k, swap(x)]));
  };
  const out: Record<string, unknown> = { ...template };
  for (const section of ["Resources", "Outputs", "Conditions"] as const) {
    if (template[section] !== undefined) out[section] = swap(template[section]);
  }
  if (Object.keys(standIns).length > 0) {
    const params = { ...((template.Parameters ?? {}) as Record<string, unknown>) };
    for (const [param, name] of Object.entries(standIns).sort(([a], [b]) => a.localeCompare(b))) {
      params[param] = { Type: "String", Description: `chant preview: stands in for Fn::ImportValue ${name}, known after its stack applies` };
    }
    out.Parameters = params;
  }
  return { template: out, standIns };
}
