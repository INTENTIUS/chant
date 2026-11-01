/**
 * A component a release leaves alone (#4695): one whose declared inputs are
 * the same as in the release the environment runs it from.
 *
 * Some deploys cost something even when nothing changed. Arugula's hub drops
 * every relayed terminal when it restarts, and `fly-release` stamps each
 * release's commit on the Machine, so every release would restart it. A
 * component declares what it is made from (`inputs` on the component):
 *
 * ```ts
 * inputs: {
 *   paths: ["../crates/control", "../web", ":(exclude)../web/e2e", "../Cargo.lock", "src/control.component.ts", "src/control.fly.ts"],
 *   params: ["region"],
 * }
 * ```
 *
 * and a run under a release (`chant run --components --release`) compares
 * them with the release named by the environment's latest record of the
 * component. The component is unchanged when:
 *
 * - git sees no change between the two releases' commits to a file the
 *   `paths` match, read as pathspecs from the member's directory;
 * - each of the `params` has the same value in the two releases' targets for
 *   the environment;
 * - the deploy files the two targets record for the component
 *   (`releaseTemplatesDigest`) are the same, so a change to what the
 *   component deploys is never skipped for want of a listed path.
 *
 * Anything that can't be compared deploys: no record of the component in the
 * environment, a record made from no release, a release that isn't stored, a
 * commit git doesn't have. `--deploy-unchanged` deploys it anyway.
 *
 * A skip is recorded ({@link unchangedRecord}): a release record of this
 * release for the component that repeats the digest of the deploy it keeps
 * and names that deploy in `unchangedSince`.
 */

import { execFileSync } from "node:child_process";
import type { ComponentInputs } from "./component";
import type { Release } from "../lifecycle/release-store";
import type { ReleaseRecord, ReleaseRecordInput, RunOrigin } from "../lifecycle/release-ledger";
import { releaseTemplatesDigest } from "./release-promote";
import { NEXT_RELEASE } from "../release-floors";

/** The first chant that reads a component's `inputs` and writes `unchangedSince` on a release record (#4695). */
export const UNCHANGED_INPUTS_FLOOR = NEXT_RELEASE;

/** Whether a component's inputs are the same as in the release the environment runs it from. */
export type InputsVerdict =
  | {
      unchanged: true;
      /** The environment's record of the deploy that stays. */
      since: ReleaseRecord;
      /** The environment's record already names this release: there is nothing new to record. */
      recorded: boolean;
    }
  | { unchanged: false; reason: string };

/** The files `paths` match that differ between two commits, or null when git can't tell. */
export type ChangedPaths = (from: string, to: string, paths: readonly string[]) => string[] | null;

/** {@link ChangedPaths} through `git diff`, with the pathspecs read from `memberDir`. */
export function gitChangedPaths(memberDir: string): ChangedPaths {
  return (from, to, paths) => {
    try {
      const out = execFileSync("git", ["diff", "--name-only", "--no-renames", from, to, "--", ...paths], {
        cwd: memberDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return out.split("\n").filter((l) => l !== "");
    } catch {
      return null;
    }
  };
}

const shortDigest = (d: string): string => d.replace(/^jcs1-sha256:/, "").slice(0, 12);

/** Compare `component`'s declared inputs in `release` with the release the environment's `current` record names. */
export async function compareInputs(input: {
  component: string;
  inputs: ComponentInputs;
  env: string;
  release: Release;
  /** The environment's latest record of the component, if it has one. */
  current: ReleaseRecord | undefined;
  readRelease: (digest: string) => Promise<Release | null>;
  changedPaths: ChangedPaths;
}): Promise<InputsVerdict> {
  const { component, inputs, env, release, current } = input;
  const paths = inputs.paths ?? [];
  const params = inputs.params ?? [];
  if (paths.length === 0 && params.length === 0) return { unchanged: false, reason: "it declares no paths or params in inputs" };
  if (!current) return { unchanged: false, reason: `"${env}" has no deploy of it` };
  if (current.releaseDigest === undefined) return { unchanged: false, reason: `the deploy "${env}" runs (run ${current.runId}) was not made from a release` };
  if (current.releaseDigest === release.releaseDigest) return { unchanged: true, since: current, recorded: true };

  const prior = await input.readRelease(current.releaseDigest).catch(() => null);
  if (!prior) return { unchanged: false, reason: `release ${shortDigest(current.releaseDigest)}, which "${env}" runs it from, is not stored here` };
  const before = prior.targets.find((t) => t.env === env);
  const now = release.targets.find((t) => t.env === env);
  if (!before || !now) return { unchanged: false, reason: `release ${shortDigest((before ? release : prior).releaseDigest)} has no target for "${env}"` };

  for (const name of params) {
    const a = before.params.find((p) => p.name === name)?.value;
    const b = now.params.find((p) => p.name === name)?.value;
    if (a !== b) return { unchanged: false, reason: `param ${name} is ${JSON.stringify(b)}, was ${JSON.stringify(a)}` };
  }
  if (releaseTemplatesDigest(before, component) !== releaseTemplatesDigest(now, component)) {
    return { unchanged: false, reason: `the files its deploy reads in the "${env}" target changed` };
  }
  if (paths.length > 0 && prior.commit !== release.commit) {
    const changed = input.changedPaths(prior.commit, release.commit, paths);
    if (changed === null) {
      return { unchanged: false, reason: `git can't compare ${prior.commit.slice(0, 12)} and ${release.commit.slice(0, 12)} here; fetch the history between them` };
    }
    if (changed.length > 0) {
      return { unchanged: false, reason: `${changed.length} input file(s) changed since ${prior.commit.slice(0, 12)}, such as ${changed[0]}` };
    }
  }
  return { unchanged: true, since: current, recorded: false };
}

/**
 * The record of a skip (#4695): this release, for `since`'s component in its
 * environment, repeating what that deploy recorded of its artifact and naming
 * it in `unchangedSince`. Who approved that deploy is not repeated, since
 * nothing was approved now.
 */
export function unchangedRecord(
  since: ReleaseRecord,
  run: { releaseDigest: string; runId: string; runOrigin?: RunOrigin; timestamp: string; actor: string },
): ReleaseRecordInput {
  return {
    component: since.component,
    env: since.env,
    digest: since.digest,
    gitSha: since.gitSha,
    ...(since.manifestDigest !== undefined ? { manifestDigest: since.manifestDigest } : {}),
    ...(since.inputDigest !== undefined ? { inputDigest: since.inputDigest } : {}),
    ...(since.digestKind !== undefined ? { digestKind: since.digestKind } : {}),
    ...(since.releaseVersion !== undefined ? { releaseVersion: since.releaseVersion } : {}),
    runId: run.runId,
    ...(run.runOrigin ? { runOrigin: run.runOrigin } : {}),
    timestamp: run.timestamp,
    actor: run.actor,
    releaseDigest: run.releaseDigest,
    unchangedSince: { env: since.env, runId: since.runId, timestamp: since.timestamp },
  };
}
