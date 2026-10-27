/**
 * The engine install lines a Terraform project's pull request pipeline runs
 * in chant's default image (#4550, `LexiconPlugin.ciSetup`): OpenTofu, and
 * choudoufu when a root runs it. Each line skips the install when the binary
 * is already on PATH.
 *
 * Whether a root runs choudoufu is read from the text of the project's
 * `chant.config.ts` (`binary: "choudoufu"`), never by running it, as lexicon
 * detection reads source.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PR_LOOP_SETUP } from "@intentius/chant/components/pr-pipeline";

/** The choudoufu release the default lines install. A product's images pin their own. */
export const CHOUDOUFU_CI_VERSION = "0.31.0";

/** choudoufu into /usr/local/bin from its release archive. */
export function choudoufuInstallLine(version = CHOUDOUFU_CI_VERSION): string {
  const arch = `$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')`;
  const url = `https://github.com/INTENTIUS/choudoufu/releases/download/v${version}/choudoufu_v${version}_linux_${arch}.tar.gz`;
  return `command -v choudoufu >/dev/null 2>&1 || (mkdir -p /tmp/choudoufu && curl -fsSL "${url}" | tar -xz -C /tmp/choudoufu && install "$(find /tmp/choudoufu -type f -name choudoufu | head -n 1)" /usr/local/bin/choudoufu)`;
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
