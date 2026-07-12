import {
  Op,
  phase,
  build,
  httpCheck,
  spriteCreate,
  spriteExec,
  spriteCheckpoint,
  spriteDestroy,
} from "@intentius/chant-lexicon-temporal";
import { spritesUp, spritesDown } from "@intentius/chant/op";
import { flapsUp, flapsDown, flyApplyStep } from "@intentius/chant-lexicon-fly";

// Offline (default/CI) sets FLY_FLAPS_BASE_URL + SPRITES_BASE_URL to the local
// emulators; the fly + sprite activities resolve their endpoint as: an explicit
// `endpoint` arg, then the env var, then the real API. The Op passes no endpoint
// args, so it targets real Fly + real Sprites when those two env vars are unset
// (with FLY_API_TOKEN / SPRITES_API_TOKEN). The Verify step is a plain GET, so it
// runs only against the local flaps (mudflaps needs no auth) — hence gated on the
// env var, matching how the flaps applier resolves the same endpoint.
const flapsBase = process.env.FLY_FLAPS_BASE_URL;

const phases = [
  phase("Emulators", [spritesUp(), flapsUp()]),
  phase("Sandbox", [
    spriteCreate({ name: "deploy-agent", image: "sprites/base:latest" }),
    spriteExec({ id: "deploy-agent", cmd: "echo known-good > /work/state" }),
  ]),
  phase("Checkpoint", [spriteCheckpoint({ id: "deploy-agent", comment: "known-good" })]),
  phase("Build", [build(".", { script: "build:fly" })]),
  phase("Deploy", [flyApplyStep("dist/fly.json")]),
];

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

phases.push(phase("Teardown", [spriteDestroy({ id: "deploy-agent" }), flapsDown(), spritesDown()]));

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
