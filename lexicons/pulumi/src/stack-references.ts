/**
 * `StackReference` between stacks (#4547): which stacks a stack's program
 * reads, from its export, as reads between `pulumi-up` components.
 *
 * A program that reads another stack's outputs holds a
 * `pulumi:pulumi:StackReference` resource. Its `inputs.name` names the stack
 * (`<org>/<project>/<stack>`, `<project>/<stack>`, or `<stack>` for one in
 * the same project), and its `outputs.outputs` record the outputs the
 * referenced stack had when the program last read it, with the secret ones
 * listed in `outputs.secretOutputNames`.
 *
 * `pulumi-up`'s `declaredReads` (`./pulumi-up.ts`) reads each step's export
 * (the index store's, else the checked-in `stack-export.json`, #4546) and
 * matches each reference to the one other `pulumi-up` step whose
 * `Pulumi.yaml` `name` and `stack` it names. Core then writes a
 * `stackOutput()` of each recorded output the reference reads into the
 * reader's `stackReferences` input and a `dependsOn` on the upstream, so
 * waves put the referenced stack first, a failed upstream holds the reader,
 * and a reader whose upstream's plan cannot say a value waits for its `up`.
 *
 * What adds no edge, and is reported on the plan by name
 * (`PulumiUpArtifact.stackReferences.outside`): a reference to a stack no
 * step in the project applies, one two steps could own, and one whose
 * export recorded no output that is not secret (core reads a stack's
 * outputs blind, so a secret one has no value to wire).
 */
import { isObject } from "./values";

export const PULUMI_STACK_REFERENCE_TYPE = "pulumi:pulumi:StackReference";

/** One `StackReference` an export holds. */
export interface PulumiStackReference {
  urn: string;
  /** `inputs.name`, as the program wrote it. */
  name: string;
  org?: string;
  /** Absent when the name is a bare stack in the reader's own project. */
  project?: string;
  stack: string;
  /** The referenced stack's outputs the export recorded, secret ones left out, sorted. */
  outputs: string[];
  /** Recorded outputs that are secret. */
  secretOutputs: string[];
}

/** `<org>/<project>/<stack>`, `<project>/<stack>` or `<stack>`, split; undefined for anything else. */
export function parsePulumiStackName(name: string): { org?: string; project?: string; stack: string } | undefined {
  const parts = name.split("/");
  if (parts.some((p) => p === "")) return undefined;
  if (parts.length === 1) return { stack: parts[0]! };
  if (parts.length === 2) return { project: parts[0]!, stack: parts[1]! };
  if (parts.length === 3) return { org: parts[0]!, project: parts[1]!, stack: parts[2]! };
  return undefined;
}

/** Every `StackReference` in an export whose name reads, in URN order. */
export function pulumiStackReferences(exported: unknown): PulumiStackReference[] {
  const deployment = isObject(exported) && isObject(exported.deployment) ? exported.deployment : undefined;
  const list = deployment && Array.isArray(deployment.resources) ? deployment.resources : [];
  const out: PulumiStackReference[] = [];
  for (const r of list) {
    if (!isObject(r) || r.type !== PULUMI_STACK_REFERENCE_TYPE || typeof r.urn !== "string") continue;
    const inputs = isObject(r.inputs) ? r.inputs : {};
    const outputs = isObject(r.outputs) ? r.outputs : {};
    const name = typeof inputs.name === "string" ? inputs.name : typeof outputs.name === "string" ? outputs.name : undefined;
    if (!name) continue;
    const parsed = parsePulumiStackName(name);
    if (!parsed) continue;
    const recorded = isObject(outputs.outputs) ? Object.keys(outputs.outputs) : [];
    const secret = new Set(Array.isArray(outputs.secretOutputNames) ? outputs.secretOutputNames.filter((s): s is string => typeof s === "string") : []);
    out.push({
      urn: r.urn,
      name,
      ...parsed,
      outputs: recorded.filter((k) => !secret.has(k)).sort(),
      secretOutputs: recorded.filter((k) => secret.has(k)).sort(),
    });
  }
  return out.sort((a, b) => (a.urn < b.urn ? -1 : a.urn > b.urn ? 1 : 0));
}

/** A step a reference may name: its component, project and stack. */
export interface PulumiStackOwner {
  component: string;
  project: string;
  stack: string;
}

/**
 * The one owner a reference names, or why there is none. A bare stack name
 * is in the reader's own project. The org is not compared: a step names no
 * org, and two orgs with one project and stack in one change are not a case
 * a workspace has.
 */
export function stackReferenceOwner(
  ref: PulumiStackReference,
  reader: { component: string; project: string },
  owners: readonly PulumiStackOwner[],
): { owner: PulumiStackOwner } | { outside: string } {
  const project = ref.project ?? reader.project;
  const found = owners.filter((o) => o.component !== reader.component && o.project === project && o.stack === ref.stack);
  if (found.length === 1) return { owner: found[0]! };
  if (found.length > 1) return { outside: `${ref.name} could be any of ${found.map((o) => o.component).join(", ")}` };
  return { outside: `${ref.name} is not a stack any pulumi-up step in this project applies` };
}

/** A JSON Pointer segment, escaped (RFC 6901). */
export function pointerSegment(s: string): string {
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}
