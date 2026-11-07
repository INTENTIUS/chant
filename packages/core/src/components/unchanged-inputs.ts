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
 * A changed file that one of `normalize`'s entries covers (#4718) is compared
 * after that entry's command. A daemon release bumps Arugula's own crate
 * versions in every Cargo.toml and in Cargo.lock, which the hub lists among
 * its inputs; with
 *
 * ```ts
 * normalize: [{ paths: ["../Cargo.lock", "../crates/control/Cargo.toml"], command: "scripts/release blank {path}" }]
 * ```
 *
 * each such file is read at the two commits (`git show <commit>:<path>`),
 * each copy is piped through the command, and the file counts as unchanged
 * when the two outputs are the same bytes. The command runs with `sh -c` from
 * the repository's top level in the checkout, the commit being released, so
 * the same normalizer reads both copies; `{path}` is the file's path from the
 * top level, shell-quoted. It must print the same bytes for the same input.
 * A command that exits non-zero, times out or can't start counts the file as
 * changed and the reason says so. A file that is missing at either commit is
 * changed. A changed file no entry covers is changed as before, and then no
 * command runs. The first entry whose `paths` match a file is the one used.
 *
 * A skip is recorded ({@link unchangedRecord}): a release record of this
 * release for the component that repeats the digest of the deploy it keeps
 * and names that deploy in `unchangedSince`. When a file was the same only
 * after a normalization, the record lists it with the command in
 * `normalizedInputs`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import type { ComponentInputs } from "./component";
import type { Release } from "../lifecycle/release-store";
import type { ReleaseRecord, ReleaseRecordInput, RunOrigin } from "../lifecycle/release-ledger";
import { releaseTemplatesDigest } from "./release-promote";

/** The first chant that reads a component's `inputs` and writes `unchangedSince` on a release record (#4695). */
export const UNCHANGED_INPUTS_FLOOR = "0.124.65";

/** The first chant that reads `inputs.normalize` and writes `normalizedInputs` on a skip record (#4718). */
export const NORMALIZED_INPUTS_FLOOR = "0.124.68";

/** A file that differed between the two commits and was the same after a normalization (#4718). */
export interface NormalizedInput {
  /** From the repository's top level, as git prints it. */
  path: string;
  /** The `command` of the `normalize` entry that covered it, as declared. */
  command: string;
}

/** Whether a component's inputs are the same as in the release the environment runs it from. */
export type InputsVerdict =
  | {
      unchanged: true;
      /** The environment's record of the deploy that stays. */
      since: ReleaseRecord;
      /** The environment's record already names this release: there is nothing new to record. */
      recorded: boolean;
      /** The files that differed and were the same after a normalization (#4718), when there were any. */
      normalized?: NormalizedInput[];
    }
  | { unchanged: false; reason: string };

/** The files `paths` match that differ between two commits, or null when git can't tell. */
export type ChangedPaths = (from: string, to: string, paths: readonly string[]) => string[] | null;

