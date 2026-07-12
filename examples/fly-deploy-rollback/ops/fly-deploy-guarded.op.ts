import { Op, phase, build } from "@intentius/chant-lexicon-temporal";
import {
  spriteCreate,
  spriteExec,
  spriteCheckpoint,
  spriteRestore,
  spriteDestroy,
  spritesUp,
  spritesDown,
  flapsUp,
  flapsDown,
  flyApplyStep,
} from "@intentius/chant-lexicon-fly";

// After the rollback, read the marker back so its value lands in the step
// record's `outcome` — the visible proof that the sandbox is at `known-good`
// again (the typed `spriteExec` builder does not expose `outcomeAttribute`, so
// spread the step and add it).
const proveRewound = {
  ...spriteExec({ id: "deploy-sandbox", cmd: "cat /work/state" }),
  outcomeAttribute: { name: "state", from: "stdout" },
};

// Each base URL is the offline/real switch for its service (see deploy.op.ts):
// an emulator is booted and torn down only when its URL points at localhost, so
// real mode ($SPRITES_BASE_URL / $FLY_FLAPS_BASE_URL unset) boots no container.
const flapsBase = process.env.FLY_FLAPS_BASE_URL;
const spritesBase = process.env.SPRITES_BASE_URL;

const emulators = [];
if (spritesBase) emulators.push(spritesUp());
if (flapsBase) emulators.push(flapsUp());

const setup = [];
if (emulators.length) setup.push(phase("Emulators", emulators));

// onFailure runs in reverse of the phases it compensates: restore, prove the
// rewind, destroy the Sprite, then stop whichever emulators were booted.
const rollback = [spriteRestore({ id: "deploy-sandbox", comment: "known-good" }), proveRewound, spriteDestroy({ id: "deploy-sandbox" })];
if (flapsBase) rollback.push(flapsDown());
if (spritesBase) rollback.push(spritesDown());

/**
 * The rollback climax. Same setup as `fly-deploy`, but after the good deploy a risky
 * follow-up step (`./risky.sh`, run in the Sprite) corrupts the sandbox's state
 * and exits non-zero. The failing `RiskyChange` phase triggers the Op-level
 * `onFailure` `Rollback`, which restores the `known-good` checkpoint — rewinding
 * the whole sandbox — then proves it and tears the emulators down.
 * `chant run fly-deploy-guarded` (exits non-zero: the risk fails on purpose).
 *
 * Checkpoint-as-compensation: a Sprite checkpoint is the transactional boundary,
 * so recovery is a restore instead of a hand-written inverse action. The
 * checkpoint `comment` and Sprite `id` are static strings the author writes, so
 * nothing has to be threaded out of a prior phase.
 *
 * `onFailure` phases run in reverse of the phases they compensate, so the single
 * `Rollback` phase holds the whole failure path in order: restore, prove the
 * rewind, then clean up the Sprite and whichever emulators were booted.
 */
export default Op({
  name: "fly-deploy-guarded",
  overview: "A risky post-deploy step fails; the Sprite rewinds to its known-good checkpoint",
  taskQueue: "fly-deploy",
  phases: [
    ...setup,
    phase("Sandbox", [
      spriteCreate({ name: "deploy-sandbox", image: "sprites/base:latest" }),
      spriteExec({ id: "deploy-sandbox", cmd: "echo known-good > /work/state" }),
    ]),
    phase("Checkpoint", [spriteCheckpoint({ id: "deploy-sandbox", comment: "known-good" })]),
    phase("Build", [build(".", { script: "build:fly" })]),
    phase("Deploy", [flyApplyStep("dist/fly.json")]),
    // The risky change is a deterministic failure, so retrying it is pointless —
    // `policyCheck` is the single-attempt profile, so it fails fast into Rollback
    // instead of burning the default retry budget.
    phase("RiskyChange", [
      spriteExec({ id: "deploy-sandbox", cmd: "./risky.sh", profile: "policyCheck" }),
    ]),
  ],
  onFailure: [phase("Rollback", rollback)],
});
