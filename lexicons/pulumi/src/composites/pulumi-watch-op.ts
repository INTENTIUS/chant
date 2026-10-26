/**
 * PulumiWatchOp composite (#4494): watch one Pulumi member on a schedule, the
 * pulumi twin of the terraform lexicon's `TerraformWatchOp`.
 *
 * Two phases, both read-only:
 *
 * - Preview: `pulumiPreview`, `pulumi preview --json` in the member's
 *   directory. Its `changed` is the run's `Changes` outcome: true when the
 *   program plans anything the stack does not hold, a resource that may
 *   appear on apply included.
 * - Drift: `pulumiDrift`, one `pulumi refresh --preview-only --json --target
 *   <urn>` per resource in the checked-in `stack-export.json` (`plunge drift
 *   --resource <urn> --stream` for a member on plunge). Its `drifted` count,
 *   drifted plus missing, is the run's `Drift` outcome. Set `drift: false` to
 *   leave the phase out.
 *
 * Nothing here applies. chant never runs `pulumi up`, so a watch reports and
 * the stack's owner acts.
 *
 * The cron lands on the Op as `schedule`, the field `TerraformWatchOp` sets:
 * `chant operator` reads it as the Op's tick cadence and `generateOpsPipeline`
 * renders it as a CI cron. A one-shot `chant run` ignores it.
 *
 * @example
 * ```typescript
 * import { PulumiWatchOp } from "@intentius/chant-lexicon-pulumi";
 *
 * export const { op } = PulumiWatchOp({
 *   name: "infra-watch",
 *   member: "infra",
 *   dir: "./infra",
 *   stack: "dev",
 *   schedule: "0 6 * * *",
 * });
 * ```
 */
import { Op, phase, OpResource } from "@intentius/chant/op";
import { pulumiDrift, pulumiPreview } from "../op/builders";
import type { PulumiMemberEngine } from "../run";

export interface PulumiWatchOpConfig {
  /** Op name (kebab-case). */
  name: string;
  /** The member's name, as the change set and the drift records name it. */
  member: string;
  /** The member's directory, where `Pulumi.yaml` is, relative to the project root. */
  dir: string;
  /** The stack to read. Default: the stack the directory has selected. */
  stack?: string;
  /** `pulumi` or `plunge`. Default: what `Pulumi.yaml`'s backend URL says. */
  engine?: PulumiMemberEngine;
  /** Run the Drift phase. Default true. */
  drift?: boolean;
  /** Cron expression for the Op's `schedule`. */
  schedule?: string;
}

export interface PulumiWatchOpResources {
  /** Op resource. Preview, then Drift unless `drift: false`. */
  op: InstanceType<typeof OpResource>;
}

export function PulumiWatchOp(config: PulumiWatchOpConfig): PulumiWatchOpResources {
  const { name, member, dir, stack, engine, schedule } = config;
  const common = { dir, ...(stack ? { stack } : {}), ...(engine ? { engine } : {}) };

  const preview = pulumiPreview(member, { ...common, id: "preview" });
  preview.outcomeAttribute = { name: "Changes", from: "changed" };
  const phases = [phase("Preview", [preview])];

  if (config.drift !== false) {
    const drift = pulumiDrift(member, { ...common, id: "drift" });
    drift.outcomeAttribute = { name: "Drift", from: "drifted" };
    phases.push(phase("Drift", [drift]));
  }

  const op = Op({
    name,
    overview: `Preview the ${member} Pulumi member${config.drift === false ? "" : " and read its drift"}; changes nothing`,
    labels: { Surface: "pulumi-watch" },
    ...(schedule ? { schedule: { cron: schedule, overlap: "skip" as const } } : {}),
    phases,
  });
  return { op };
}
