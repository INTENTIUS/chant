/**
 * The verify step of a publish (#5157): `release.verify` in `chant.config.ts`,
 * commands `chant release publish` runs after every target has staged and
 * before any reveals, so a candidate is tested as a consumer will get it.
 *
 * Each command runs through the shell in the member's directory, in the
 * order declared, with the run's environment and the staged references
 * ({@link verifyEnv}). The first that exits other than 0 stops the publish:
 * nothing has revealed, so nothing is visible, and the record gets a
 * `verify-failed` line. Run again, the publish stages nothing again and runs
 * the commands again before it reveals. Once a reveal is recorded the
 * commands do not run, since a failure could no longer hold anything back.
 *
 * A target whose stage is already visible (npm under `stage: false`) is
 * staged after the commands pass, in its turn to reveal, so it is never
 * visible before them; they can't see it, and the publish says so
 * ({@link unstagedForVerify}). A target that uploads at reveal (marketplace,
 * PyPI, Cargo: `uploadsAtReveal`) stages nothing and uploads after the
 * commands pass, so they can't see it either, and the same warning names it.
 *
 * Why `release.verify` and not `release.workflow.verify`: the commands are
 * part of `chant release publish` itself, so they run wherever the publish
 * runs (a workstation, a hand-written CI job, the generated workflow's
 * publish job, `chant workspace train publish`). `release.workflow` holds
 * only what the generated workflow file renders.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Release } from "./release-store";
import { NPM_STAGE_TAG, type PublishItem, type PublishTarget, type StagedTarget } from "./release-publish";

/** One entry of `release.verify`: a shell command, or one with a name for messages. */
export type ReleaseVerifyDeclaration = string | { name?: string; run: string };

/** An entry of `release.verify` with its name filled in. */
export interface VerifyStep {
  name: string;
  run: string;
}

/** The entries of `release.verify`, each named: its own `name`, else the command. */
export function verifySteps(decls: readonly ReleaseVerifyDeclaration[] | undefined): VerifyStep[] {
  return (decls ?? []).map((d) => (typeof d === "string" ? { name: d, run: d } : { name: d.name ?? d.run, run: d.run }));
}

/** The key a verify line carries in the publish record: `verify:` and 16 hex digits of the commands' SHA-256. */
export function verifyKey(steps: readonly VerifyStep[]): string {
  return `verify:${createHash("sha256").update(JSON.stringify(steps.map((s) => s.run))).digest("hex").slice(0, 16)}`;
}

/** One staged target, as the commands see it in `CHANT_STAGED`. */
export interface StagedReference {
  /** The workspace member, in a train publish. */
  member?: string;
  kind: string;
  name: string;
  destination: string;
  items: PublishItem[];
  state: Record<string, string>;
}

/** The staged reference of `target`. */
export function stagedReference(target: Pick<PublishTarget, "kind" | "name" | "destination">, staged: StagedTarget, member?: string): StagedReference {
  return { ...(member !== undefined ? { member } : {}), kind: target.kind, name: target.name, destination: target.destination, items: staged.items, state: staged.state };
}

/**
 * The targets of `targets` the verify commands can't see, `name` each: those
 * whose stage is already visible (npm `stage: false`) and those that stage
 * nothing and upload at reveal (marketplace, PyPI, Cargo).
 */
export function unstagedForVerify(targets: ReadonlyArray<Pick<PublishTarget, "name" | "stagesVisibly" | "uploadsAtReveal">>): string[] {
  return targets.filter((t) => t.stagesVisibly === true || t.uploadsAtReveal === true).map((t) => t.name);
}

/** The warning a publish prints when the verify commands can't see some targets. */
export function unstagedWarning(names: readonly string[]): string {
  return `${names.join(", ")} publish${names.length === 1 ? "es" : ""} without a stage (npm stage: false, or a marketplace, PyPI or Cargo upload), so release.verify can't check ${names.length === 1 ? "it" : "them"}: ${names.length === 1 ? "it publishes" : "they publish"} after the verify commands pass, straight to where consumers resolve ${names.length === 1 ? "it" : "them"}`;
}

