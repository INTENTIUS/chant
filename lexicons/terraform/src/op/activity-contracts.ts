/**
 * Activity contracts for this lexicon's own `op/activities` (chant #2101).
 *
 * The schema-shaped sibling of `./activities/index.ts`: that module is
 * resolved by convention at `@intentius/chant-lexicon-terraform/op/activities`
 * for the run-time registry, and this one at
 * `@intentius/chant-lexicon-terraform/op/activity-contracts` for build-time
 * validation. `loadActivityContracts`
 * (`packages/core/src/op/activity-contract-registry.ts`) merges what it finds
 * here into the map core's own OPS012 and OPS013 validate every `Chant::Op`
 * step against. Since #2122 moved those checks into core they fire on every
 * project that declares an Op, so an Op built out of terraform steps is
 * checked wherever it is built. Before this existed, both examples that carry
 * an Op had to keep it outside `src/` where `chant dev check-lexicon`'s
 * example build could not see it.
 *
 * Each contract's `args` schema mirrors the corresponding `*Args` interface in
 * `./activities/terraform.ts`, and each `returns` schema the corresponding
 * `*Result`. Authored with `z.strictObject(...)`, never `z.object(...)`: the
 * default form silently drops an unrecognized key instead of rejecting it, so
 * a misspelled `planfile` would vanish rather than fail the build. The
 * `returns` schemas are the half OPS013 needs — `plan.out.planFile` feeding an
 * Apply step, `plan.out.text` feeding a `reconcilePr` body — so a field a step
 * references has to be spelled here for the reference to validate.
 *
 * `json` is `z.unknown()` throughout: it is terraform's own `-json` document,
 * whose shape is the provider's, not chant's. A dot-path reference into it
 * therefore does not resolve, which is deliberate. Reference `text`, or one of
 * the counts projected out of the document, instead of reaching into
 * terraform's JSON from an Op.
 */

import { z } from "zod";
import { activityContract } from "@intentius/chant/op";

/** `root` and `cwd`, the two fields every activity in this lexicon takes ({@link TerraformRootArgs}). */
const rootArgs = { root: z.string(), cwd: z.string().optional() };

/**
 * `adds`/`changes`/`destroys`, the counts projected out of a plan's
 * `resource_changes` ({@link PlanChangeCounts}).
 */
const planChangeCounts = { adds: z.number(), changes: z.number(), destroys: z.number() };

/**
 * One adoption candidate as `../adoption.ts` models it. Loose on purpose: an
 * Op never reaches into a candidate's fields, it hands the whole array from a
 * live-plan step to `choudoufuAdopt`, and a whole-value reference is validated
 * without walking the shape.
 */
const adoptionCandidate = z.object({}).loose();

/**
 * The `root` arg names the terraform root module the step acts on — the
 * estate-side thing every activity here touches — so op.json's IR resolves it
 * into the step's `entities` (#2022) and a renderer can join the step to the
 * root instead of guessing off `cwd`, which is only where the config search
 * starts.
 */
const rootEntity = { entities: ["root"] };

export const terraformInitContract = activityContract(
  "terraformInit",
  z.strictObject({
    ...rootArgs,
    upgrade: z.boolean().optional(),
    reconfigure: z.boolean().optional(),
  }),
  z.object({ dir: z.string(), workspace: z.string().optional() }),
  rootEntity,
);

export const terraformPlanContract = activityContract(
  "terraformPlan",
  z.strictObject({
    ...rootArgs,
    planFile: z.string().optional(),
    destroy: z.boolean().optional(),
  }),
  z.object({
    ...planChangeCounts,
    changed: z.boolean(),
    planFile: z.string(),
    dir: z.string(),
    json: z.unknown(),
    text: z.string(),
    planDigest: z.string(),
  }),
  rootEntity,
);

export const terraformApplyContract = activityContract(
  "terraformApply",
  z.strictObject({ ...rootArgs, planFile: z.string().optional() }),
  z.object({
    planFile: z.string().optional(),
    dir: z.string(),
    applied: z.boolean(),
    refused: z.enum(["approval-mismatch", "wrong-estate"]).optional(),
    refusal: z.string().optional(),
  }),
  rootEntity,
);

export const terraformShowContract = activityContract(
  "terraformShow",
  z.strictObject({ ...rootArgs, planFile: z.string().optional() }),
  z.object({
    ...planChangeCounts,
    source: z.enum(["plan", "state"]),
    json: z.unknown(),
    text: z.string(),
    dir: z.string(),
    planFile: z.string().optional(),
  }),
  rootEntity,
);

export const choudoufuLivePlanContract = activityContract(
  "choudoufuLivePlan",
  z.strictObject({
    ...rootArgs,
    estate: z.string().optional(),
    adoptionOnly: z.boolean().optional(),
  }),
  z.object({
    ...planChangeCounts,
    unowned: z.number(),
    adoptable: z.number(),
    drift: z.boolean(),
    json: z.unknown(),
    text: z.string(),
    ledger: z.string(),
    finding: z.string(),
    adoptions: z.array(adoptionCandidate),
    contested: z.array(adoptionCandidate),
    ambiguous: z.number(),
    dir: z.string(),
    documentPath: z.string(),
    estate: z.string(),
  }),
  rootEntity,
);

export const choudoufuLiveLsContract = activityContract(
  "choudoufuLiveLs",
  z.strictObject({
    ...rootArgs,
    estate: z.string().optional(),
    consistent: z.boolean().optional(),
  }),
  z.object({ json: z.unknown(), dir: z.string(), estate: z.string() }),
  rootEntity,
);

export const choudoufuLiveCheckContract = activityContract(
  "choudoufuLiveCheck",
  z.strictObject({ ...rootArgs }),
  z.object({ refused: z.boolean(), json: z.unknown(), text: z.string(), dir: z.string() }),
  rootEntity,
);

export const choudoufuAdoptContract = activityContract(
  "choudoufuAdopt",
  z.strictObject({
    ...rootArgs,
    adoptions: z.array(adoptionCandidate),
    contested: z.array(adoptionCandidate).optional(),
  }),
  z.object({
    mechanism: z.literal("tag-write"),
    adopted: z.array(z.string()),
    adoptedCount: z.number(),
    refused: z.array(z.object({ addr: z.string(), identity: z.string(), reason: z.string() })),
    ambiguous: z.number(),
    dir: z.string(),
  }),
  rootEntity,
);
