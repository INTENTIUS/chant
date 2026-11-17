/**
 * The files a release train's members build at the cut, carried from the job
 * that cut them to the job that publishes them (#5216), and the signature
 * check of each member before the publish.
 *
 * `chant workspace train artifacts <env> [<train>] [--from <dir>] [-o <dir>]
 * [--no-build] [--json]`, in a checkout of the train's commit: for each member
 * the train cut from this commit that declares `release.images` or
 * `release.artifacts`, the image archives and files the release records are
 * checked against their recorded digests, as `chant release images` and
 * `chant release artifacts` check one member's:
 *
 * - `--from <dir>` first copies each member's files from `<dir>/<member
 *   directory>/`, where an earlier job staged them;
 * - a member whose files are all here is checked as they are; a member with
 *   one missing builds its images, or its files, again (`--no-build` refuses
 *   instead), and what it builds must have the recorded digests;
 * - `-o <dir>` stages every member's checked files at `<dir>/<member
 *   directory>/<path>`, with `chant-train-artifacts.json` naming the members,
 *   for the next job's `--from`.
 *
 * `chant workspace train verify <env> [<train>] [--json]` runs `chant release
 * verify` for each member the train cut from this commit, so a cut whose
 * signature does not verify stops the publish (the `verified-releases`
 * group).
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { readDeclaration } from "./declaration";
import { findTrain, readReleaseTrains, type ReadTrain } from "./release-train";
import { ownChant, TrainCutError } from "./train-cut";
import { locateWorkspace } from "./which-chant";
import { NEXT_RELEASE } from "../release-floors";

/** The first chant with `chant workspace train artifacts`, `train verify` and `train cut --doctor`, and a train publish that gives a member with images its digests in `CHANT_RELEASE_DIGESTS` (#5216): what the train workflow's cut and publish jobs run. */
export const TRAIN_ARTIFACTS_FLOOR = NEXT_RELEASE;

/** The file `-o` writes beside the staged files, naming the members staged. */
export const TRAIN_ARTIFACTS_INDEX = "chant-train-artifacts.json";

/** A member the train cut from this checkout's commit. */
export interface TrainMemberHere {
  member: string;
  /** The member's directory on disk. */
  dir: string;
  /** The member's directory from the workspace root, with `/`. */
  rel: string;
  /** The label, or the release digest for a release with none: what `chant release <command>` takes. */
  ref: string;
  releaseDigest: string;
}

/** The train, and its members cut from the commit checked out at the workspace root. */
export async function trainMembersHere(cwd: string, env: string, ref?: string): Promise<{ root: string; train: ReadTrain; members: TrainMemberHere[] }> {
  const located = locateWorkspace(cwd);
  const root = located.rootOnDisk;
  const train = findTrain((await readReleaseTrains(root, env)).records, ref);
  if (!train) throw new TrainCutError("train-unknown", ref ? `no release train ${ref} is recorded for ${env}` : `no release train is recorded for ${env}`, `List them with chant workspace train list ${env}.`);
  let head: string;
  try {
    head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).stdout.trim();
  } catch {
    head = "";
  }
  if (!head) throw new TrainCutError("not-a-git-repository", "a train's files are checked in a checkout of its commit, and this directory is not in a git repository");
  const dirs = new Map(readDeclaration(located.tree, "", { rootChant: true }).members.map((m) => [m.name, m.dir] as const));
  const members: TrainMemberHere[] = [];
  for (const m of train.members.filter((x) => x.commit === head)) {
    const rel = dirs.get(m.member);
    if (rel === undefined) throw new TrainCutError("train-member-unknown", `release train ${train.id} pins ${m.member}, which the declaration does not list`);
    members.push({ member: m.member, dir: resolve(root, rel), rel: rel.split(sep).join("/"), ref: m.label ?? m.releaseDigest, releaseDigest: m.releaseDigest });
  }
  if (members.length === 0) throw new TrainCutError("train-nothing-cut-here", `release train ${train.id} has no release cut from this checkout's commit ${head.slice(0, 12)}`, "Check out the commit the train's release-train tag names.");
  return { root, train, members };
}

