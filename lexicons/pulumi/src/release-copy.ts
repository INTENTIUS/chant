/**
 * A Pulumi program's recorded copy under a release (#4542 item 3).
 *
 * `pulumi-up`'s `releaseInputs` (`./pulumi-up.ts`) answers the stack's
 * directory, so `chant release cut` records it and a `promote --release` or
 * `rollback --release` writes the copy under
 * `.chant/release-templates/<digest>/` and points the step's `dir` at it.
 * The cut records the files git tracks, so the copy has no `node_modules`
 * and no virtualenv, and the program cannot run there as it stands.
 *
 * {@link prepareReleaseCopy} closes that gap before the copy's first
 * preview: it runs `pulumi install` (`plunge install` on plunge) in the
 * copy, the CLI's own install of the program's dependencies and plugins,
 * which follows the runtime's options in `Pulumi.yaml` (`packagemanager`,
 * `toolchain`, `virtualenv`). It runs only when the copy needs it:
 *
 * - `nodejs`: when there is no `node_modules`. A copy with no lockfile
 *   (`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`,
 *   `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`) is refused by name, since an
 *   install would take whatever versions resolve today instead of the
 *   release's.
 * - `python`: when `options.virtualenv` names a directory that is not there,
 *   or `options.toolchain` is `poetry` or `uv`.
 * - `go`, `dotnet`, `java`, `yaml`: never; their tools fetch what the
 *   program needs on the run.
 *
 * A directory that is not a release copy is never touched.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { parseYAML } from "@intentius/chant/yaml";
import type { PulumiMemberEngine } from "./member-engine";
import { pulumiRunFailure, runReleaseInstall, type PulumiRunner } from "./run";
import { isObject } from "./values";

/** Where core writes a release's recorded files, from the member's directory (`RELEASE_TEMPLATES_DIR` in core's release-promote). */
export const RELEASE_COPY_DIR = ".chant/release-templates";

/** The lockfiles that pin a Node program's dependencies. */
export const NODE_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"];

/** Whether `dir` sits in a release's recorded copy. */
export function isReleaseCopy(dir: string): boolean {
  const marker = `${sep}${RELEASE_COPY_DIR.split("/").join(sep)}${sep}`;
  return `${dir}${sep}`.includes(marker);
}

/** The runtime `Pulumi.yaml` names, and its options. */
export function pulumiRuntime(dir: string): { name?: string; options: Record<string, unknown> } {
  for (const file of ["Pulumi.yaml", "Pulumi.yml"]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    try {
      const runtime = parseYAML(readFileSync(path, "utf-8")).runtime;
      if (typeof runtime === "string") return { name: runtime, options: {} };
      if (isObject(runtime)) return { ...(typeof runtime.name === "string" ? { name: runtime.name } : {}), options: isObject(runtime.options) ? runtime.options : {} };
    } catch {
      // An unreadable Pulumi.yaml fails the preview with the engine's own error.
    }
    return { options: {} };
  }
  return { options: {} };
}

/** A copy the program cannot run in, with the reason. */
export class PulumiReleaseCopyRefusedError extends Error {
  constructor(
    public readonly member: string,
    reason: string,
  ) {
    super(`pulumi-up: "${member}": refusing to plan the release's copy: ${reason}`);
    this.name = "PulumiReleaseCopyRefusedError";
  }
}

/** What preparing a copy did. */
export type ReleaseCopyPrepared =
  | { action: "not-a-copy" }
  | { action: "none"; reason: string }
  | { action: "installed"; command: string };

/** Why the copy needs an install, or why not; throws when it cannot be prepared. */
export function releaseCopyNeeds(dir: string, member: string): { install: boolean; reason: string } {
  const { name, options } = pulumiRuntime(dir);
  switch (name) {
    case "nodejs": {
      if (existsSync(join(dir, "node_modules"))) return { install: false, reason: "the copy has node_modules" };
      if (!NODE_LOCKFILES.some((f) => existsSync(join(dir, f)))) {
        throw new PulumiReleaseCopyRefusedError(
          member,
          `the program is Node, and the release recorded no lockfile (${NODE_LOCKFILES.join(", ")}) beside its package.json, so an install would take today's versions, not the release's; commit a lockfile and cut the release again`,
        );
      }
      return { install: true, reason: "a Node program's copy has no node_modules" };
    }
    case "python": {
      const venv = typeof options.virtualenv === "string" ? options.virtualenv : undefined;
      const toolchain = typeof options.toolchain === "string" ? options.toolchain : undefined;
      if (toolchain === "poetry" || toolchain === "uv") return { install: true, reason: `a Python program on ${toolchain} installs its environment` };
      if (venv && !existsSync(join(dir, venv))) return { install: true, reason: `the virtualenv ${venv} is not in the copy` };
      return { install: false, reason: "the Python program names no virtualenv to build" };
    }
    default:
      return { install: false, reason: `the ${name ?? "unnamed"} runtime fetches what it needs on the run` };
  }
}

const prepared = new Map<string, Promise<ReleaseCopyPrepared>>();

/**
 * Make a release copy runnable, once per directory in this process: `install`
 * in the copy when {@link releaseCopyNeeds} says so. Throws for a copy that
 * cannot be prepared, or an install that fails.
 */
export function prepareReleaseCopy(opts: { dir: string; member: string; engine: PulumiMemberEngine; run: PulumiRunner }): Promise<ReleaseCopyPrepared> {
  if (!isReleaseCopy(opts.dir)) return Promise.resolve({ action: "not-a-copy" });
  const key = `${opts.engine}\0${opts.dir}`;
  let done = prepared.get(key);
  if (!done) {
    done = (async (): Promise<ReleaseCopyPrepared> => {
      const needs = releaseCopyNeeds(opts.dir, opts.member);
      if (!needs.install) return { action: "none", reason: needs.reason };
      const command = `${opts.engine} install`;
      try {
        await runReleaseInstall(opts.run, ["install"], opts.dir);
      } catch (err) {
        const f = pulumiRunFailure(err);
        const why = f.missingBinary ? `the ${opts.engine} binary was not found on PATH` : (f.stderr?.trim() || f.message).split("\n").slice(-3).join("\n");
        throw new PulumiReleaseCopyRefusedError(opts.member, `${command} in the copy failed: ${why}`);
      }
      return { action: "installed", command };
    })();
    prepared.set(key, done);
    done.catch(() => prepared.delete(key));
  }
  return done;
}

/** Forget every prepared copy. For tests. */
export function resetPreparedReleaseCopies(): void {
  prepared.clear();
}