/** {@link ChangedPaths} through `git diff`, with the pathspecs read from `memberDir`. */
export function gitChangedPaths(memberDir: string): ChangedPaths {
  return (from, to, paths) => {
    try {
      const out = execFileSync("git", ["diff", "--name-only", "--no-renames", "--no-relative", from, to, "--", ...paths], {
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

/**
 * Whether the file at `path` (from the top level) is the same at two commits
 * after `command` reads each copy on stdin (#4718), or why it can't tell.
 */
export type NormalizedCompare = (command: string, path: string, from: string, to: string) => { same: boolean } | { error: string };

/** How long one run of a normalizer may take. */
const NORMALIZE_TIMEOUT_MS = 60_000;

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * {@link NormalizedCompare} through git and `sh -c`, from the top level of
 * the repository `memberDir` is in. A file missing at either commit is not
 * the same.
 */
export function gitNormalizedCompare(memberDir: string): NormalizedCompare {
  let top: string | undefined;
  return (command, path, from, to) => {
    try {
      top ??= execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: memberDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {
      return { error: `${memberDir} is not in a git work tree` };
    }
    const outputs: Buffer[] = [];
    for (const commit of [from, to]) {
      const show = spawnSync("git", ["show", `${commit}:${path}`], { cwd: top, maxBuffer: 256 * 1024 * 1024 });
      if (show.status !== 0) return { same: false };
      const run = spawnSync("sh", ["-c", command.replaceAll("{path}", shellQuote(path))], {
        cwd: top,
        input: show.stdout,
        timeout: NORMALIZE_TIMEOUT_MS,
        maxBuffer: 256 * 1024 * 1024,
      });
      const at = `${path} at ${commit.slice(0, 12)}`;
      // A command that exits without reading all of its stdin makes the write
      // fail with EPIPE while the command itself ran: its exit status decides.
      const epipe = (run.error as NodeJS.ErrnoException | undefined)?.code === "EPIPE" && run.status !== null;
      if (run.error && !epipe) return { error: `\`${command}\` could not run on ${at}: ${run.error.message}` };
      if (run.status !== 0) {
        const said = run.stderr.toString("utf-8").trim().split("\n")[0];
        return { error: `\`${command}\` ${run.signal ? `was killed (${run.signal})` : `exited ${run.status}`} on ${at}${said ? `: ${said}` : ""}` };
      }
      outputs.push(run.stdout);
    }
    return { same: outputs[0]!.equals(outputs[1]!) };
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
  /** Compares a file `inputs.normalize` covers (#4718); without it such a file counts as changed. */
  normalizedCompare?: NormalizedCompare;
}): Promise<InputsVerdict> {
  const { component, inputs, env, release, current } = input;
  const normalized: NormalizedInput[] = [];
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
    const since = prior.commit.slice(0, 12);
    const covering = normalizeCoverage(inputs, changed, (p) => input.changedPaths(prior.commit, release.commit, p));
    if ("error" in covering) return { unchanged: false, reason: covering.error };
    const plain = changed.filter((f) => !covering.byFile.has(f));
    if (plain.length > 0) {
      return { unchanged: false, reason: `${plain.length} input file(s) changed since ${since}, such as ${plain[0]}` };
    }
    for (const [file, command] of covering.byFile) {
      const result = input.normalizedCompare
        ? input.normalizedCompare(command, file, prior.commit, release.commit)
        : { error: "no normalizer runs here" };
      if ("error" in result) {
        return { unchanged: false, reason: `the normalization of ${file} failed, so it counts as changed: ${result.error}` };
      }
      if (!result.same) {
        return { unchanged: false, reason: `input file ${file} changed since ${since}, also after \`${command}\`` };
      }
      normalized.push({ path: file, command });
    }
  }
  return { unchanged: true, since: current, recorded: false, ...(normalized.length > 0 ? { normalized } : {}) };
}

/**
 * The `normalize` entry, by its command, that covers each of the `changed`
 * files (#4718): the first entry whose `paths` git matches the file with.
 */
function normalizeCoverage(
  inputs: ComponentInputs,
  changed: readonly string[],
  matching: (paths: readonly string[]) => string[] | null,
): { byFile: Map<string, string> } | { error: string } {
  const byFile = new Map<string, string>();
  if (changed.length === 0) return { byFile };
  const pending = new Set(changed);
  for (const entry of inputs.normalize ?? []) {
    if (entry.paths.length === 0) continue;
    const matched = matching(entry.paths);
    if (matched === null) return { error: `git can't match the paths of the normalization \`${entry.command}\`, so its files count as changed` };
    for (const f of matched) if (pending.delete(f)) byFile.set(f, entry.command);
  }
  return { byFile };
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
  normalized?: readonly NormalizedInput[],
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
    ...(normalized && normalized.length > 0 ? { normalizedInputs: normalized.map((n) => ({ path: n.path, command: n.command })) } : {}),
  };
}
