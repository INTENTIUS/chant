/**
 * The engine install lines a Pulumi project's pull request pipeline runs in
 * chant's default image (#4550, `LexiconPlugin.ciSetup`): Pulumi, or plunge
 * when the member's engine is plunge (`pulumiMemberEngine`, #4559). Each line
 * skips the install when the binary is already on PATH, so an image that
 * carries it pays nothing.
 */
import { pulumiMemberEngine } from "./member-engine";

/** The plunge release the default lines install. plywood#12 pins its own images. */
export const PLUNGE_CI_VERSION = "0.1.0";

/** Pulumi into /usr/local/bin, from Pulumi's installer. */
export function pulumiInstallLine(version?: string): string {
  return `command -v pulumi >/dev/null 2>&1 || (curl -fsSL https://get.pulumi.com | sh -s -- --install-root /usr/local --no-edit-path${version ? ` --version ${version}` : ""})`;
}

/** plunge into /usr/local/plunge, its CLI linked into /usr/local/bin with its language hosts beside it. */
export function plungeInstallLine(version = PLUNGE_CI_VERSION): string {
  const arch = `$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')`;
  const url = `https://github.com/INTENTIUS/plunge/releases/download/plunge-v${version}/plunge-v${version}-linux-${arch}.tar.gz`;
  return `command -v plunge >/dev/null 2>&1 || (curl -fsSL "${url}" | tar -xz -C /usr/local && ln -sf /usr/local/plunge/plunge /usr/local/bin/plunge)`;
}

/** The lines for the project at `dir`. */
export function pulumiCiSetup(ctx: { dir: string }): string[] {
  return [pulumiMemberEngine(ctx.dir).engine === "plunge" ? plungeInstallLine() : pulumiInstallLine()];
}
