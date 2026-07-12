import { Op, phase, build, httpCheck } from "@intentius/chant-lexicon-temporal";
import {
  spriteCreate,
  spriteExec,
  spriteCheckpoint,
  spriteDestroy,
  spritesUp,
  spritesDown,
  flapsUp,
  flapsDown,
  flyApplyStep,
} from "@intentius/chant-lexicon-fly";

// Offline (default/CI) sets FLY_FLAPS_BASE_URL + SPRITES_BASE_URL to the local
// emulators; the fly + sprite activities resolve their endpoint as: an explicit
// `endpoint` arg, then the env var, then the real API. The Op passes no endpoint
// args, so it targets real Fly + real Sprites when those two env vars are unset
// (with FLY_API_TOKEN / SPRITES_API_TOKEN). Each env var is therefore the
// offline/real switch for its service: an emulator is booted (and torn down)
// only when its base URL points at localhost, and the plain-GET `Verify` runs
// only against the local flaps (mudflaps needs no auth). In real mode no
// container is booted — no Docker required.
const flapsBase = process.env.FLY_FLAPS_BASE_URL;
const spritesBase = process.env.SPRITES_BASE_URL;

const emulators = [];
if (spritesBase) emulators.push(spritesUp());
if (flapsBase) emulators.push(flapsUp());

const phases = [];
if (emulators.length) phases.push(phase("Emulators", emulators));
phases.push(
  phase("Sandbox", [
    spriteCreate({ name: "deploy-sandbox", image: "sprites/base:latest" }),
    spriteExec({ id: "deploy-sandbox", cmd: "echo known-good > /work/state" }),
  ]),
  phase("Checkpoint", [spriteCheckpoint({ id: "deploy-sandbox", comment: "known-good" })]),
  phase("Build", [build(".", { script: "build:fly" })]),
  phase("Deploy", [flyApplyStep("dist/fly.json")]),
);

if (flapsBase) {
  phases.push(
    phase("Verify", [
      httpCheck(`${flapsBase}/v1/apps/fly-deploy-demo/machines`, {
        contains: "started",
        retries: 15,
        intervalMs: 2000,
      }),
    ]),
  );
}

const teardown = [spriteDestroy({ id: "deploy-sandbox" })];
if (flapsBase) teardown.push(flapsDown());
if (spritesBase) teardown.push(spritesDown());
phases.push(phase("Teardown", teardown));

/**
 * Happy path: deploy the Fly App + Machine from `src/infra.ts`, with a
 * checkpointable Sprite sandbox standing by as the rollback boundary the guarded
 * variant uses. `chant run deploy`.
 *
 * The deploy itself (Build + Deploy) is orchestrated by the Op, not run from
 * inside the Sprite — the Sprite is a stateful sandbox whose checkpoint is a
 * clean rewind point. The phases model the flow with no raw shell:
 *   Emulators   boot spritzer (the Sprites API fake) and mudflaps (the flaps
 *               fake) via `spritesUp` / `flapsUp`.
 *   Sandbox     create the Sprite sandbox and seed its known-good state (a
 *               marker file standing in for accumulated workspace state).
 *   Checkpoint  checkpoint the Sprite as `known-good` — the rewind target the
 *               guarded variant restores to.
 *   Build       run `build:fly` -> the serialized flaps plan (`dist/fly.json`).
 *   Deploy      `flyApply` the App + Machine to flaps, waiting each machine to
 *               `started` over `/wait`.
 *   Verify      (offline) GET the app's machines and assert one reached
 *               `started`. Skipped against real Fly, where the Deploy step's own
 *               `/wait` is the verification.
 *   Teardown    destroy the Sprite, then remove whichever emulators were booted.
 */
export default Op({
  name: "deploy",
  overview: "Deploy a Fly App + Machine, with a Sprite checkpoint as the rollback boundary",
  taskQueue: "fly-deploy",
  phases,
});
