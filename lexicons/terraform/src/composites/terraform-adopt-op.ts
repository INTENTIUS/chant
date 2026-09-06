/**
 * TerraformAdoptOp composite (#2105): claim the live resources a choudoufu
 * estate's configuration already describes.
 *
 * The reconcile position on the lifecycle dial, for the one backend that has
 * a typed path from live back to the configuration. chant #2089 deferred
 * reconcile for the terraform lexicon because stock Terraform has none: a live
 * resource nobody has imported is knowable only as HCL somebody writes, and
 * generating that is a different problem. choudoufu changes the question
 * rather than answering the old one. Ownership there is two tags on the
 * resource (`live/MARKERS.md`), `live-plan` already names every live resource
 * that exactly matches a declared block and carries no marker, and it prints
 * the two values that would claim it. Cloud-to-code here is "claim what the
 * configuration already describes" — a tag write, not a regeneration.
 *
 * Phases: Check, Ledger, Gate, Adopt.
 *
 *   - **Check** runs `live-check`, which makes no cloud calls and says whether
 *     this configuration can move under markers at all. It runs first because
 *     a root that `live-check` refuses will produce an adoption ledger that
 *     reads as authoritative and is not, and the cheapest place to find that
 *     out is before the estate-wide sweep.
 *   - **Ledger** runs `live-plan` with `adoptionOnly`, so the run's human half
 *     is choudoufu's own adoption ledger (GitHub issue #587) and its machine
 *     half is the bound/omissions/unowned document (#788). The ledger is the
 *     approval subject; the document is what the Adopt step acts on.
 *   - **Gate** always. Adoption writes tags onto resources this estate does
 *     not yet own, which is the moment the estate's boundary moves, and no
 *     reading of that is routine enough to skip. There is no `gate: "never"`
 *     here, unlike `TerraformApplyOp`, so every run stops at the gate until
 *     someone has approved it. A gate is a fact on the gate ledger (#2119):
 *     `chant run` records that the run is waiting, ends with status `gated`
 *     and exits 3, `chant approve <op> <gate>` writes the resolution, and the
 *     next run reads it and walks through to the Adopt phase.
 *   - **Adopt** writes the markers. See `choudoufuAdopt`'s own doc for the
 *     mechanism and why it is the tag write rather than choudoufu's `adopt`
 *     policy verb.
 *
 * ## The adopt mechanism, and why it is not the policy verb
 *
 * choudoufu's `policy` block has an `adopt` verb for the declared-but-unmarked
 * quadrant, and its migration guide names `policy { declared_untagged =
 * "adopt" }` as the way to claim a whole estate at once. That is the smaller
 * write, and #2105 tried to reach it from outside the configuration. It is not
 * reachable: a `live` block in a terraform override file is dropped in silence
 * (choudoufu's `Module.mergeFile` has no `Lives` case), a second primary file
 * carrying one is refused as a duplicate, and a sidecar beside an in-block
 * form is refused as two sources of truth. What is left is editing the root's
 * own checked-in live configuration around an apply, which leaves an estate
 * declaring "adopt everything declared and unmarked" if the run dies between
 * the two edits.
 *
 * So the mechanism is the tag write, which choudoufu's migration guide calls
 * the whole contract: "There is no `choudoufu adopt` command and no need for
 * one. Two tags is the whole contract, so any tool that writes two tags can
 * adopt a resource." Each write runs the paste-ready command choudoufu itself
 * printed in the ledger, carrying its own provider configuration's region and
 * endpoint. `choudoufuAdopt` has the measurements behind that ruling.
 *
 * ## Ambiguity is reported, never resolved
 *
 * Two live resources at one declared identity are two `unowned` entries with
 * the same address, and no single tag write claims that address. Those
 * candidates never enter the adoptable set; the Adopt step is handed them
 * separately so the Op's own result names what it declined and why, beside
 * what it wrote.
 *
 * ## Compensation
 *
 * Refused without a command, the same stance `TerraformApplyOp` takes.
 * Un-adopting is `untag`: dropping this estate's marker from a live resource,
 * which is a decision about the estate rather than something chant can
 * synthesize. It is also not always the right undo — a resource that was
 * already carrying the markers before this run is not one this run adopted.
 *
 * @example
 * ```typescript
 * import { TerraformAdoptOp } from "@intentius/chant-lexicon-terraform";
 *
 * export const { op } = TerraformAdoptOp({ name: "estate-adopt", root: "estate" });
 * ```
 */

import { Op, phase, gate, activity, OpResource } from "@intentius/chant/op";
import {
  choudoufuLiveCheck as checkStep,
  choudoufuLivePlan as ledgerStep,
  choudoufuAdopt as adoptStep,
} from "../op/builders";

