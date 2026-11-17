/**
 * #5263: a `chant release` command refuses a `chant.config` it can't load,
 * rather than reading it as one with no `release`. The member's own config
 * and its workspace root's are both read: `release.legacyTags` and
 * `release.breakingOnZero` come from the root too.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatError } from "../format";
import { NEXT_RELEASE } from "../../release-floors";

/** The first chant whose `chant release` commands refuse a config they can't load with `release-config-unreadable`, and that reads `chant.config.ts` with the project's tsx when its own install has none (#5263). */
export const RELEASE_CONFIG_UNREADABLE_FLOOR = NEXT_RELEASE;

/** Why the config in `dir` can't be loaded, or null when it loads or there is none. */
async function loadFailure(dir: string): Promise<{ path: string; message: string } | null> {
  const ts = join(dir, "chant.config.ts");
  const path = existsSync(ts) ? ts : join(dir, "chant.config.json");
  if (!existsSync(path)) return null;
  try {
    const { loadChantConfig } = await import("../../config");
    await loadChantConfig(dir);
    return null;
  } catch (err) {
    return { path, message: err instanceof Error ? err.message : String(err) };
  }
}

/** The fix for a config that can't be loaded: for a missing tsx, the ways to give chant one. */
export function unreadableConfigFix(message: string, version: string): string {
  if (message.startsWith("chant needs tsx")) {
    return (
      "chant reads chant.config.ts with tsx, from its own install or this project's node_modules. " +
      `Install it in the project (npm i -D tsx), run chant beside it (npx -p tsx -p @intentius/chant@${version} chant release ...), ` +
      "or write the config as chant.config.json."
    );
  }
  return "Fix the config so it loads: chant release reads its release block, and does not guess one.";
}

/**
 * Print the refusal and return 1 when the config in `cwd`, or in the
 * workspace root it sits in, can't be loaded; null when both load.
 */
export async function refuseUnreadableReleaseConfig(cwd: string): Promise<number | null> {
  const dirs = [resolve(cwd)];
  const { findWorkspaceRoot } = await import("../../project-root");
  const root = findWorkspaceRoot(cwd);
  if (root && resolve(root.dir) !== dirs[0]) dirs.push(resolve(root.dir));
  for (const dir of dirs) {
    const failed = await loadFailure(dir);
    if (!failed) continue;
    const { readerVersion } = await import("../../workspace/declaration");
    console.error(
      formatError({
        message: `${failed.path} could not be loaded: ${failed.message.split("\n")[0]} [release-config-unreadable]`,
        hint: unreadableConfigFix(failed.message, readerVersion()),
      }),
    );
    return 1;
  }
  return null;
}
