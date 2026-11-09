/**
 * The engine install lines a Terraform project's pull request pipeline runs
 * in chant's default image (#4550, `LexiconPlugin.ciSetup`): OpenTofu, and
 * choudoufu when a root runs it. Each line skips the install when the binary
 * is already on PATH, and the choudoufu line checks the archive's sha256.
 *
 * Whether a root runs choudoufu is read from the text of the project's
 * `chant.config.ts` (`binary: "choudoufu"`), never by running it, as lexicon
 * detection reads source.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PR_LOOP_SETUP } from "@intentius/chant/components/pr-pipeline";
import { ciToolInstallLine, type CiToolInstallOptions } from "@intentius/chant/ci-image";

/** The choudoufu release the default lines install. A product's images pin their own. */
export const CHOUDOUFU_CI_VERSION = "0.31.0";

/**
 * choudoufu from its release archive, checked against the release's
 * SHA256SUMS and the sha256 chant records for it (`CI_TOOL_SHA256` in
 * `@intentius/chant/ci-image`, #4784), then linked into /usr/local/bin. It
 * skips when a `choudoufu` is already on PATH. A version chant records no
 * sha256 for needs `sha256`, from the release's SHA256SUMS.
 */
export function choudoufuInstallLine(version = CHOUDOUFU_CI_VERSION, options: { sha256?: CiToolInstallOptions["sha256"] } = {}): string {
  return ciToolInstallLine("choudoufu", version, { onPath: true, requirePin: true, ...(options.sha256 ? { sha256: options.sha256 } : {}) });
}

/** Whether the project's config names choudoufu as a root's binary. */
export function usesChoudoufu(dir: string): boolean {
  for (const name of ["chant.config.ts", "chant.config.mts", "chant.config.js"]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    try {
      if (/binary\s*:\s*["']choudoufu["']/.test(readFileSync(file, "utf-8"))) return true;
    } catch {
      // unreadable: no choudoufu line
    }
  }
  return false;
}

/** The lines for the project at `dir`. */
export function terraformCiSetup(ctx: { dir: string }): string[] {
  return [...PR_LOOP_SETUP, ...(usesChoudoufu(ctx.dir) ? [choudoufuInstallLine()] : [])];
}