/** Runs this chant with `args` in `cwd` and returns its exit code; its stdout goes to this process's stderr. */
export type MemberChant = (args: string[], cwd: string) => number;

/** The default {@link MemberChant}: this chant, its stdout on stderr so a `--json` caller's stdout stays one document. */
export const spawnMemberChant: MemberChant = (args, cwd) => {
  const [bin, ...pre] = ownChant();
  const r = spawnSync(bin!, [...pre, ...args], { cwd, stdio: ["ignore", 2, 2] });
  return r.status ?? 1;
};

export interface TrainArtifactsQuery {
  cwd: string;
  env: string;
  train?: string;
  /** Copy each member's files from `<from>/<member directory>/` first. */
  from?: string;
  /** Stage each member's checked files at `<output>/<member directory>/`. */
  output?: string;
  /** Refuse a member with a file missing rather than build it again. */
  noBuild?: boolean;
  chant?: MemberChant;
  say?: (line: string) => void;
}

/** One member's files, as checked. */
export interface TrainArtifactsMember {
  member: string;
  ref: string;
  /** The image archives the release records, from the member's directory. */
  images: string[];
  /** The `release.artifacts` files the release records, from the member's directory. */
  files: string[];
  /** Whether the images, and the files, were built again here rather than checked as they were. */
  built: { images: boolean; files: boolean };
  /** How many of the paths `--from` copied. */
  copied: number;
}

export interface TrainArtifactsOutcome {
  train: ReadTrain;
  members: TrainArtifactsMember[];
  staged: string | null;
}

