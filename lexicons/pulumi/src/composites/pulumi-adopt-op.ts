/**
 * PulumiAdoptOp composite (#4562): adopt stock Pulumi stacks onto plunge's
 * per-resource records, behind a gate, the pulumi twin of the terraform
 * lexicon's `TerraformAdoptOp`. It is the step after `plywood init --engine
 * plunge` (INTENTIUS/plywood#3); plywood supplies the words.
 *
 * plunge refuses a stock checkpoint with no records (`AdoptionRequiredError`)
 * rather than recreate everything, so a stack moves to plunge by `plunge
 * stack adopt`. Adoption writes one record per resource with the
 * checkpoint's IDs and calls no cloud API; the next `plunge up` adds the
 * `plunge-stack` and `plunge-urn` tags in place.
 *
 * Phases:
 *
 *   - **Check**: the shared bucket check (#4558) on each stack's backend
 *     bucket. A setting that fails, not waived, refuses the run before
 *     anything is exported, naming the fix. A `file://` backend is skipped.
 *   - **Export**: each stack's stock checkpoint, `pulumi stack export
 *     --stack <s>`, kept in a scratch file. It is the back-out copy (`pulumi
 *     stack import --file` on a stock backend), and on the route from Pulumi
 *     Cloud (`from: { backend }`) or from an export taken by hand (`from: {
 *     file }`) it is what plunge adopts with `--file`.
 *   - Then one wave per stack, in the order given: **Preview** runs `plunge
 *     stack adopt --json` (writes nothing), the **gate** binds that preview's
 *     `planDigest`, and **Adopt** runs `plunge stack adopt --json --yes`. A
 *     stack whose checkpoint changed after approval previews a new digest,
 *     and the old approval does not open the gate for it.
 *
 * Every gate is a fact on the workspace ledger: `chant run` records the
 * pending gate citing the preview's digest and exits gated, `chant approve
 * <op> <gate>` writes the resolution, and the next run walks to the Adopt
 * step. The run itself is a run record on the same ledger (#4551), as for
 * `TerraformAdoptOp`. There is no `gate: "never"`: adoption moves the stack's
 * state onto another backend's records, which nobody should skip reviewing.
 *
 * ## Compensation
 *
 * Refused without a command, as `TerraformAdoptOp` refuses it. Backing out
 * is `plunge stack export --file s.json` then `pulumi stack import --file
 * s.json` on a stock backend, a decision about the stack and its backend
 * rather than something chant should run on its own.
 *
 * @example
 * ```typescript
 * import { PulumiAdoptOp } from "@intentius/chant-lexicon-pulumi";
 *
 * export const { op } = PulumiAdoptOp({
 *   name: "adopt-infra",
 *   stacks: [{ member: "infra", dir: "./infra", stack: "dev" }],
 * });
 * ```
 */
import { Op, phase, gate, activity, OpResource } from "@intentius/chant/op";
import { pulumiAdopt, pulumiAdoptCheck, pulumiAdoptExport, pulumiAdoptPreview } from "../op/builders";

/** One stack to adopt. */
export interface PulumiAdoptStack {
  /** The member's name. */
  member: string;
  /** The stack's directory, where `Pulumi.yaml` is, relative to the project root. */
  dir: string;
  /** The stack to adopt. */
  stack: string;
  /** The plunge backend URL (`plunge+s3://...`). Default: `plywood.yml`'s, `PULUMI_BACKEND_URL`, `Pulumi.yaml`'s. */
  backend?: string;
  /**
   * Where the checkpoint comes from, when it is not the stock stack at the
   * same root: `backend`, another backend to export from (Pulumi Cloud), or
   * `file`, an export already taken. Either way plunge adopts it with
   * `--file`.
   */
  from?: { backend: string } | { file: string };
  /** The bucket to check, as `@intentius/chant/bucket-check` takes it, when the URL does not name it fully (azblob). */
  bucket?: Record<string, unknown>;
  /** Key prefixes a lifecycle rule must cover. Default: the backend URL's path. */
  namespaces?: string[];
  /** Bucket settings waived, as plunge's `allow_insecure`. An unwaivable one stays refused. */
  allowInsecure?: string[];
}

export interface PulumiAdoptOpConfig {
  /** Op name (kebab-case). */
  name: string;
  /** The stacks to adopt, one wave each, in this order. */
  stacks: PulumiAdoptStack[];
  /** Directory relative `dir`s resolve against. Default: the running process's cwd. */
  cwd?: string;
  /** The gate's name with one stack; with several, each gate is `<gateName>-<member>-<stack>`. Default: `approve-<name>`. */
  gateName?: string;
  /** How long a recorded pending gate stays valid, as a duration string. Default: core's own (48h). */
  gateTimeout?: string;
  /** Override the gate description shown to the approver. */
  gateDescription?: string;
  /** Rollback on a failed adoption, run as an `onFailure` phase. Refused without a command. */
  compensate?: boolean | { command?: string; image?: string };
}

