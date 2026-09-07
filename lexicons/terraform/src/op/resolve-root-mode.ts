/**
 * Best-effort, synchronous read of whether a named `terraform.roots` entry is
 * live: `terraform.binary` is `"choudoufu"` and the root's directory declares
 * an estate, either a `live { }` block or an `estate.chdf.hcl` sidecar (#2103).
 *
 * Three callers decide something at build time, before any activity runs, and
 * none can afford the async work `../op/activities/terraform.ts`'s own
 * `resolveRoot` does (`loadChantConfigUpward`, a full `chant.config.ts`/`.json`
 * walk):
 *
 *   - `TerraformApplyOp` (`../composites/terraform-apply-op.ts`) reads the
 *     mode to word the Gate phase's approval description, and to refuse a
 *     root whose `policy` block sets `undeclared_untagged = "delete"`. The
 *     mode no longer picks a phase shape: #2157 made the live and stock Apply
 *     steps one step, so both roots build the same phases.
 *   - `TerraformWatchOp` (`../composites/terraform-watch-op.ts`) cross-checks
 *     its hand-set `live` flag against the root's real mode and refuses a
 *     mismatch (#2216).
 *   - TF101 (`../lint/rules/plan-before-apply.ts`) decides whether a
 *     `terraformApply` call it is statically inspecting is exempt from the
 *     plan-file pairing it otherwise enforces.
 *
 * All three run in the build process (`chant build`/`chant lint`) rather than
 * in an activity at run time, so a synchronous read is available, but only the
 * cheap half of it: `findProjectConfig` (`@intentius/chant/project-root`) is a
 * plain, already-synchronous upward filesystem walk, but a `chant.config.ts`
 * is project-authored code, and evaluating it synchronously outside chant's
 * own config-sandbox machinery is more than any caller's best-effort question
 * is worth. So this reads `chant.config.json` only; a project on a `.ts`
 * config, or with no config discoverable at all, or naming no matching root,
 * resolves to `undefined`, and "unknown" reads as "stock" to every caller.
 *
 * That default is conservative for the two callers that only ever add a
 * requirement by knowing more: TF101 keeps enforcing the plan-file pairing,
 * and the watch Op keeps accepting the flag it was given. It is the
 * permissive direction for the apply Op's policy refusal and for the watch
 * Op's mismatch, which is why neither refusal is left to this function alone:
 * TF027 and TF028 (`../lint/post-synth/`) ask the same questions of the
 * parsed HCL the build already stamped `mode` onto, whatever the config file
 * is written in, and those checks are the guarantee (#2216). Every project in
 * this repository is on a `chant.config.ts`, so a refusal that resolves the
 * mode through this function alone never fires for anyone.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findProjectConfig } from "@intentius/chant/project-root";
import type { TerraformConfig } from "../config";
import { detectLiveEstate } from "./activities/live-detect";

export interface ResolvedRootMode {
  /** `"live"` when `terraform.binary` is `"choudoufu"` and the root declares an estate; `"state"` otherwise. */
  mode: "live" | "state";
  /** The root module directory, resolved to an absolute path. */
  dir: string;
}

/**
 * Resolve `rootName`'s mode against the nearest `chant.config.json` found by
 * walking up from `cwd` (default `process.cwd()`, matching every other
 * `cwd`-defaulting option in this lexicon). `undefined` when that cannot be
 * done with a plain, synchronous read: no config found, the config found is
 * `chant.config.ts`, the config declares no such root, or the root's
 * directory does not exist.
 */
export function resolveRootModeSync(rootName: string, cwd?: string): ResolvedRootMode | undefined {
  const { dir: projectRoot, configPath } = findProjectConfig(resolve(cwd ?? process.cwd()));
  if (!configPath || !configPath.endsWith(".json")) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return undefined;
  }

  const terraform = (raw as { terraform?: TerraformConfig } | null)?.terraform;
  const root = terraform?.roots?.[rootName];
  if (!terraform || !root || typeof root.dir !== "string") return undefined;

  const dir = resolve(projectRoot, root.dir);
  if (terraform.binary !== "choudoufu") return { mode: "state", dir };
  if (!existsSync(dir)) return undefined;

  return { mode: detectLiveEstate(dir) !== undefined ? "live" : "state", dir };
}
