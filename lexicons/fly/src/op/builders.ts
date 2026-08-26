/**
 * Typed step-builder wrappers for this lexicon's sprite activities (chant
 * #1288 Stage 2 — "regenerate the step builders as fully typed wrappers").
 * Core's own sprite builders (`spriteCreate`, `spriteExec`, ...) already
 * carry an inline object-literal type in `packages/core/src/op/builders.ts`
 * — but that inline type is a hand-restated MIRROR of this lexicon's own
 * `Sprite*Args` interfaces (`./activities/sprites.ts`,
 * `./activities/sprite-fs.ts`, `./activities/sprite-tasks.ts`,
 * `./activities/sprite-config.ts`, `./activities/sprites-emulator.ts`),
 * exactly the duplication Stage 2 exists to eliminate. `opts`'s type in
 * every wrapper below IS the activity's own `*Args` interface (via
 * `WithStepRefs`) — never restated — so it stays in sync with the
 * implementation by construction.
 *
 * There's no cross-package layering problem here (unlike `kubectlApply`/
 * `helmInstall`): this package already owns both the activities and (per
 * `./composites/fly-deploy.ts`'s existing `flapsUp`/`flapsDown`/
 * `flyApplyStep` precedent, #744) the step-builder layer. So — matching how
 * `lexicons/temporal/src/op/builders.ts` handles ITS OWN activities — this
 * module REPLACES (not adds alongside) the sprite builders this package's
 * `src/index.ts` used to re-export from `@intentius/chant/op`: same names,
 * same import path (`@intentius/chant-lexicon-fly`), so an existing
 * `import { spriteCreate } from "@intentius/chant-lexicon-fly"` call site
 * gains authoring-time types and `StepOutputRef`/`.out` support with no
 * change. `core`'s own originals are untouched, for anyone still importing
 * `@intentius/chant/op` directly.
 */

import { activity, type NamedActivityStep, type WithStepRefs } from "@intentius/chant/op";
import type { ActivityStep } from "@intentius/chant/op";
import type { SpriteCreateArgs, SpriteExecArgs, SpriteCheckpointArgs, SpriteRestoreArgs, ListCheckpointsArgs, SpriteDestroyArgs } from "./activities/sprites";
import type { SpriteWriteFileArgs, SpriteReadFileArgs, SpriteListDirArgs, SpriteRemoveArgs } from "./activities/sprite-fs";
import type { SpriteApplyNetworkPolicyArgs, SpriteApplyServicesArgs } from "./activities/sprite-config";
import type { SpriteTaskCreateArgs, SpriteTaskRefreshArgs, SpriteTaskReleaseArgs } from "./activities/sprite-tasks";
import type { SpritesUpArgs, SpritesDownArgs } from "./activities/sprites-emulator";

type StepOpts = { profile?: ActivityStep["profile"] };

/**
 * Build one whole-args typed sprite step builder — `args` IS the activity's
 * own `*Args` type, `profile` routed off it, never restated. Only `profile`
 * is extracted, deliberately NOT a step-authoring `id` the way the other
 * lexicons' wrappers offer: `id` is itself a REQUIRED domain field on nearly
 * every `Sprite*Args` here (the target sprite's id — `spriteExec`,
 * `spriteWriteFile`, `spriteTaskCreate`, ...), so stripping an `id` key off
 * the flat args object the way `takeProfileAndId` does elsewhere would
 * silently steal the sprite id into the step's `id` and drop it from `args`
 * — the exact silent-wrong-value failure class chant #1288 exists to catch,
 * not reproduce. `.out`-by-id (#1290) is out of scope for the sprite family
 * through this convenience layer, exactly as it was through core's original
 * builders; an author who needs it authors `activity("spriteExec", args, {
 * id: "..." })` directly. `Args` is deliberately unconstrained: a named
 * interface without an explicit index signature (every `Sprite*Args` here)
 * is not assignable to `Record<string, unknown>` structurally, even though
 * every field it does declare is — the `as Record<string, unknown>` cast
 * below is a type ASSERTION (permissive), not an assignment, so it doesn't
 * need the constraint.
 */
function spriteStep<Args>(fn: string, defaultProfile: NonNullable<ActivityStep["profile"]>) {
  return (args: WithStepRefs<Args> & StepOpts): NamedActivityStep => {
    const { profile, ...rest } = args as { profile?: ActivityStep["profile"] } & Record<string, unknown>;
    return activity(fn, rest, profile ?? defaultProfile);
  };
}

