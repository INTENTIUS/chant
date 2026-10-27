/**
 * What PUL003 to PUL015 share: the member read the plugin's `buildRoots`
 * left behind (`lastMemberRead`, `../../workspace-member.ts`) and the
 * resources of its checked-in `pulumi stack export`.
 *
 * The checks read the export, not the build's output: this lexicon's
 * serializer writes `{}`, and the export is the only thing a pulumi member
 * contributes to a build. Each check is silent in a build that read no
 * member, and in one whose export did not read (PUL001 reports that).
 *
 * The export fields read here are `apitype.ResourceV3`'s: `urn`, `type`,
 * `parent`, `dependencies`, `inputs`, `outputs`, `external`, `delete`,
 * `pendingReplacement` and `taint`. Nothing here exports no check, so the
 * barrel generator skips the file and `chant dev check-lexicon` does not count
 * it (`-helpers.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { Severity } from "@intentius/chant/lint/rule";
import { parsePulumiUrn, pulumiNodeKey } from "@intentius/chant/pulumi-urn";
import { parseYAML } from "@intentius/chant/yaml";
import { isObject, PULUMI_SECRET_SIG, PULUMI_SIG_KEY } from "../../values";
import { lastMemberRead, type PulumiMemberRead } from "../../workspace-member";

/** One resource of the export, with the fields the checks read. */
export interface ExportResource {
  urn: string;
  type: string;
  parent?: unknown;
  dependencies?: unknown;
  inputs?: unknown;
  outputs?: unknown;
  external?: unknown;
  delete?: unknown;
  pendingReplacement?: unknown;
  taint?: unknown;
}

/** The member read and its export's resources, or undefined when no member was read or its export did not read. */
export function memberExport(): { read: PulumiMemberRead; doc: Record<string, unknown>; resources: ExportResource[] } | undefined {
  const read = lastMemberRead();
  if (!read || !isObject(read.doc)) return undefined;
  const deployment = isObject(read.doc.deployment) ? read.doc.deployment : undefined;
  const list = deployment && Array.isArray(deployment.resources) ? deployment.resources : [];
  const resources = list.filter(
    (r): r is ExportResource => isObject(r) && typeof r.urn === "string" && typeof r.type === "string",
  );
  return { read, doc: read.doc, resources };
}

/** The node a resource lands on (`<label>/<urn tail>`), or its URN when it has none. */
export function entityOf(read: PulumiMemberRead, urn: string): string {
  const tail = pulumiNodeKey(urn);
  return tail === null ? urn : `${read.label}/${tail}`;
}

/** A pulumi diagnostic about one member. */
export function finding(checkId: string, severity: Severity, message: string, entity?: string): PostSynthDiagnostic {
  return { checkId, severity, message, lexicon: "pulumi", ...(entity ? { entity } : {}) };
}

/** The resources whose export entry sets `field` to true. */
export function flagged(resources: readonly ExportResource[], field: "external" | "delete" | "pendingReplacement" | "taint"): ExportResource[] {
  return resources.filter((r) => r[field] === true);
}

/**
 * The paths under `inputs` and `outputs` that hold a secret in plaintext: a
 * secret envelope (`{ [PULUMI_SIG_KEY]: PULUMI_SECRET_SIG, ... }`) with a
 * `plaintext` field. `pulumi stack export` writes `ciphertext` there;
 * `pulumi stack export --show-secrets` writes `plaintext`.
 */
export function plaintextSecretPaths(resource: ExportResource): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (!isObject(v)) return;
    if (v[PULUMI_SIG_KEY] === PULUMI_SECRET_SIG) {
      if ("plaintext" in v) out.push(path);
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(resource.inputs, "inputs");
  walk(resource.outputs, "outputs");
  return out;
}

/** The distinct stacks and projects the export's URNs name. */
export function urnScopes(resources: readonly ExportResource[]): { stacks: string[]; projects: string[] } {
  const stacks = new Set<string>();
  const projects = new Set<string>();
  for (const r of resources) {
    const parsed = parsePulumiUrn(r.urn);
    if (!parsed) continue;
    stacks.add(parsed.stack);
    projects.add(parsed.project);
  }
  return { stacks: [...stacks].sort(), projects: [...projects].sort() };
}

/** `name` from the member's `Pulumi.yaml`, or undefined when it has none or does not parse. */
export function pulumiYamlName(dir: string): string | undefined {
  const file = join(dir, "Pulumi.yaml");
  if (!existsSync(file)) return undefined;
  try {
    const doc = parseYAML(readFileSync(file, "utf-8")) as { name?: unknown };
    return typeof doc?.name === "string" && doc.name.length > 0 ? doc.name : undefined;
  } catch {
    return undefined;
  }
}

/** A list for a message: the first few, then how many more. */
export function listed(items: readonly string[], max = 3): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}
