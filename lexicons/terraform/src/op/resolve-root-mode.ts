/**
 * Best-effort, synchronous read of whether a named `terraform.roots` entry is
 * live: `terraform.binary` is `"choudoufu"` and the root's directory declares
 * an estate — a `live { }` block or an `estate.chdf.hcl` sidecar (#2103).
 *
 * Two callers decide something before any Temporal activity ever runs, and
 * neither can afford the async work `../op/activities/terraform.ts`'s own
 * `resolveRoot` does (`loadChantConfigUpward`, a full `chant.config.ts`/`.json`
 * walk):
 *
 *   - `TerraformApplyOp` (`../composites/terraform-apply-op.ts`) decides which
 *     phase shape to build — a stock plan-file pairing or a live re-plan-at-
 *     apply shape — before any step is emitted.
 *   - TF101 (`../lint/rules/plan-before-apply.ts`) decides whether a
 *     `terraformApply` call it is statically inspecting is exempt from the
 *     plan-file pairing it otherwise enforces.
 *
 * Both run outside a Temporal worker (a `chant build`/`chant lint` process),
 * so a synchronous read is available, but only the cheap half of it:
 * `findProjectConfig` (`@intentius/chant/project-root`) is a plain, already-
 * synchronous upward filesystem walk, but a `chant.config.ts` is project-
 * authored code, and evaluating it synchronously outside chant's own
 * config-sandbox machinery is more than either caller's best-effort question
 * is worth. So this reads `chant.config.json` only; a project on a `.ts`
 * config, or with no config discoverable at all, or naming no matching root,
 * resolves to `undefined` — "unknown" reads as "stock" to both callers, which
 * is the conservative direction: TF101 keeps firing, and the composite keeps
 * building the plan-file-carrying shape.
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