export interface PulumiAdoptOpResources {
  /** Op resource: Check, Export, then Preview, gate and Adopt per stack. */
  op: InstanceType<typeof OpResource>;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export function PulumiAdoptOp(config: PulumiAdoptOpConfig): PulumiAdoptOpResources {
  const compensateCommand = typeof config.compensate === "object" ? config.compensate.command : undefined;
  const compensateImage = typeof config.compensate === "object" ? config.compensate.image : undefined;
  if (config.compensate !== undefined && config.compensate !== false && compensateCommand === undefined) {
    throw new Error(
      `PulumiAdoptOp "${config.name}": compensate is enabled, but there is no automatic undo for an adoption. ` +
        `Backing out is plunge stack export --file, then pulumi stack import --file on a stock backend, a decision ` +
        `about the stack and its backend. Supply compensate: { command: "..." } with an undo of your own, or set ` +
        `compensate: false.`,
    );
  }
  if (!Array.isArray(config.stacks) || config.stacks.length === 0) {
    throw new Error(`PulumiAdoptOp "${config.name}": stacks is empty; name at least one { member, dir, stack } to adopt`);
  }
  const seen = new Set<string>();
  for (const s of config.stacks) {
    const key = `${s.member}/${s.stack}`;
    if (seen.has(key)) throw new Error(`PulumiAdoptOp "${config.name}": ${key} is listed twice`);
    seen.add(key);
  }

  const where = config.cwd ? { cwd: config.cwd } : {};
  const single = config.stacks.length === 1;
  const gateBase = config.gateName ?? `approve-${config.name}`;

  const checks = config.stacks.map((s, i) =>
    pulumiAdoptCheck(s.member, {
      dir: s.dir,
      stack: s.stack,
      ...where,
      ...(s.backend ? { backend: s.backend } : {}),
      ...(s.bucket ? { bucket: s.bucket } : {}),
      ...(s.namespaces ? { namespaces: s.namespaces } : {}),
      ...(s.allowInsecure ? { allowInsecure: s.allowInsecure } : {}),
      id: `check-${i}`,
    }),
  );
  const exports = config.stacks.map((s, i) =>
    pulumiAdoptExport(s.member, {
      dir: s.dir,
      stack: s.stack,
      ...where,
      ...(s.backend ? { backend: s.backend } : {}),
      ...(s.from ? { from: s.from } : {}),
      id: `export-${i}`,
      profile: "longInfra",
    }),
  );

  const waves = config.stacks.flatMap((s, i) => {
    const file = s.from ? { file: exports[i]!.out.file } : {};
    // Every step gets the stack's backend, so Preview and Adopt read the store Check and Export read.
    const backend = s.backend ? { backend: s.backend } : {};
    const preview = pulumiAdoptPreview(s.member, { dir: s.dir, stack: s.stack, ...where, ...file, ...backend, id: `preview-${i}` });
    preview.outcomeAttribute = { name: single ? "Adoptable" : `Adoptable-${slug(s.member)}-${slug(s.stack)}`, from: "resources" };
    const adopt = pulumiAdopt(s.member, { dir: s.dir, stack: s.stack, ...where, ...file, ...backend, planDigest: preview.out.planDigest, id: `adopt-${i}` });
    adopt.outcomeAttribute = { name: single ? "Adopted" : `Adopted-${slug(s.member)}-${slug(s.stack)}`, from: "resources" };
    const label = single ? "" : ` ${s.member}/${s.stack}`;
    return [
      phase(`Preview${label}`, [preview]),
      phase(`Gate${label}`, [
        gate(single ? gateBase : `${gateBase}-${slug(s.member)}-${slug(s.stack)}`, {
          plan: preview.out.planDigest,
          ...(config.gateTimeout ? { timeout: config.gateTimeout } : {}),
          description:
            config.gateDescription ??
            `Approve adopting the Pulumi stack ${s.member}/${s.stack} onto plunge's per-resource records. The ` +
              `preview's adopt document is what is approved: each resource gets a record with the checkpoint's ID, ` +
              `no cloud object changes now, and the next plunge up writes the plunge-stack and plunge-urn tags.`,
        }),
      ]),
      phase(`Adopt${label}`, [adopt]),
    ];
  });

  const op = Op({
    name: config.name,
    overview: `Adopt ${single ? `the Pulumi stack ${config.stacks[0]!.member}/${config.stacks[0]!.stack}` : `${config.stacks.length} Pulumi stacks`} onto plunge's per-resource records`,
    labels: {
      Adopt: "true",
      Surface: "pulumi-adopt",
    },
    phases: [phase("Check", checks), phase("Export", exports), ...waves],
    ...(compensateCommand
      ? { onFailure: [phase("Rollback", [activity("shellCmd", { cmd: compensateCommand, ...(compensateImage ? { image: compensateImage } : {}) })])] }
      : {}),
  });
  return { op };
}
