/**
 * The Pulumi engine's member outputs (#4455): what core's `member-outputs`
 * verb reads a workspace member of kind `pulumi` through, the Pulumi half
 * beside the terraform lexicon's `choudoufuOutputSource`.
 *
 * - Applied values: `pulumi stack output --json --show-secrets=false` in the
 *   member's directory ({@link pulumiMemberStackOutputs}). With
 *   `applied: "export"` (or `CHANT_PULUMI_APPLIED_OUTPUTS=export` in the
 *   environment), chant runs nothing and reads the stack's outputs from the
 *   checked-in `stack-export.json` instead (`pulumiExportedStackOutputs`).
 *   That is for a machine with no pulumi login, where the export is what
 *   the member's pipeline last checked in.
 * - Planned values: `pulumi preview --json` through `previewPulumiMemberRead`,
 *   the stack step's outputs read by `pulumiPlannedStackOutputs`. An output
 *   holding Pulumi's unknown sentinel is unknown, which core turns into a
 *   hole on `<member>#outputs` naming the output and holds whatever reads it
 *   back until the member applied, the same path a choudoufu output takes.
 *   The plan digest is the member part's (`computePlanDigest("pulumi-preview",
 *   ...)`), so a preview that moves after review moves the consumer's digest.
 *
 * A member on plunge (`pulumiMemberEngine`: the member config, then a
 * `plunge` backend URL in `Pulumi.yaml`) runs the same two commands under
 * `plunge`.
 *
 * Secrets stay secret. `--show-secrets=false` prints a secret as
 * `[secret]`, an export holds it as ciphertext, and a preview as a secret
 * envelope; in every case the output is left out of what the source
 * returns, so chant never carries the value and never prints it. A
 * parameter that reads a secret output reads nothing: pass secrets through
 * the engine's own secret store, not chant parameters.
 *
 * Both commands pass `--stack` (#4514), by #4496's rule (`./run.ts`'s
 * `memberStack`): the member's declared stack, else the stack the checked-in
 * `stack-export.json` names in its URNs. The workspace declaration names no
 * stack for a member, so here it is the export's. A member with no export,
 * or one whose URNs name more than one stack, reads the selected stack.
 */
import type { DeployContext } from "@intentius/chant/components/capability";
import type { EngineMemberRef, EngineOutputSource, EnginePlannedOutputs } from "@intentius/chant/components/verbs/member-outputs";
import type { ChangeSetPart } from "@intentius/chant/change-set";
import { pulumiPlannedStackOutputs, pulumiExportedStackOutputs, type PulumiStackOutput } from "./stack-outputs";
import { previewPulumiMemberRead, pulumiMemberStackOutputs, readMemberExport, type PulumiMemberEngine, type PulumiRunner } from "./run";
import { isSecret } from "./values";
import { PULUMI_EXPORT_FILE } from "./workspace-member";

/** Where a member's applied outputs are read from. */
export type PulumiAppliedFrom = "cli" | "export";

/** The environment variable that makes the source read applied outputs from the checked-in export. */
export const PULUMI_APPLIED_OUTPUTS_ENV = "CHANT_PULUMI_APPLIED_OUTPUTS";

export interface PulumiOutputSourceOptions {
  /** Where applied values come from. Default: `export` when {@link PULUMI_APPLIED_OUTPUTS_ENV} says so, else `cli`. */
  applied?: PulumiAppliedFrom;
  /** The member's engine, when it is not taken from `Pulumi.yaml`. */
  engine?: PulumiMemberEngine;
  run?: PulumiRunner;
  plunge?: PulumiRunner;
}

/** The known values of a stack's outputs: unknown and secret ones left out. */
function knownValues(outputs: readonly PulumiStackOutput[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of outputs) if (!o.unknown && !o.secret) out[o.name] = o.value;
  return out;
}

/** `stack output --json` with the blinded secrets left out. */
function withoutSecrets(printed: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(printed).filter(([, v]) => !isSecret(v)));
}