/**
 * The variables the commands get beside the run's environment:
 *
 * - `CHANT_RELEASE_LABEL`, `CHANT_RELEASE_DIGEST`, `CHANT_RELEASE_COMMIT`,
 *   and `CHANT_RELEASE_TAG` when the release has a tag;
 * - `CHANT_STAGED`, the path of a JSON file with the release, every staged
 *   target (kind, name, destination, items with their digests, state such
 *   as a draft's `releaseId`) and the artifacts the release records;
 * - `CHANT_STAGED_NPM` (`name@version` of each staged package, spaces
 *   between) and `CHANT_STAGED_NPM_TAG` (`next`);
 * - `CHANT_STAGED_IMAGES` (`repository@sha256:...` of each staged image);
 * - `CHANT_STAGED_RELEASE_ID` and `CHANT_STAGED_RELEASE_URL`, the first
 *   staged forge draft's id and page.
 *
 * A variable with nothing to name is not set.
 */
export function verifyEnv(o: { release: Release; label: string | null; releaseTag: string | null; staged: readonly StagedReference[]; file: string }): Record<string, string> {
  const env: Record<string, string> = {
    CHANT_RELEASE_LABEL: o.label ?? "",
    CHANT_RELEASE_DIGEST: o.release.releaseDigest,
    CHANT_RELEASE_COMMIT: o.release.commit,
    CHANT_STAGED: o.file,
  };
  if (o.releaseTag) env.CHANT_RELEASE_TAG = o.releaseTag;
  const npm = o.staged.filter((s) => s.kind === "npm").flatMap((s) => s.items.map((i) => i.name));
  if (npm.length > 0) {
    env.CHANT_STAGED_NPM = npm.join(" ");
    env.CHANT_STAGED_NPM_TAG = NPM_STAGE_TAG;
  }
  const images = o.staged.filter((s) => s.kind === "oci").flatMap((s) => s.items.filter((i) => !i.attachment).map((i) => i.destination));
  if (images.length > 0) env.CHANT_STAGED_IMAGES = images.join(" ");
  const draft = o.staged.find((s) => s.kind === "forge" && s.state.releaseId);
  if (draft) {
    env.CHANT_STAGED_RELEASE_ID = draft.state.releaseId!;
    if (draft.state.releaseUrl) env.CHANT_STAGED_RELEASE_URL = draft.state.releaseUrl;
  }
  return env;
}

/** The document `CHANT_STAGED` names. */
export function stagedDocument(o: { release: Release; label: string | null; releaseTag: string | null; staged: readonly StagedReference[] }): Record<string, unknown> {
  return {
    release: { label: o.label, releaseDigest: o.release.releaseDigest, commit: o.release.commit, tag: o.releaseTag },
    targets: o.staged.map((s) => ({ ...s, state: Object.fromEntries(Object.entries(s.state).filter(([k]) => k !== "notes")) })),
    artifacts: o.release.artifactDigests.map((a) => ({ component: a.component, kind: a.kind, path: a.path, digest: a.digest, ...(a.ref ? { ref: a.ref } : {}) })),
  };
}

/** Run one command; the default runs it through the shell with its output on stderr. Returns its exit status. */
export type VerifyRunner = (command: string, o: { cwd: string; env: NodeJS.ProcessEnv }) => number | null;

const defaultRun: VerifyRunner = (command, o) => spawnSync(command, { cwd: o.cwd, env: o.env, shell: true, stdio: ["ignore", 2, 2] }).status;

/** How the commands went: every one passed, or the first that failed and its exit status. */
export type VerifyOutcome = { passed: true } | { passed: false; step: VerifyStep; exitCode: number | null };

/**
 * Run `steps` in `cwd`, in order, with `env` and the staged references.
 * Stops at the first that fails. The `CHANT_STAGED` file is written to a
 * temporary directory outside the checkout and removed afterwards.
 */
export function runVerifySteps(o: {
  cwd: string;
  steps: readonly VerifyStep[];
  env: NodeJS.ProcessEnv;
  release: Release;
  label: string | null;
  releaseTag: string | null;
  staged: readonly StagedReference[];
  say: (line: string) => void;
  run?: VerifyRunner;
}): VerifyOutcome {
  const run = o.run ?? defaultRun;
  const dir = mkdtempSync(join(tmpdir(), "chant-verify-"));
  try {
    const file = join(dir, "staged.json");
    writeFileSync(file, `${JSON.stringify(stagedDocument(o), null, 2)}\n`);
    const env = { ...o.env, ...verifyEnv({ ...o, file }) };
    for (const step of o.steps) {
      o.say(`  verifying: ${step.name}`);
      const code = run(step.run, { cwd: o.cwd, env });
      if (code !== 0) return { passed: false, step, exitCode: code };
    }
    return { passed: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