/** Check, build again where missing, and stage the images and files of every member the train cut here (#5216). */
export async function trainArtifacts(q: TrainArtifactsQuery): Promise<TrainArtifactsOutcome> {
  const { train, members } = await trainMembersHere(q.cwd, q.env, q.train);
  const { loadChantConfig } = await import("../config");
  const { resolveRelease } = await import("../lifecycle/release-store");
  const { releaseArtifactFiles } = await import("../lifecycle/release-artifacts");
  const { placeReleaseImages, resolveReleaseImages } = await import("../lifecycle/release-images");
  const chant = q.chant ?? spawnMemberChant;
  const say = q.say ?? (() => undefined);
  const out: TrainArtifactsMember[] = [];
  const scratch = mkdtempSync(join(tmpdir(), "chant-train-artifacts-"));
  for (const m of members) {
    const release = (await loadChantConfig(m.dir)).config.release;
    const declaredImages = release?.images ?? [];
    const declaredFiles = release?.artifacts ?? [];
    if (declaredImages.length === 0 && declaredFiles.length === 0) continue;
    const found = await resolveRelease(m.releaseDigest, { cwd: m.dir });
    if (!found) throw new TrainCutError("release-not-found", `${m.member}: the train pins release ${m.releaseDigest}, which no cut in the member names`, `Fetch chant/lifecycle (git fetch origin chant/lifecycle:chant/lifecycle) in the train's checkout.`);
    const images = resolveReleaseImages(placeReleaseImages(declaredImages, declaredFiles)).map((i) => i.archive.replace(/^\.\//, ""));
    const files = releaseArtifactFiles(found.release, declaredFiles.map((d) => d.name)).map((f) => f.path);
    let copied = 0;
    if (q.from !== undefined) {
      for (const p of [...images, ...files]) {
        const src = resolve(q.from, m.rel, p);
        if (!existsSync(src)) continue;
        const dest = resolve(m.dir, p);
        mkdirSync(resolve(dest, ".."), { recursive: true });
        cpSync(src, dest, { recursive: true, force: true });
        copied++;
      }
    }
    const here = (paths: string[]) => paths.length > 0 && paths.every((p) => existsSync(resolve(m.dir, p)));
    const built = { images: false, files: false };
    const step = (what: "images" | "artifacts", paths: string[]) => {
      const present = here(paths);
      if (!present && q.noBuild) {
        const absent = paths.filter((p) => !existsSync(resolve(m.dir, p)));
        throw new TrainCutError("train-artifact-missing", `${m.member} ${m.ref}: ${absent.length > 0 ? absent.join(", ") : `its release.${what}`} ${absent.length === 1 ? "is" : "are"} not here`, "Hand this job the files the cut staged (--from <dir>), or run without --no-build to build them again.");
      }
      if (!present) built[what === "images" ? "images" : "files"] = true;
      const args = what === "images" ? ["release", "images", m.ref, ...(present ? ["--no-build"] : []), "-o", join(scratch, `${m.member}-digests.json`)] : ["release", "artifacts", m.ref, ...(present ? ["--no-build"] : [])];
      say(`${m.member} ${m.ref}: ${present ? "check" : "build again and check"} its ${what === "images" ? `image archive(s) ${paths.join(", ")}` : `file(s)${paths.length > 0 ? ` ${paths.join(", ")}` : ""}`}`);
      const code = chant(args, m.dir);
      if (code !== 0) throw new TrainCutError(`train-${what === "images" ? "image" : "artifact"}-check-failed`, `${m.member} ${m.ref}: chant ${args.slice(0, 3).join(" ")}${present ? " --no-build" : ""} failed (exit ${code})`, "Its output above says which file differs from the release. Publish the files the cut built, or cut a new train.");
    };
    if (declaredImages.length > 0) step("images", images);
    if (declaredFiles.length > 0) step("artifacts", files);
    if (q.output !== undefined) {
      for (const p of [...images, ...files]) {
        const dest = resolve(q.output, m.rel, p);
        mkdirSync(resolve(dest, ".."), { recursive: true });
        cpSync(resolve(m.dir, p), dest, { recursive: true, force: true });
      }
    }
    out.push({ member: m.member, ref: m.ref, images, files, built, copied });
  }
  let staged: string | null = null;
  if (q.output !== undefined) {
    staged = resolve(q.output);
    mkdirSync(staged, { recursive: true });
    // Always written, so the next job finds a staged directory even when no member of this train builds files.
    writeFileSync(join(staged, TRAIN_ARTIFACTS_INDEX), `${JSON.stringify({ train: train.id, members: out.map((m) => ({ member: m.member, ref: m.ref, images: m.images, files: m.files })) }, null, 2)}\n`);
  }
  return { train, members: out, staged };
}

/** Run `chant release verify` for each member the train cut here (#5216); every failure is reported before the exit. */
export async function trainVerify(q: { cwd: string; env: string; train?: string; chant?: MemberChant; say?: (line: string) => void }): Promise<{ train: ReadTrain; members: Array<{ member: string; ref: string; ok: boolean }> }> {
  const { train, members } = await trainMembersHere(q.cwd, q.env, q.train);
  const chant = q.chant ?? spawnMemberChant;
  const say = q.say ?? (() => undefined);
  const out = members.map((m) => {
    say(`${m.member} ${m.ref}: chant release verify ${m.ref}`);
    return { member: m.member, ref: m.ref, ok: chant(["release", "verify", m.ref], m.dir) === 0 };
  });
  const failed = out.filter((m) => !m.ok);
  if (failed.length > 0) {
    throw new TrainCutError("train-verify-failed", `release verify failed for ${failed.map((m) => `${m.member} ${m.ref}`).join(", ")}, so nothing of train ${train.id} is published`, "Its output above says why. A cut whose signature does not verify is cut again by a signer .chant/allowed_signers lists.");
  }
  return { train, members: out };
}

const ARTIFACTS_USAGE = "chant workspace train artifacts <env> [<train id|digest>] [--from <dir>] [-o <dir>] [--no-build] [--json]";
const VERIFY_USAGE = "chant workspace train verify <env> [<train id|digest>] [--json]";

async function report(err: unknown, json: boolean, usage: string): Promise<number> {
  const { formatError } = await import("../cli/format");
  const { WorkspaceReadError } = await import("./declaration");
  if (err instanceof TrainCutError) {
    if (json) console.log(JSON.stringify({ status: "refused", code: err.code, message: err.message }, null, 2));
    console.error(formatError({ message: `${err.message} [${err.code}]`, hint: err.fix ?? usage }));
    return 1;
  }
  if (err instanceof WorkspaceReadError) {
    console.error(formatError({ message: `${err.code}: ${err.describe()}`, hint: usage }));
    return 1;
  }
  throw err;
}

/** `chant workspace train artifacts <env> [<train>]` (#5216). */
export async function runTrainArtifacts(ctx: import("../cli/registry").CommandContext, words: string[]): Promise<number> {
  const { formatError, formatSuccess } = await import("../cli/format");
  const [env, ref] = words;
  if (!env || words.length > 2) {
    console.error(formatError({ message: env ? `chant workspace train artifacts takes an environment and a train, not ${words.join(" ")}` : "chant workspace train artifacts needs an environment", hint: ARTIFACTS_USAGE }));
    return 1;
  }
  const json = ctx.args.json === true;
  const cwd = resolve(".");
  const { fetchLifecycle } = await import("../lifecycle/git");
  await fetchLifecycle({ cwd }).catch(() => false);
  let outcome: TrainArtifactsOutcome;
  try {
    outcome = await trainArtifacts({
      cwd,
      env,
      ...(ref !== undefined ? { train: ref } : {}),
      ...(ctx.args.migrateFrom !== undefined ? { from: resolve(ctx.args.migrateFrom) } : {}),
      ...(ctx.args.output !== undefined ? { output: resolve(ctx.args.output) } : {}),
      ...(ctx.args.noBuild ? { noBuild: true } : {}),
      say: (line) => console.error(line),
    });
  } catch (err) {
    return report(err, json, ARTIFACTS_USAGE);
  }
  if (json) {
    console.log(JSON.stringify({ train: outcome.train.id, env, members: outcome.members, staged: outcome.staged }, null, 2));
    return 0;
  }
  const n = outcome.members.length;
  const where = outcome.staged ? `, staged in ${relative(cwd, outcome.staged) || outcome.staged}` : "";
  console.error(formatSuccess(n === 0 ? `No member release train ${outcome.train.id} cut here declares release.images or release.artifacts${where}` : `Checked the images and files of ${n} member(s) of release train ${outcome.train.id} against their releases${where}`));
  return 0;
}

/** `chant workspace train verify <env> [<train>]` (#5216). */
export async function runTrainVerify(ctx: import("../cli/registry").CommandContext, words: string[]): Promise<number> {
  const { formatError, formatSuccess } = await import("../cli/format");
  const [env, ref] = words;
  if (!env || words.length > 2) {
    console.error(formatError({ message: env ? `chant workspace train verify takes an environment and a train, not ${words.join(" ")}` : "chant workspace train verify needs an environment", hint: VERIFY_USAGE }));
    return 1;
  }
  const json = ctx.args.json === true;
  const cwd = resolve(".");
  const { fetchLifecycle } = await import("../lifecycle/git");
  await fetchLifecycle({ cwd }).catch(() => false);
  let outcome: Awaited<ReturnType<typeof trainVerify>>;
  try {
    outcome = await trainVerify({ cwd, env, ...(ref !== undefined ? { train: ref } : {}), say: (line) => console.error(line) });
  } catch (err) {
    return report(err, json, VERIFY_USAGE);
  }
  if (json) {
    console.log(JSON.stringify({ train: outcome.train.id, env, members: outcome.members }, null, 2));
    return 0;
  }
  console.error(formatSuccess(`Verified ${outcome.members.length} member(s) of release train ${outcome.train.id}`));
  return 0;
}
