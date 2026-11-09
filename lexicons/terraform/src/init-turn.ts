/**
 * An init's turn (chant#4864). An op wave with `parallelism` over 1 plans
 * and applies several roots at once and gives each run the wave's serial
 * section (`DeployContext.serial`). Terraform's provider cache
 * (`TF_PLUGIN_CACHE_DIR`) is not safe for two inits writing it at once, so
 * `terraform-apply` and `terragrunt-apply` take their inits in the section,
 * keyed on the cache directory: one init at a time among the runs that share
 * it, their plans and applies side by side. Without a cache, `terraform-apply`
 * keys an init on the directory it runs in, since two runs reading the same
 * upstream would init it at once. Without a section (runs one at a time)
 * nothing changes.
 */

import { resolve } from "node:path";

/** A section as `DeployContext.serial` gives it. */
export type InitSection = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

/** The provider cache a run's inits write: its own environment's `TF_PLUGIN_CACHE_DIR`, else the job's. Undefined when neither names one. */
export function pluginCacheDir(env?: Record<string, string | undefined>): string | undefined {
  const dir = env && "TF_PLUGIN_CACHE_DIR" in env ? env.TF_PLUGIN_CACHE_DIR : process.env.TF_PLUGIN_CACHE_DIR;
  return dir ? resolve(dir) : undefined;
}

/** The key an init takes its turn under: the provider cache, else `dir` when given. Undefined when it needs no turn. */
export function initTurnKey(env: Record<string, string | undefined> | undefined, dir?: string): string | undefined {
  const cache = pluginCacheDir(env);
  if (cache) return `terraform-plugin-cache:${cache}`;
  return dir ? `terraform-init:${resolve(dir)}` : undefined;
}

/** Run `fn`, an init, in its turn: inside `serial` under {@link initTurnKey}, or as it is when there is no section or no key. */
export function inInitTurn<T>(serial: InitSection | undefined, env: Record<string, string | undefined> | undefined, dir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const key = serial ? initTurnKey(env, dir) : undefined;
  return key ? serial!(key, fn) : fn();
}
