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
    spriteCreate({ name: "deploy-agent", image: "sprites/base:latest" }),
    spriteExec({ id: "deploy-agent", cmd: "echo known-good > /work/state" }),
  ]),
  phase("Checkpoint", [spriteCheckpoint({ id: "deploy-agent", comment: "known-good" })]),
  phase("Build", [build(".", { script: "build:fly" })]),
  phase("Deploy", [flyApplyStep("dist/fly.json")]),
);

if (flapsBase) {
  phases.push(
    phase("Verify", [
      httpCheck(`${flapsBase}/v1/apps/fly-agent-demo/machines`, {
        contains: "started",
        retries: 15,
        intervalMs: 2000,
      }),
    ]),
  );
}

const teardown = [spriteDestroy({ id: "deploy-agent" })];
if (flapsBase) teardown.push(flapsDown());
if (spritesBase) teardown.push(spritesDown());
phases.push(phase("Teardown", teardown));

/**
 * Happy path: an agent, working inside a checkpointable Sprite, deploys the Fly
 * App + Machine from `src/infra.ts`. `chant run agent-deploy`.
 *
 * The phases model the full flow with no raw shell:
 *   Emulators   boot spritzer (the Sprites API fake) and mudflaps (the flaps
 *               fake) via `spritesUp` / `flapsUp`.
 *   Sandbox     create the agent's workspace Sprite and seed its known-good
 *               state (offline: a marker file; real: the agent checks out and
 *               authors the project).
 *   Checkpoint  checkpoint the Sprite as `known-good` — the rewind target the
 *               guarded variant restores to.
 *   Build       run `build:fly` -> the serialized flaps plan (`dist/fly.json`).
 *   Deploy      `flyApply` the App + Machine to flaps, waiting each machine to
 *               `started` over `/wait`.
 *   Verify      (offline) GET the app's machines and assert one reached
 *               `started`. Skipped against real Fly, where the Deploy step's own
 *               `/wait` is the verification.
 *   Teardown    destroy the Sprite, then remove both emulator containers.
 */
export default Op({
  name: "agent-deploy",
  overview: "Agent deploys a Fly App + Machine from inside a checkpointed Sprite",
  taskQueue: "fly-agent",
  phases,
});
