/**
 * `terraformPinRollout`: one run of a pin-bump rollout (#3189), as an Op
 * activity. `chant terraform pin-rollout` calls the same function.
 *
 * Each run reads where the rollout stands on the forge and opens at most one
 * wave's pull request (`../../pin/rollout.ts`). Run it again, by hand or on
 * an Op `schedule`, to move on once a wave's PR has merged and its roots have
 * applied. A run that finds a failed root or a PR closed without merging
 * throws, naming it, so the run fails rather than reporting success.
 *
 * The HCL parser, the pin code and the TypeScript editor load on first call,
 * so importing the activities loads none of them.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { PinRoot, PinRolloutMode, PinRolloutResult } from "../../pin";

export interface TerraformPinRolloutArgs {
  /** The module, as its `source` names it without the pin: `oci://registry.example.com/modules/vpc`. */
  module: string;
  /** The pin the roots are at now. */
  from: string;
  /** The pin to move them to: an exact version, tag, ref or `sha256:` digest. */
  to: string;
  /** The roots, by directory relative to the repository. Default: every root that calls the module. */
  roots?: PinRoot[];
  /** Roots that form wave 1. */
  canaries?: string[];
  /** A `choudoufu live-waves -json` document to take the waves from, instead of canaries and dependency order. */
  wavesFrom?: string;
  /** The directory choudoufu ran in, relative to the repository, when its roots are relative to that. */
  wavesPrefix?: string;
  /** `report` (default) or `pull-request`. */
  mode?: PinRolloutMode;
  /** The branch PRs target. Default: the remote's default branch. */
  base?: string;
  /** Default `origin`. */
  remote?: string;
  /** The apply check each root reports on the merge commit, with `{root}` for its directory. Default `apply/{root}`. */
  appliedCheck?: string;
  /** A directory in the repository. Default: the working directory. */
  cwd?: string;
}

export type TerraformPinRolloutResult = PinRolloutResult;

/** Run one step of a pin-bump rollout. Throws when the rollout has stopped. */
export async function terraformPinRollout(args: TerraformPinRolloutArgs): Promise<TerraformPinRolloutResult> {
  const result = await readPinRollout(args);
  if (result.status === "stopped") throw new Error(`pin rollout stopped: ${result.stop}\n${result.summary}`);
  return result;
}

/** The same run, returning a stopped rollout instead of throwing. `chant terraform pin-rollout` calls this. */
export async function readPinRollout(args: TerraformPinRolloutArgs): Promise<TerraformPinRolloutResult> {
  const { loadHcl2json } = await import("@intentius/chant/terraform/parse");
  const { runPinRollout, wavesFromChoudoufu } = await import("../../pin");
  const { editPinsInTs } = await import("../../pin/edit-ts");
  const cwd = args.cwd ?? process.cwd();
  const waves = args.wavesFrom ? wavesFromChoudoufu(JSON.parse(readFileSync(isAbsolute(args.wavesFrom) ? args.wavesFrom : join(cwd, args.wavesFrom), "utf-8")), args.wavesPrefix) : undefined;
  return runPinRollout({
    module: args.module,
    from: args.from,
    to: args.to,
    cwd,
    parser: await loadHcl2json(),
    editTs: editPinsInTs,
    ...(args.roots ? { roots: args.roots } : {}),
    ...(args.canaries ? { canaries: args.canaries } : {}),
    ...(waves ? { waves } : {}),
    ...(args.mode ? { mode: args.mode } : {}),
    ...(args.base ? { base: args.base } : {}),
    ...(args.remote ? { remote: args.remote } : {}),
    ...(args.appliedCheck ? { appliedCheck: args.appliedCheck } : {}),
  });
}