/**
 * Whether the member's part has anything to apply: an entry that is not a
 * no-op or a read, or a hole. An export-only `mayAppear` update is left out:
 * it marks what the preview could not list, not a change it planned.
 */
export function pulumiPartHasChanges(part: ChangeSetPart): boolean {
  if (part.member.holes.length > 0) return true;
  return part.entries.some((e) => e.action !== "no-op" && e.action !== "read" && !(e.mayAppear === true && e.action === "update"));
}

/**
 * What a member's preview says about its stack outputs (#4455): the stack
 * step's outputs, unknowns named, secrets left out; the part's digest; and
 * whether it has changes. A failed preview throws, naming the member and
 * the preview's error. A preview that plans no stack outputs (no stack step,
 * or one without outputs, which is what a real `pulumi preview --json`
 * prints, #4475) gives the export's outputs when it plans nothing to apply,
 * since no apply will move them, and names every output the export holds
 * unknown otherwise, so nothing reads a value the preview did not plan.
 */
export function pulumiMemberPlannedOutputs(member: string, read: { part: ChangeSetPart; preview: unknown; exported?: unknown }): EnginePlannedOutputs {
  const { part } = read;
  if (part.member.status === "failed" || part.member.planDigest === null) {
    throw new Error(`member-outputs: the preview of Pulumi member "${member}" failed: ${part.member.error ?? "no plan"}`);
  }
  const planned = pulumiPlannedStackOutputs(read.preview);
  const changes = pulumiPartHasChanges(part);
  if (planned === undefined) {
    const exported = read.exported === undefined ? [] : pulumiExportedStackOutputs(read.exported);
    if (!changes) return { known: knownValues(exported), unknown: [], planDigest: part.member.planDigest, changes };
    return { known: {}, unknown: exported.filter((o) => !o.secret).map((o) => o.name), planDigest: part.member.planDigest, changes };
  }
  const unknown = planned.filter((o) => o.unknown).map((o) => o.name);
  return { known: knownValues(planned), unknown, planDigest: part.member.planDigest, changes: changes || unknown.length > 0 };
}

/** The applied outputs a `pulumi stack export` records, secrets left out. */
export function pulumiExportedOutputValues(exported: unknown): Record<string, unknown> {
  return knownValues(pulumiExportedStackOutputs(exported));
}

/** A Pulumi member's outputs for `member-outputs`, `kinds: ["pulumi"]`. */
export function pulumiOutputSource(options: PulumiOutputSourceOptions = {}): EngineOutputSource {
  const appliedFrom = (): PulumiAppliedFrom => options.applied ?? (process.env[PULUMI_APPLIED_OUTPUTS_ENV] === "export" ? "export" : "cli");
  const runners = { ...(options.run ? { run: options.run } : {}), ...(options.plunge ? { plunge: options.plunge } : {}), ...(options.engine ? { engine: options.engine } : {}) };
  return {
    kinds: ["pulumi"],
    async applied(_ctx: DeployContext, ref: EngineMemberRef) {
      if (appliedFrom() === "export") {
        const exported = readMemberExport(ref.dir);
        if (exported === undefined) {
          throw new Error(`member-outputs: Pulumi member "${ref.member}" has no readable ${PULUMI_EXPORT_FILE} in ${ref.dir}, and its outputs are read from the export (${PULUMI_APPLIED_OUTPUTS_ENV}=export)`);
        }
        return pulumiExportedOutputValues(exported);
      }
      return withoutSecrets(await pulumiMemberStackOutputs({ dir: ref.dir, ...runners }));
    },
    async planned(_ctx: DeployContext, ref: EngineMemberRef) {
      const read = await previewPulumiMemberRead({ member: ref.member, dir: ref.dir, ...runners });
      return pulumiMemberPlannedOutputs(ref.member, { ...read, exported: readMemberExport(ref.dir) });
    },
  };
}

/** The source the lexicon's capability plugin contributes. */
export const pulumiStackOutputSource: EngineOutputSource = pulumiOutputSource();