/** Create a sprite — the fully typed twin of core's `spriteCreate`. Defaults to the `longInfra` profile. */
export const spriteCreate = spriteStep<SpriteCreateArgs>("spriteCreate", "longInfra");
/** Run a command in a sprite — the fully typed twin of core's `spriteExec`. Defaults to the `longInfra` profile. */
export const spriteExec = spriteStep<SpriteExecArgs>("spriteExec", "longInfra");
/** Checkpoint a sprite — the fully typed twin of core's `spriteCheckpoint`. Defaults to the `longInfra` profile. */
export const spriteCheckpoint = spriteStep<SpriteCheckpointArgs>("spriteCheckpoint", "longInfra");
/** Restore a sprite — the fully typed twin of core's `spriteRestore`. Defaults to the `longInfra` profile. */
export const spriteRestore = spriteStep<SpriteRestoreArgs>("spriteRestore", "longInfra");
/** List a sprite's checkpoints — the fully typed twin of core's `listCheckpoints`. Defaults to the `fastIdempotent` profile. */
export const listCheckpoints = spriteStep<ListCheckpointsArgs>("listCheckpoints", "fastIdempotent");
/** Destroy a sprite — the fully typed twin of core's `spriteDestroy`. Defaults to the `fastIdempotent` profile. */
export const spriteDestroy = spriteStep<SpriteDestroyArgs>("spriteDestroy", "fastIdempotent");
/** Write a file into a sprite — the fully typed twin of core's `spriteWriteFile`. Defaults to the `fastIdempotent` profile. */
export const spriteWriteFile = spriteStep<SpriteWriteFileArgs>("spriteWriteFile", "fastIdempotent");
/** Read a file from a sprite — the fully typed twin of core's `spriteReadFile`. Defaults to the `fastIdempotent` profile. */
export const spriteReadFile = spriteStep<SpriteReadFileArgs>("spriteReadFile", "fastIdempotent");
/** List a directory in a sprite — the fully typed twin of core's `spriteListDir`. Defaults to the `fastIdempotent` profile. */
export const spriteListDir = spriteStep<SpriteListDirArgs>("spriteListDir", "fastIdempotent");
/** Remove a path in a sprite — the fully typed twin of core's `spriteRemove`. Defaults to the `fastIdempotent` profile. */
export const spriteRemove = spriteStep<SpriteRemoveArgs>("spriteRemove", "fastIdempotent");
/** Reconcile a sprite's outbound network policy — the fully typed twin of core's `spriteApplyNetworkPolicy`. Defaults to the `fastIdempotent` profile. */
export const spriteApplyNetworkPolicy = spriteStep<SpriteApplyNetworkPolicyArgs>("spriteApplyNetworkPolicy", "fastIdempotent");
/** Reconcile a sprite's background services — the fully typed twin of core's `spriteApplyServices`. Defaults to the `fastIdempotent` profile. */
export const spriteApplyServices = spriteStep<SpriteApplyServicesArgs>("spriteApplyServices", "fastIdempotent");
/** Create a keep-alive task — the fully typed twin of core's `spriteTaskCreate`. Defaults to the `fastIdempotent` profile. */
export const spriteTaskCreate = spriteStep<SpriteTaskCreateArgs>("spriteTaskCreate", "fastIdempotent");
/** Refresh a keep-alive task's expiry — the fully typed twin of core's `spriteTaskRefresh`. Defaults to the `fastIdempotent` profile. */
export const spriteTaskRefresh = spriteStep<SpriteTaskRefreshArgs>("spriteTaskRefresh", "fastIdempotent");
/** Release a keep-alive task — the fully typed twin of core's `spriteTaskRelease`. Defaults to the `fastIdempotent` profile. */
export const spriteTaskRelease = spriteStep<SpriteTaskReleaseArgs>("spriteTaskRelease", "fastIdempotent");

/** Boot a local spritzer (Fly Sprites API emulator) — the fully typed twin of core's `spritesUp`. Defaults to the `longInfra` profile. */
export const spritesUp = (args: WithStepRefs<SpritesUpArgs> & StepOpts = {}): NamedActivityStep =>
  spriteStep<SpritesUpArgs>("spritesUp", "longInfra")(args);
/** Stop and remove the local spritzer container — the fully typed twin of core's `spritesDown`. Defaults to the `fastIdempotent` profile. */
export const spritesDown = (args: WithStepRefs<SpritesDownArgs> & StepOpts = {}): NamedActivityStep =>
  spriteStep<SpritesDownArgs>("spritesDown", "fastIdempotent")(args);