export interface TerraformAdoptOpConfig {
  /** Op name (kebab-case). Also the default task queue and gate signal suffix. */
  name: string;
  /** Key into the project's `terraform.roots`. Must be a live root: choudoufu, with a declared estate. */
  root: string;
  /**
   * The estate whose markers this run looks for. Omitted, `choudoufuLivePlan`
   * auto-detects it from the root's own `live` block or `estate.chdf.hcl`
   * sidecar, which is the usual case.
   */
  estate?: string;
  /** Gate signal name. Default: `approve-<name>`, as `TerraformApplyOp` does. */
  signalName?: string;
  /** How long a recorded pending gate stays valid, as a duration string. Default: core's own (48h). */
  gateTimeout?: string;
  /** Override the gate description shown to the approver. */
  gateDescription?: string;
  /**
   * Directory each step starts the `chant.config.*` search from, which is what
   * `terraform.roots` and the root's relative `dir` resolve against. Default:
   * the running process's cwd.
   */
  cwd?: string;
  /**
   * Saga-style rollback on a failed adoption, run as an `onFailure` phase.
   *
   * Refused without a command. Undoing an adoption is `untag` — removing this
   * estate's marker from a live resource — which is a decision about the
   * estate, and one this Op cannot even scope correctly: a resource that
   * already carried the markers is not one this run claimed. So `true`, or an
   * object with no `command`, throws when the Op is built, naming the Op,
   * rather than warning at the moment a rollback is already wanted.
   */
  compensate?: boolean | { command?: string };
}

export interface TerraformAdoptOpResources {
  /** Op resource. Generates the Check/Ledger/Gate/Adopt workflow. */
  op: InstanceType<typeof OpResource>;
}

export function TerraformAdoptOp(config: TerraformAdoptOpConfig): TerraformAdoptOpResources {
  const compensateCommand = typeof config.compensate === "object" ? config.compensate.command : undefined;
  if (config.compensate !== undefined && config.compensate !== false && compensateCommand === undefined) {
    throw new Error(
      `TerraformAdoptOp "${config.name}": compensate is enabled, but there is no automatic undo for an ` +
        `adoption — un-adopting is untag, removing this estate's ownership marker from a live resource, ` +
        `which is a decision about the estate rather than something chant can synthesize, and which this ` +
        `Op cannot scope for you (a resource that already carried the markers is not one this run ` +
        `claimed). Either supply compensate: { command: "..." } with an undo of your own, or set ` +
        `compensate: false.`,
    );
  }

  const where = config.cwd ? { cwd: config.cwd } : {};
  const estate = config.estate ? { estate: config.estate } : {};

  const check = checkStep(config.root, { ...where });
  check.outcomeAttribute = { name: "Refused", from: "refused" };

  // `id` is what makes `.out` legal. The Adopt step below reads two fields of
  // this one: the adoptable matches, and the contested candidates it must
  // report and never write.
  const ledger = ledgerStep(config.root, { ...where, ...estate, adoptionOnly: true, id: "ledger" });
  ledger.outcomeAttribute = [
    { name: "Adoptable", from: "adoptable" },
    { name: "Ambiguous", from: "ambiguous" },
  ];

  const adopt = adoptStep(config.root, {
    ...where,
    adoptions: ledger.out.adoptions,
    contested: ledger.out.contested,
  });
  adopt.outcomeAttribute = { name: "Adopted", from: "adoptedCount" };

  const op = Op({
    name: config.name,
    overview: `Adopt the live resources the "${config.root}" choudoufu estate already declares`,
    labels: {
      Adopt: "true",
      TerraformRoot: config.root,
      TerraformMode: "live",
    },
    phases: [
      phase("Check", [check]),
      phase("Ledger", [ledger]),
      phase("Gate", [
        gate(config.signalName ?? `approve-${config.name}`, {
          ...(config.gateTimeout ? { timeout: config.gateTimeout } : {}),
          description:
            config.gateDescription ??
            `Approve adopting live resources into the "${config.root}" estate. The Ledger phase's ` +
              `adoption ledger is what is being approved: every resource it lists as adoptable gets this ` +
              `estate's tofu-estate and tofu-address tags written onto it. The Adoptable and Ambiguous ` +
              `search attributes on that phase are its counts; an ambiguous address is never adopted.`,
        }),
      ]),
      phase("Adopt", [adopt]),
    ],
    ...(compensateCommand
      ? { onFailure: [phase("Rollback", [activity("shellCmd", { cmd: compensateCommand })])] }
      : {}),
  });

  return { op };
}
