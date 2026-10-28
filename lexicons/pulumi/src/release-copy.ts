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
 * ## In-place checkouts (plywood#22)
 *
 * A CI job's checkout has the same gap: git cloned the tracked files, and
 * nothing installed the program's dependencies before the step's first
 * preview. {@link prepareProgram}, which `pulumi-up`'s plan and run call,
 * prepares a release copy as above and an in-place directory by the same
 * install and the same lockfile rule, with two differences for a directory
 * that sits in a working tree:
 *
 * - `nodejs`: `node_modules` in the directory or any directory above it (a
 *   workspace's hoisted install), or a Yarn Plug'n'Play `.pnp.cjs` or
 *   `.pnp.js` there, counts as installed, since Node resolves the SDK
 *   from either.
 * - The refusal for a Node program with no lockfile names the checkout, and
 *   says to commit a lockfile or install before the run.
 *
 * Preparation runs once per directory per process, whichever engine asks
 * first, so two stacks of one project on different engines never install
 * into the same directory at once.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
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

/** An in-place program that cannot be made runnable, with the reason (plywood#22). */
export class PulumiProgramNotReadyError extends Error {
  constructor(
    public readonly member: string,
    public readonly dir: string,
    reason: string,
  ) {
    super(`pulumi-up: "${member}": the program in ${dir} cannot run: ${reason}`);
    this.name = "PulumiProgramNotReadyError";
  }
}

/** What preparing a copy did. */
export type ReleaseCopyPrepared =
  | { action: "not-a-copy" }
  | { action: "none"; reason: string }
  | { action: "installed"; command: string };

/** What preparing a program's directory did: a release copy or an in-place checkout. */
export type ProgramPrepared = { place: "copy" | "checkout" } & ({ action: "none"; reason: string } | { action: "installed"; command: string });

/** Whether `dir` or a directory above it holds what Node resolves a package from: `node_modules`, or Yarn Plug'n'Play's loader. */
function nodeResolvesAbove(dir: string): string | undefined {
  let at = resolve(dir);
  for (;;) {
    for (const f of ["node_modules", ".pnp.cjs", ".pnp.js"]) if (existsSync(join(at, f))) return join(at, f);
    const up = dirname(at);
    if (up === at) return undefined;
    at = up;
  }
}

/** Why the copy needs an install, or why not; throws when it cannot be prepared. */
export function releaseCopyNeeds(dir: string, member: string): { install: boolean; reason: string } {
  return programNeeds(dir, member, "copy");
}

/**
 * Why a program's directory needs an install, or why not: a release copy
 * (`copy`) or an in-place checkout (`checkout`). Throws when it cannot be
 * prepared: a Node program with no lockfile beside its package.json.
 */
export function programNeeds(dir: string, member: string, place: "copy" | "checkout"): { install: boolean; reason: string } {
  const { name, options } = pulumiRuntime(dir);
  switch (name) {
    case "nodejs": {
      if (place === "copy") {
        if (existsSync(join(dir, "node_modules"))) return { install: false, reason: "the copy has node_modules" };
      } else {
        const found = nodeResolvesAbove(dir);
        if (found) return { install: false, reason: `Node resolves the program's packages from ${found}` };
      }
      if (!NODE_LOCKFILES.some((f) => existsSync(join(dir, f)))) {
        if (place === "checkout") {
          throw new PulumiProgramNotReadyError(
            member,
            dir,
            `the program is Node, nothing installed its dependencies (no node_modules here or above), and there is no lockfile (${NODE_LOCKFILES.join(", ")}) beside its package.json, so an install would take whatever versions resolve today; commit a lockfile, or install the dependencies before the run`,
          );
        }
        throw new PulumiReleaseCopyRefusedError(
          member,
          `the program is Node, and the release recorded no lockfile (${NODE_LOCKFILES.join(", ")}) beside its package.json, so an install would take today's versions, not the release's; commit a lockfile and cut the release again`,
        );
      }
      return { install: true, reason: place === "copy" ? "a Node program's copy has no node_modules" : "a Node program's checkout has no node_modules" };
    }
    case "python": {
      const venv = typeof options.virtualenv === "string" ? options.virtualenv : undefined;
      const toolchain = typeof options.toolchain === "string" ? options.toolchain : undefined;
      if (toolchain === "poetry" || toolchain === "uv") return { install: true, reason: `a Python program on ${toolchain} installs its environment` };
      if (venv && !existsSync(join(dir, venv))) return { install: true, reason: `the virtualenv ${venv} is not in the ${place}` };
      return { install: false, reason: "the Python program names no virtualenv to build" };
    }
    default:
      return { install: false, reason: `the ${name ?? "unnamed"} runtime fetches what it needs on the run` };
  }
}

const prepared = new Map<string, Promise<ProgramPrepared>>();

/**
 * Make a program's directory runnable before its first engine run, once per
 * directory in this process: `install` there when {@link programNeeds} says
 * so. A release copy follows the copy's rules, any other directory the
 * checkout's. Throws for a directory that cannot be prepared, or an install
 * that fails. The first caller's engine runs the install; a second engine
 * asking for the same directory waits on it.
 */
export function prepareProgram(opts: { dir: string; member: string; engine: PulumiMemberEngine; run: PulumiRunner }): Promise<ProgramPrepared> {
  const dir = resolve(opts.dir);
  const place = isReleaseCopy(dir) ? "copy" : "checkout";
  let done = prepared.get(dir);
  if (!done) {
    done = (async (): Promise<ProgramPrepared> => {
      const needs = programNeeds(dir, opts.member, place);
      if (!needs.install) return { place, action: "none", reason: needs.reason };
      const command = `${opts.engine} install`;
      try {
        await runReleaseInstall(opts.run, ["install"], dir);
      } catch (err) {
        const f = pulumiRunFailure(err);
        const why = f.missingBinary ? `the ${opts.engine} binary was not found on PATH` : (f.stderr?.trim() || f.message).split("\n").slice(-3).join("\n");
        if (place === "copy") throw new PulumiReleaseCopyRefusedError(opts.member, `${command} in the copy failed: ${why}`);
        throw new PulumiProgramNotReadyError(opts.member, dir, `${command} failed: ${why}`);
      }
      return { place, action: "installed", command };
    })();
    prepared.set(dir, done);
    done.catch(() => prepared.delete(dir));
  }
  return done;
}

/**
 * Make a release copy runnable, once per directory in this process: `install`
 * in the copy when {@link releaseCopyNeeds} says so. Throws for a copy that
 * cannot be prepared, or an install that fails. A directory that is not a
 * copy is left alone; {@link prepareProgram} prepares both.
 */
export async function prepareReleaseCopy(opts: { dir: string; member: string; engine: PulumiMemberEngine; run: PulumiRunner }): Promise<ReleaseCopyPrepared> {
  if (!isReleaseCopy(opts.dir)) return { action: "not-a-copy" };
  const done = await prepareProgram(opts);
  return done.action === "none" ? { action: "none", reason: done.reason } : { action: "installed", command: done.command };
}

/** Forget every prepared directory. For tests. */
export function resetPreparedReleaseCopies(): void {
  prepared.clear();
}
