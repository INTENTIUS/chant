/**
 * `chant release` (#4026, ws-104): the release is what graduates.
 *
 *   release cut [<label>] [--at <sha>] [--yes] [--build <command>] [--param k=v]... [--params-file <file>] [--src <dir>] [-o <file>] [--lexicon <name>] [--actor <name>] [--sign [<key file>]] [--lane <name>] [--json]
 *       a dry run of a cut of this member from the checkout's HEAD, which must be
 *       clean, on trunk and pushed, and green (#4027), or green in a lane with
 *       `--lane` or `release.lane` (#4692); `--yes` cuts, records,
 *       and tags the commit `release/<label>` locally;
 *       --sign signs the cut with the actor's ssh key (#4031); `--override-green`
 *       cuts a commit that is not green under a person's override (#4693); `--src`, `-o` and
 *       `--lexicon` shape the build of a project with no components (#4046)
 *   release publish <label|digest> [--yes] [--allow-unsigned] [--require-provenance] [--json]
 *       publish a cut release (#4027) to the targets release.publish declares
 *       (#4047): a dry run unless --yes; refuses a revoked one, one with no
 *       signature that verifies against .chant/allowed_signers unless
 *       --allow-unsigned (#4049), and with a target a checkout that is not
 *       the release's commit; warns with no OIDC provenance, and refuses
 *       under --require-provenance; attaches SBOMs and provenance (#4049)
 *   release verify <label|digest> [--sigstore [--assets <dir>]] [--json]
 *       check the release's signature offline against .chant/allowed_signers
 *       at the release's commit (#4049)
 *   release changed [--at <sha>] [--bump-member <member>=<level>]... [--json]
 *       the members to release at a commit, with their dependency closure (#5134)
 *   release candidates [--env <env>] [--lane <name>] [--forge-issues] [--json]
 *       the green commits of trunk a release can be cut from, each with what it
 *       would ship, and what each environment runs (#4168 4.2)
 *   release compose <name> [--base <label|sha>] (--pr <n> | --work <id>)... [--yes] [--json]
 *       pick chosen trunk changes onto a base, each with a Chant-Composed-From
 *       trailer, on the pushed branch chant/compose/<name> (#4168 4.3); a dry
 *       run unless --yes. `release cut` takes a green commit of that branch,
 *       and `--channel <tag>` makes its publish move that tag, not latest
 *   release list [--json]
 *       every release of this member with its targets, its cuts and where it runs;
 *       `--json` prints the read contract's `releases` document
 *   release export <label|digest> --env <env> [-o <dir>] [--json]
 *       write the files the release recorded for <env>, checked against their digests (#4046)
 *   release compile --env <env> [--build <command>] [--artifacts --component <a,b>] --json
 *       internal: what the cut runs in a child process per environment
 *
 * The workstation checks, the actor and the tag are in
 * ../../lifecycle/release-workstation.ts, and the publish contract in
 * ../../lifecycle/release-publish.ts. A declaration whose `identity.gates`
 * names a `release` gate requires a signed cut by an actor in its class (#4031).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { formatBold, formatError, formatSuccess, formatWarning } from "../format";
import { parseParamFlags } from "../build-params-cli";
import { prereleaseNote, prereleaseOf } from "../../lifecycle/release-prerelease";
import type { CommandContext } from "../registry";

const USAGE =
  "chant release cut [<label>|auto [--pre <id>]] [--at <sha>] [--yes] [--build <command>] [--param <k=v>] [--image <component>=<repository>@sha256:<hex>] [--params-file <file>] [--src <dir>] [-o <file>] [--lexicon <name>] [--actor <name>] [--sign [<key file>]] [--channel <tag>] [--lane <name>] [--override-green] [--json] | release publish <label|digest> [--yes] [--allow-unsigned] [--require-provenance] [--json] | release verify <label|digest> [--sigstore [--assets <dir>]] [--json] | release doctor [--json] | release images <label|digest> [--no-build] [-o <file>] [--json] | release artifacts <label|digest> [--no-build] [--from <dir>] [-o <dir>] [--json] | release next [--at <sha>] [--pre <id>] [--json] | release changed [--at <sha>] [--bump-member <member>=<level>]... [--json] | release candidates [--env <env>] [--lane <name>] [--forge-issues] [--json] | release compose <name> [--base <label|sha>] (--pr <n> | --work <id>)... [--yes] [--json] | release list [--json] | release tag <label|digest|tag> [--json] | release export <label|digest> --env <env> [-o <dir>] [--json]";

/** The label `release cut` takes for the one `release next` computes (#5159). */
const AUTO_LABEL = "auto";

/** The build inputs `release cut` and `release compile` share. */
function compileInputs(
  ctx: CommandContext,
  params: Record<string, string> | undefined,
  projectDir: string = resolve("."),
  releaseLabel?: string | null,
): import("../../components/release-compile").CompileInputs {
  const { args } = ctx;
  return {
    projectDir,
    ...(releaseLabel ? { releaseLabel } : {}),
    ...(args.buildCommand ? { buildCommand: args.buildCommand } : {}),
    ...(params ? { params } : {}),
    ...(args.paramsFile ? { paramsFile: args.paramsFile } : {}),
    ...(args.src ? { src: args.src } : {}),
    ...(args.output ? { output: args.output } : {}),
    ...(args.lexicon ? { lexicon: args.lexicon } : {}),
  };
}

/** What to run after a cut (#4027): publish from CI, or push the tag so CI publishes, or deploy the first environment. */
export function nextCommands(req: {
  ref: string;
  tag: string | null;
  inCi: boolean;
  firstEnv: string | null;
  /** A project with no components deploys with `release export`, not promote (#4046). */
  noComponents: boolean;
}): string[] {
  const publish = `chant release publish ${req.ref}`;
  const deploy = req.firstEnv === null
    ? null
    : req.noComponents
      ? `chant release export ${req.ref} --env ${req.firstEnv}`
      : `chant components promote --release ${req.ref} --to ${req.firstEnv}`;
  if (req.inCi) return [publish, ...(deploy ? [deploy] : [])];
  return [...(req.tag ? [`git push origin ${req.tag}`] : []), publish, ...(deploy ? [deploy] : [])];
}

/** The command line that ran, without `--json`, with `--yes` added: what a dry run says to run next. */
export function sameWithYes(argv: readonly string[]): string {
  const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  return ["chant", ...argv.filter((a) => a !== "--json" && a !== "--yes"), "--yes"].map(quote).join(" ");
}

/**
 * The green lane a cut or a candidates read checks (#4692): `--lane`, else
 * `release.lane` in the member's chant.config.ts at `cwd`, else none. A
 * config that can't be loaded is warned about and read as naming none, so the
 * full green tag is checked.
 */
async function laneOf(ctx: CommandContext, cwd: string): Promise<string | undefined> {
  if (ctx.args.lane !== undefined) return ctx.args.lane;
  try {
    const { loadChantConfig } = await import("../../config");
    return (await loadChantConfig(cwd)).config.release?.lane;
  } catch (err) {
    if (!ctx.args.json) console.error(formatWarning({ message: `release.lane was not read, so the full green tag is checked: ${err instanceof Error ? err.message : String(err)}` }));
    return undefined;
  }
}

/** The member's `release.images` (#4657), or none when the config declares none. A Dockerfile entry (#4819) keeps its form, so its prepare command runs. */
async function releaseArtifactsOf(cwd: string): Promise<import("../../lifecycle/release-artifacts").ReleaseArtifactDeclaration[]> {
  const { loadChantConfig } = await import("../../config");
  return (await loadChantConfig(cwd)).config.release?.artifacts ?? [];
}

async function releaseImagesOf(cwd: string): Promise<import("../../lifecycle/release-images").ReleaseImageDeclaration[]> {
  const { loadChantConfig } = await import("../../config");
  return (await loadChantConfig(cwd)).config.release?.images ?? [];
}

/**
 * The green gate `release.green` names (#5149), or undefined for the default.
 * A config that can't be loaded reads as naming none.
 */
async function greenOf(cwd: string): Promise<import("../../lifecycle/release-green").ReleaseGreenSource | undefined> {
  try {
    const { loadChantConfig } = await import("../../config");
    return (await loadChantConfig(cwd)).config.release?.green;
  } catch {
    return undefined;
  }
}

/**
 * The `release.publish` targets an artifact release records (#5149): read
 * only when the member declares no environments, since a release cut from
 * environments records its compile targets instead.
 */
async function artifactPublishesOf(cwd: string): Promise<import("../../lifecycle/release-store").ReleasePublish[] | undefined> {
  const { readMemberPromotionOrder } = await import("../../workspace/promotion-order");
  if (((await readMemberPromotionOrder(cwd)) ?? []).length > 0) return undefined;
  const { releasePublishTargets } = await import("../../lifecycle/release-publish");
  return (await releasePublishTargets(cwd)).map((t) => ({ target: t.key, kind: t.kind, destination: t.destination }));
}

/** How a cut's green gate reads in a line (#5149). */
export function describeGreen(green: import("../../lifecycle/release-store").ReleaseCutGreen | undefined | null): string {
  if (!green) return "no green gate recorded";
  if (green.source === "chant") return `green by ${green.tag.slice(0, green.tag.lastIndexOf("/"))} tag`;
  if (green.source === "forge-checks") return `green by ${green.checks.length} ${green.forge} check(s): ${green.checks.join(", ")}`;
  return "no green gate (release.green: none)";
}

/** The warning a cut under `release.green: "none"` prints (#5149). */
const GREEN_NONE_WARNING = 'release.green is "none": this cut checked no CI result for the commit, and the release records that it had no green gate';

async function releaseTagOf(cwd: string): Promise<import("../../lifecycle/release-tag").ReleaseTagConfig | undefined> {
  const { loadChantConfig } = await import("../../config");
  return (await loadChantConfig(cwd)).config.release?.tag;
}

async function releaseVersionOf(cwd: string): Promise<import("../../lifecycle/release-version").ReleaseVersionConfig | undefined> {
  const { loadChantConfig } = await import("../../config");
  return (await loadChantConfig(cwd)).config.release?.version;
}

/** Copy each `release.images` archive from the directory the cut built it in to the same path under `to`. */
export function copyImageArchives(images: ReadonlyArray<{ archive: string }>, from: string, to: string): void {
  for (const i of images) {
    const src = resolve(from, i.archive);
    if (!existsSync(src)) continue;
    const dest = resolve(to, i.archive);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, force: true });
  }
}

/** A commit's time in seconds, the `SOURCE_DATE_EPOCH` a release's image builds run with (#4657). */
function commitTime(cwd: string, commit: string): number {
  return Number(execFileSync("git", ["show", "-s", "--format=%ct", commit], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim());
}

/**
 * `release images <label|digest> [--no-build] [-o <file>] [--json]` (#4657): build the
 * images the release recorded again, from the release's commit checked out
 * here, refuse an archive whose digest is not the recorded one, and write the
 * recorded digests to the file the package build reads through
 * `CHANT_RELEASE_DIGESTS` (default `.chant/release-digests.json`). The
 * publish job runs it before the build that packs the package.
 */
export async function runReleaseImages(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const ref = args.extraPositional;
  const fail = (code: string, message: string, fix?: string): number => {
    if (args.json) console.log(JSON.stringify({ ref: ref ?? null, error: { code, message, ...(fix ? { fix } : {}) } }, null, 2));
    else console.error(formatError({ message: `${message} [${code}]`, ...(fix ? { hint: fix } : {}) }));
    return 1;
  };
  if (!ref) return fail("release-not-named", "release images needs a release, by label or digest", USAGE);
  const cwd = resolve(".");
  const { resolveRelease } = await import("../../lifecycle/release-store");
  const { buildReleaseImages, releaseImageDigests, resolveReleaseImages, writeReleaseDigests, ReleaseImageError, RELEASE_DIGESTS_ENV } = await import("../../lifecycle/release-images");
  const { ociArchiveDigest } = await import("../../lifecycle/publish-oci");
  const { getHeadCommit } = await import("../../lifecycle/git");
  const found = await resolveRelease(ref, { cwd });
  if (!found) return fail("release-not-found", `no release is labelled or digested "${ref}" in this member`, "Fetch chant/lifecycle (git fetch origin chant/lifecycle:chant/lifecycle), then list them with: chant release list");
  const { release, label } = found;
  const head = await getHeadCommit({ cwd });
  if (head !== release.commit) return fail("release-images-wrong-commit", `the release was cut from ${release.commit.slice(0, 12)}, and this checkout is at ${head.slice(0, 12)}, so its images would not be the release's`, `Check out the release's commit: git checkout ${release.commit}`);
  const declared = await releaseImagesOf(cwd);
  const recorded = releaseImageDigests(release, declared.map((d) => d.name));
  const missing = declared.filter((d) => recorded[d.name] === undefined).map((d) => d.name);
  if (missing.length > 0) return fail("release-image-not-recorded", `release.images names ${missing.join(", ")}, which release ${release.releaseDigest} does not record`, "Cut a new release, so its cut builds every image the config declares.");
  let built: import("../../lifecycle/release-store").ReleaseArtifact[];
  try {
    // --no-build: the archives the cut built were handed to this job, so they are read as they are.
    built = args.noBuild
      ? resolveReleaseImages(declared).map((d) => {
          const abs = resolve(cwd, d.archive);
          if (!existsSync(abs)) throw new ReleaseImageError("release-image-no-archive", `image "${d.name}" has no archive at ${d.archive}`, "Hand this job the archives the cut built, or run without --no-build to build them again.");
          return { component: d.name, kind: "image" as const, path: d.archive, digest: ociArchiveDigest(abs) };
        })
      : buildReleaseImages({ images: declared, cwd, sourceDateEpoch: commitTime(cwd, release.commit), label, archiveDigest: ociArchiveDigest, ...((await releaseVersionOf(cwd)) ? { versionArg: true } : {}) });
  } catch (err) {
    if (err instanceof ReleaseImageError) return fail(err.code, err.message, err.fix);
    throw err;
  }
  const differ = built.filter((a) => recorded[a.component] !== a.digest);
  if (differ.length > 0) {
    return fail(
      "release-image-digest-mismatch",
      differ.map((a) => `image "${a.component}" ${args.noBuild ? "is" : "built to"} ${a.digest}, and the release records ${recorded[a.component]}`).join("; "),
      "An image build must write the same archive from the same commit: set SOURCE_DATE_EPOCH-aware timestamps (rewrite-timestamp=true), and remove logs and caches from its layers.",
    );
  }
  const file = resolve(cwd, args.output ?? ".chant/release-digests.json");
  writeReleaseDigests(file, recorded);
  if (args.json) console.log(JSON.stringify({ releaseDigest: release.releaseDigest, label, digests: recorded, file }, null, 2));
  else {
    for (const [name, digest] of Object.entries(recorded)) console.error(`  ${name} ${digest}`);
    console.error(formatSuccess(`${args.noBuild ? "Checked" : "Built"} ${built.length} image(s) to the digests release ${label ?? release.releaseDigest} records, and wrote them to ${relative(cwd, file) || file}`));
    console.log(`${RELEASE_DIGESTS_ENV}=${file}`);
  }
  return 0;
}

/**
 * `release artifacts <label|digest> [--no-build] [--from <dir>] [-o <dir>] [--json]`
 * (#5151): the files `release.artifacts` declares, checked against the
 * digests the release records, from the release's commit checked out here.
 * Without a flag it builds them again; `--no-build` checks the files on
 * disk; `--from <dir>` first copies them from a directory where the cut job
 * staged them. `-o <dir>` stages the checked files in a directory, at their
 * paths in the member, for the next job. A file missing or with another
 * digest is refused.
 */
export async function runReleaseArtifacts(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const ref = args.extraPositional;
  const fail = (code: string, message: string, fix?: string): number => {
    if (args.json) console.log(JSON.stringify({ ref: ref ?? null, error: { code, message, ...(fix ? { fix } : {}) } }, null, 2));
    else console.error(formatError({ message: `${message} [${code}]`, ...(fix ? { hint: fix } : {}) }));
    return 1;
  };
  if (!ref) return fail("release-not-named", "release artifacts needs a release, by label or digest", USAGE);
  const cwd = resolve(".");
  const { resolveRelease } = await import("../../lifecycle/release-store");
  const { artifactFileProblems, buildReleaseArtifacts, copyArtifactFiles, releaseArtifactFiles, ReleaseArtifactError } = await import("../../lifecycle/release-artifacts");
  const { getHeadCommit } = await import("../../lifecycle/git");
  const found = await resolveRelease(ref, { cwd });
  if (!found) return fail("release-not-found", `no release is labelled or digested "${ref}" in this member`, "Fetch chant/lifecycle (git fetch origin chant/lifecycle:chant/lifecycle), then list them with: chant release list");
  const { release, label } = found;
  const head = await getHeadCommit({ cwd });
  if (head !== release.commit) return fail("release-artifacts-wrong-commit", `the release was cut from ${release.commit.slice(0, 12)}, and this checkout is at ${head.slice(0, 12)}, so its files would not be the release's`, `Check out the release's commit: git checkout ${release.commit}`);
  const declared = await releaseArtifactsOf(cwd);
  if (declared.length === 0) return fail("release-artifacts-not-declared", "this member's chant.config.ts has no release.artifacts, so there is nothing to check", "Declare the files the cut builds: release: { artifacts: [{ name: \"cli\", build: \"make dist\", outputs: [\"dist/cli\"] }] }");
  const files = releaseArtifactFiles(release, declared.map((d) => d.name));
  const recordedNames = new Set(files.map((f) => f.component));
  const missing = declared.filter((d) => !recordedNames.has(d.name)).map((d) => d.name);
  if (missing.length > 0) return fail("release-artifact-not-recorded", `release.artifacts names ${missing.join(", ")}, which release ${release.releaseDigest} does not record`, "Cut a new release, so its cut builds every file the config declares.");
  const from = args.migrateFrom;
  try {
    if (from !== undefined) copyArtifactFiles(files, resolve(from), cwd);
    else if (!args.noBuild) {
      const images = await releaseImagesOf(cwd);
      const built = buildReleaseArtifacts({ artifacts: declared, cwd, sourceDateEpoch: commitTime(cwd, release.commit), label, imageNames: images.map((i) => i.name) });
      const recorded = new Set(files.map((f) => f.path));
      const extra = built.filter((b) => !recorded.has(b.path)).map((b) => b.path);
      if (extra.length > 0) return fail("release-artifact-digest-mismatch", `the build wrote ${extra.join(", ")}, which release ${release.releaseDigest} does not record`, "A build of the release's commit must write the files the cut wrote. Cut a new release.");
    }
  } catch (err) {
    if (err instanceof ReleaseArtifactError) return fail(err.code, err.message, err.fix);
    throw err;
  }
  const problems = artifactFileProblems(cwd, files);
  const absent = problems.filter((p) => p.problem === "missing");
  if (absent.length > 0) return fail("release-artifact-missing", `${absent.map((p) => p.path).join(", ")} ${absent.length === 1 ? "is" : "are"} not here`, "Hand this job the files the cut staged (--from <dir>), or run without --no-build to build them again.");
  if (problems.length > 0) {
    return fail(
      "release-artifact-digest-mismatch",
      problems.map((p) => `${p.path} is ${p.digest}, and the release records ${p.recorded}`).join("; "),
      args.noBuild || from !== undefined ? "Publish the files the cut built: hand them over unchanged, or cut a new release." : "A build of the same commit must write the same bytes: set every timestamp from SOURCE_DATE_EPOCH and leave out build paths (go build -trimpath).",
    );
  }
  let staged: string | null = null;
  if (args.output) {
    staged = resolve(args.output);
    copyArtifactFiles(files, cwd, staged);
  }
  if (args.json) console.log(JSON.stringify({ releaseDigest: release.releaseDigest, label, files: files.map((f) => ({ name: f.component, path: f.path, digest: f.digest })), staged }, null, 2));
  else {
    for (const f of files) console.error(`  ${f.component} ${f.path} ${f.digest}`);
    const how = from !== undefined ? `Copied from ${from} and checked` : args.noBuild ? "Checked" : "Built and checked";
    console.error(formatSuccess(`${how} ${files.length} file(s) against release ${label ?? release.releaseDigest}${staged ? `, and staged them in ${relative(cwd, staged) || staged}` : ""}`));
  }
  return 0;
}

/**
 * `release stamp <label> [--json]` (#4840): write the label into the files
 * `release.version` names, as the cut does before its build, and leave them
 * so. The publish job runs it before its build; `chant release publish`
 * takes those files, stamped with the release's label, as the commit's.
 * `git checkout -- <files>` puts them back.
 */
export async function runReleaseStamp(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const label = args.extraPositional ?? null;
  const fail = (code: string, message: string, fix?: string): number => {
    if (args.json) console.log(JSON.stringify({ label, error: { code, message, ...(fix ? { fix } : {}) } }, null, 2));
    else console.error(formatError({ message: `${message} [${code}]`, ...(fix ? { hint: fix } : {}) }));
    return 1;
  };
  if (label === null) return fail("release-version-no-label", "release stamp needs the release's label", "chant release stamp <label> [--json]");
  const cwd = resolve(".");
  const config = await releaseVersionOf(cwd);
  if (!config) return fail("release-version-not-declared", "this member's chant.config.ts has no release.version, so there is nothing to stamp", "Name the package directories: release: { version: { packages: [\"packages/cli\"] } }");
  const { stampReleaseVersion, ReleaseVersionError, ownNames } = await import("../../lifecycle/release-version");
  if (args.train !== undefined && config.ranges !== "train") return fail("release-ranges-not-train", `--train names a train, and this member's release.version.ranges is ${config.ranges ?? "unset"}`, 'Set release.version.ranges to "train", or leave --train out.');
  let files: string[];
  try {
    let train: import("../../lifecycle/release-version").RangeLabels | undefined;
    if (args.train !== undefined) {
      const { trainLabels, TrainLabelsError } = await import("../../workspace/train-range-labels");
      try {
        train = await trainLabels(cwd, args.train, ownNames(cwd, config), label);
      } catch (err) {
        if (err instanceof TrainLabelsError) return fail(err.code, err.message, err.fix);
        throw err;
      }
    }
    files = stampReleaseVersion({ cwd, config, label, ...(train ? { train } : {}) }).files;
  } catch (err) {
    if (err instanceof ReleaseVersionError) return fail(err.code, err.message, err.fix);
    throw err;
  }
  if (args.json) console.log(JSON.stringify({ label, files }, null, 2));
  else console.error(formatSuccess(`Stamped ${label} into ${files.join(", ")}`));
  return 0;
}

/**
 * `release tag <label|digest|tag> [--json]` (#5150): the tag `release.tag`
 * gives a release of this member, found by its label, its digest, or the tag
 * itself. The ledger names the release: a tag is matched by rendering the
 * template for each label the member's ledger holds, never parsed. The
 * publish job of `chant release workflow` reads the label of the tag that
 * started it this way.
 */
export async function runReleaseTag(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const ref = args.extraPositional ?? null;
  const fail = (code: string, message: string, fix?: string): number => {
    if (args.json) console.log(JSON.stringify({ ref, error: { code, message, ...(fix ? { fix } : {}) } }, null, 2));
    else console.error(formatError({ message: `${message} [${code}]`, ...(fix ? { hint: fix } : {}) }));
    return 1;
  };
  if (ref === null) return fail("release-not-named", "release tag needs a release, by label, digest or tag", "chant release tag <label|digest|tag> [--json]");
  const cwd = resolve(".");
  const { fetchLifecycle } = await import("../../lifecycle/git");
  const { resolveRelease, readCuts } = await import("../../lifecycle/release-store");
  const t = await import("../../lifecycle/release-tag");
  await fetchLifecycle({ cwd }).catch(() => false);
  let tags: import("../../lifecycle/release-tag").MemberTags;
  try {
    tags = await t.memberTags(cwd);
  } catch (err) {
    if (err instanceof t.ReleaseTagError) return fail(err.code, err.message, err.fix);
    throw err;
  }
  let found = await resolveRelease(ref, { cwd });
  if (!found) {
    const labels = (await readCuts({ cwd })).cuts.map((c) => c.label).filter((l): l is string => l !== null);
    const label = t.labelOfTag(tags.template, tags.place, ref, new Set(labels));
    if (label !== null) found = await resolveRelease(label, { cwd });
  }
  if (!found) return fail("release-not-found", `no release of this member is labelled, digested or tagged "${ref}"`, "Fetch chant/lifecycle (git fetch origin chant/lifecycle:chant/lifecycle), then list them with: chant release list");
  const { release, label } = found;
  let tag: string | null;
  let floating: string | null;
  try {
    tag = label !== null ? t.renderReleaseTag(tags.template, tags.place, label) : null;
    floating = label !== null ? t.renderFloatingTag(tags.template, tags.place, label) : null;
  } catch (err) {
    if (err instanceof t.ReleaseTagError) return fail(err.code, err.message, err.fix);
    throw err;
  }
  if (args.json) {
    console.log(JSON.stringify({ releaseDigest: release.releaseDigest, label, commit: release.commit, tag, floating, template: tags.template.name }, null, 2));
    return 0;
  }
  if (tag === null) return fail("release-no-label", `${release.releaseDigest} has no label, so it has no tag`);
  console.log(tag);
  return 0;
}

function describeActorSource(source: import("../../lifecycle/release-workstation").ActorSource): string {
  switch (source) {
    case "flag":
      return "--actor";
    case "signer":
      return "the signers file at base, for the signing key";
    case "ci":
      return "the CI's actor";
    case "git":
      return "git user.email";
    case "user":
      return "$USER";
  }
}

/**
 * `release cut [<label>]` (#4026, #4027). A dry run unless `--yes`: it
 * refuses a dirty tree, a commit that is not on trunk and pushed, and one
 * that is not green, compiles every environment, and prints what the cut
 * would record, build and tag, and what publishes where. With `--yes` it
 * cuts, signs with `--sign`, records the cut with its actor and run id,
 * tags the commit locally and prints the next command.
 *
 * `--at <sha>` (#4168 4.2) cuts that commit instead of `HEAD`, from a
 * temporary worktree (../../lifecycle/release-at.ts), so the checkout need
 * not be clean or at the commit. The label reaches every compile and
 * artifact build as `CHANT_RELEASE_LABEL` (decision 5).
 */
export async function runReleaseCut(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const positional = args.extraPositional;
  if (positional && args.label && positional !== args.label) {
    console.error(formatError({ message: `the label is given twice, as "${positional}" and --label "${args.label}"`, hint: USAGE }));
    return 1;
  }
  let label = positional ?? args.label ?? null;
  if (args.pre !== undefined && label !== AUTO_LABEL) {
    console.error(formatError({ message: "--pre names the prerelease id of a computed label, and the cut is given its label", hint: "Cut auto --pre <id>, or give the prerelease label itself, such as 1.5.0-rc.0." }));
    return 1;
  }
  // #4693: the reason is the override's, written by the person who overrides.
  if (args.reason !== undefined) {
    console.error(formatError({
      message: "release cut takes no --reason: an override's reason is on the override itself",
      hint: "Cut with --override-green: it names the chant approve policy-override command that records the override and its reason.",
    }));
    return 1;
  }
  const dryRun = args.yes !== true;
  const cwd = resolve(".");
  const { spawnTargetCompiler, ReleaseCompileError, RELEASE_LABEL_ENV } = await import("../../components/release-compile");
  const { cutRelease, planRelease, ReleaseCutError } = await import("../../lifecycle/release-cut");
  const { ReleaseLabelError } = await import("../../lifecycle/release-store");
  const { pushLifecycleRebasing, getHeadCommit } = await import("../../lifecycle/git");
  const { resolveCiRun } = await import("../../lifecycle/release-ledger");
  const ws = await import("../../lifecycle/release-workstation");
  const { detectProvenance, releasePublishTargets } = await import("../../lifecycle/release-publish");
  const fail = (code: string, message: string, fix?: string): number => {
    console.error(formatError({ message: `${message} [${code}]`, ...(fix ? { hint: fix } : {}) }));
    return 1;
  };
  const at = await import("../../lifecycle/release-at");
  let checkout: import("../../lifecycle/release-at").CommitCheckout | null = null;
  let stamped: import("../../lifecycle/release-version").Stamped | null = null;

  try {
    // The workstation checks come first, in the order #4027 lists them; the
    // green check and the rest are the cut's own.
    const top = (() => {
      try {
        return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return null;
      }
    })();
    let commit: string | null = null;
    let trunk: import("../../lifecycle/release-workstation").Trunk | null = null;
    let signers: readonly import("../../workspace/trust/trust-files").Signer[] = [];
    let member: string | null = null;
    let composed: { branch: string; base: string; sources: string[] } | undefined;
    if (args.at !== undefined && !top) {
      return fail("not-a-git-repository", "--at names a commit, and this directory is not in a git repository");
    }
    if (top) {
      if (args.at !== undefined) {
        commit = at.resolveCutCommit(top, args.at);
      } else {
        commit = await getHeadCommit({ cwd });
        ws.checkCleanTree(top, commit);
      }
      const { scopeSource } = await import("../../workspace/write-scope");
      const { releaseRuleFrom } = await import("../../workspace/identity");
      const source = scopeSource(cwd);
      const greenDecl = source.declaration?.ci?.green ?? null;
      const primary = ws.resolveTrunk(top, greenDecl?.branch ?? null);
      trunk = primary;
      try {
        // #4325: a commit of a branch ci.green also judges (one ci.branches routes members to) is cut like trunk's.
        trunk = ws.checkOnGreenBranches(top, commit, primary, (greenDecl?.branches ?? []).slice(1));
      } catch (err) {
        // #4168 4.3: a commit of a pushed compose branch is cut too, and the cut records what it carries.
        if (!(err instanceof ws.WorkstationCheckError) || err.code !== "release-commit-not-on-trunk") throw err;
        const refs = await import("../../lifecycle/compose-refs");
        const on = refs.composeBranchContaining(top, commit, trunk.remote);
        const trunkRef = `refs/remotes/${trunk.remote}/${trunk.branch}`;
        const composition = on ? refs.compositionOnTrunk(top, commit, trunkRef, on.branch) : null;
        if (!on || !composition) throw err;
        composed = { branch: on.branch, base: composition.base, sources: composition.sources };
      }
      signers = releaseRuleFrom(source).rule.signers.signers;
      const { resolveMemberLedger } = await import("../../lifecycle/member-ledger");
      const ledger = await resolveMemberLedger(cwd);
      member = ledger.members.length > 0 ? ledger.members.join("/") : null;
    }

    // #5159: `auto` is the label the commits and intent files since the previous release give, and every
    // labelled cut consumes the intent files that name the member.
    let computed: import("../../lifecycle/release-next").NextRelease | null = null;
    let intents: import("../../lifecycle/release-next").NextRelease["intents"] = [];
    {
      const rn = await import("../../lifecycle/release-next");
      try {
        if (label === AUTO_LABEL) {
          computed = await rn.nextRelease({ cwd, ...(commit ? { at: commit } : {}), ...(args.pre !== undefined ? { pre: args.pre } : {}) });
          label = computed.label;
          intents = computed.intents;
        } else if (label !== null && top && commit) {
          intents = await rn.memberPendingIntents(cwd, top, commit);
        }
      } catch (err) {
        if (err instanceof rn.ReleaseNextError) return fail(err.code, `no release was cut: ${err.message}`, err.fix);
        throw err;
      }
    }

    // The signing key is resolved now, so a dry run shows a key that can't be read.
    let publicKey: string | null = null;
    if (args.sign !== undefined) {
      const { resolveSigningKey, SealError } = await import("../../workspace/trust/seal");
      try {
        const key = resolveSigningKey(args.sign, cwd);
        try {
          if (!existsSync(key.file)) return fail("release-signer-refused", `no release was cut: the signing key ${key.file} does not exist`);
          publicKey = ws.publicKeyOf(key.file);
        } finally {
          key.cleanup();
        }
      } catch (err) {
        if (!(err instanceof SealError)) throw err;
        return fail("release-signer-refused", `no release was cut: ${err.message}`);
      }
    }
    const who = ws.resolveCutActor({ cwd, ...(args.actor ? { explicit: args.actor } : {}), publicKey, signers });
    if (!who) {
      console.error(formatError({ message: "Could not resolve --actor", hint: "Pass --actor explicitly, or set git's user.email, GITHUB_ACTOR, GITLAB_USER_LOGIN or USER." }));
      return 1;
    }
    const actor = who.actor;
    const ci = resolveCiRun(process.env);
    const params = parseParamFlags(args.param);
    // #4694: images built elsewhere, handed to the cut by digest, one per component.
    const images: Record<string, string> = {};
    for (const value of args.images ?? []) {
      const eq = value.indexOf("=");
      const component = eq > 0 ? value.slice(0, eq) : "";
      if (!component || eq === value.length - 1) {
        return fail("release-image-invalid", `--image ${value}: name the component and the image, as --image <component>=<repository>@sha256:<hex>`);
      }
      if (images[component] !== undefined && images[component] !== value.slice(eq + 1)) {
        return fail("release-image-invalid", `--image names two images for "${component}"; a release records one image per component`);
      }
      images[component] = value.slice(eq + 1);
    }
    // --at: the cut reads, compiles and builds the commit's tree, not the checkout's.
    if (args.at !== undefined && top && commit) checkout = at.checkoutCommit(top, cwd, commit);
    const cutCwd = checkout?.memberDir ?? cwd;
    // #5150: the tag from release.tag in the commit's own config, refused when another member's template can render it.
    const tagsMod = await import("../../lifecycle/release-tag");
    const tags = top ? await tagsMod.memberTags(cwd, { config: await releaseTagOf(cutCwd), top }) : null;
    if (tags) await tagsMod.checkTagCollisions(cwd, tags);
    const tagName = (l: string): string => tagsMod.renderReleaseTag(tags!.template, tags!.place, l);
    const tag = label !== null && commit !== null && top ? { name: tagName(label), state: ws.checkReleaseTag(top, tagName(label), commit) } : null;
    const versionConfig = await releaseVersionOf(cutCwd);
    // #4657: the images release.images declares are built first, and their digests handed to the build command.
    const declaredImages = await releaseImagesOf(cutCwd);
    const digestsFile = declaredImages.length > 0 ? join(tmpdir(), `chant-release-digests-${process.pid}.json`) : undefined;
    const compiler = spawnTargetCompiler({ ...compileInputs(ctx, params, cutCwd, label), ...(digestsFile ? { releaseDigests: digestsFile } : {}) });
    const buildImages = digestsFile
      ? async (at: string) => {
          const { buildReleaseImages, writeReleaseDigests, ReleaseImageError } = await import("../../lifecycle/release-images");
          const { ociArchiveDigest } = await import("../../lifecycle/publish-oci");
          try {
            const built = buildReleaseImages({ images: declaredImages, cwd: cutCwd, sourceDateEpoch: commitTime(cutCwd, at), label, archiveDigest: ociArchiveDigest, ...(versionConfig ? { versionArg: true } : {}) });
            writeReleaseDigests(digestsFile, Object.fromEntries(built.map((a) => [a.component, a.digest])));
            return built;
          } catch (err) {
            const code = err instanceof ReleaseImageError ? err.code : (err as { code?: unknown }).code;
            const fix = err instanceof ReleaseImageError ? err.fix : undefined;
            throw new ReleaseCutError(code === "release-image-name-taken" ? "release-image-name-taken" : "release-image-build-failed", `no release was cut: ${(err as Error).message}`, fix);
          }
        }
      : undefined;
    // #5151: the files release.artifacts declares, built after the images and recorded as assets.
    const declaredArtifacts = await releaseArtifactsOf(cutCwd);
    const buildArtifacts =
      declaredArtifacts.length > 0
        ? async (at: string) => {
            const { buildReleaseArtifacts, ReleaseArtifactError } = await import("../../lifecycle/release-artifacts");
            try {
              return buildReleaseArtifacts({ artifacts: declaredArtifacts, cwd: cutCwd, sourceDateEpoch: commitTime(cutCwd, at), label, imageNames: declaredImages.map((d) => d.name) });
            } catch (err) {
              if (!(err instanceof ReleaseArtifactError)) throw err;
              throw new ReleaseCutError(err.code as import("../../lifecycle/release-cut").ReleaseCutCode, `no release was cut: ${err.message}`, err.fix);
            }
          }
        : undefined;
    // #4840: release.version stamps the label into package.json once the cut has found the tree clean.
    const stamp = versionConfig
      ? async () => {
          const { stampReleaseVersion, ReleaseVersionError } = await import("../../lifecycle/release-version");
          try {
            if (!stamped) stamped = stampReleaseVersion({ cwd: cutCwd, config: versionConfig, label });
          } catch (err) {
            if (err instanceof ReleaseVersionError) throw new ReleaseCutError(err.code as import("../../lifecycle/release-cut").ReleaseCutCode, `no release was cut: ${err.message}`, err.fix);
            throw err;
          }
        }
      : undefined;
    // #4692: the lane is the commit's own config's under --at.
    const lane = await laneOf(ctx, cutCwd);
    // #5149: the green gate, and for a member with no environments what release.publish publishes.
    const greenSource = await greenOf(cutCwd);
    const publishes = await artifactPublishesOf(cutCwd);
    const buildCommand = args.buildCommand;
    const build =
      publishes !== undefined && buildCommand
        ? () => {
            const env: NodeJS.ProcessEnv = { ...process.env };
            delete env[RELEASE_LABEL_ENV];
            delete env.CHANT_RELEASE_DIGESTS;
            if (label !== null) env[RELEASE_LABEL_ENV] = label;
            if (digestsFile) env.CHANT_RELEASE_DIGESTS = digestsFile;
            const run = spawnSync(buildCommand, { cwd: cutCwd, shell: true, stdio: ["ignore", 2, 2], env });
            if (run.status !== 0) throw new ReleaseCompileError(`the build command exited ${run.status ?? "with a signal"}: ${buildCommand}`);
          }
        : undefined;
    const request = {
      cwd: cutCwd,
      compiler,
      label,
      actor,
      ...(args.sign !== undefined ? { sign: args.sign } : {}),
      ...(composed ? { composed } : {}),
      ...(args.channel ? { channel: args.channel } : {}),
      ...(lane !== undefined ? { lane } : {}),
      ...(args.overrideGreen ? { overrideGreen: true } : {}),
      ...(Object.keys(images).length > 0 ? { images } : {}),
      ...(buildImages ? { buildImages } : {}),
      ...(buildArtifacts ? { buildArtifacts } : {}),
      ...(stamp ? { stamp } : {}),
      ...(greenSource ? { green: greenSource } : {}),
      ...(publishes ? { publishes } : {}),
      ...(build ? { build } : {}),
      ...(intents.length > 0 ? { intents: intents.map(({ path, added, bump }) => ({ path, added, bump })) } : {}),
    };

    if (dryRun) {
      const plan = await planRelease(request);
      // Under the release gate, a key the signers file at base lists for someone else is refused now, not after the build.
      if (plan.signatureRequired && publicKey !== null && !signers.some((s) => s.key === publicKey && s.principal.trim().toLowerCase() === actor.trim().toLowerCase())) {
        return fail(
          "release-signer-refused",
          `no release would be cut: the signing key is not listed for ${actor} in the signers file at base, and identity.gates.release counts only a cut its signer signs`,
          "Pass --actor <principal> naming the key's signer, or sign with that principal's key.",
        );
      }
      const ref = plan.label ?? plan.alreadyCut ?? plan.releaseDigest;
      const provenance = detectProvenance();
      // The targets release publish would run, as the config here declares them; their files are read at publish.
      const publishTargets = await releasePublishTargets(cutCwd).then(
        (ts) => ts.map((t) => `${t.name} to ${t.destination}`),
        (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
      );
      const deployRef = plan.label ?? "<label|digest>";
      const doc = {
        dryRun: true,
        ...plan,
        actor,
        actorSource: who.source,
        run: ci ? { runId: ci.runId, runOrigin: ci.runOrigin } : { runId: null, runOrigin: { forge: "local" as const } },
        trunk,
        composed: composed ?? null,
        channel: args.channel ?? null,
        prerelease: prereleaseOf(plan.label) !== null,
        at: args.at !== undefined ? { ref: args.at, commit } : null,
        sign: args.sign !== undefined ? { key: publicKey !== null ? publicKey.split(" ")[0] : null, readable: publicKey !== null } : null,
        tag: tag ? { name: tag.name, exists: tag.state === "present" } : null,
        computed: computed ? { from: computed.from, bump: computed.bump, alreadyCut: computed.alreadyCut, commits: computed.commits.length } : null,
        intents: intents.map(({ path, bump }) => ({ path, bump })),
        publish: { targets: Array.isArray(publishTargets) ? publishTargets : [], provenance },
        next: [sameWithYes(process.argv.slice(2))],
      };
      if (args.json) {
        console.log(JSON.stringify(doc, null, 2));
        return 0;
      }
      const name = plan.label ? formatBold(plan.label) : "an unlabelled release";
      const greenIn = plan.override
        ? `not green: ${plan.override.tag.startsWith("forge-checks/") ? "its forge checks did not pass" : `no ${plan.override.tag.slice(0, plan.override.tag.lastIndexOf("/"))} tag`}`
        : plan.lane !== null
          ? `green in lane ${plan.lane}`
          : plan.green?.source === "forge-checks"
            ? `green by its ${plan.green.forge} checks`
            : plan.green?.source === "none"
              ? "no green gate"
              : "green";
      const where = composed
        ? ` (on ${trunk!.remote}/${composed.branch}, composed on ${composed.base.slice(0, 12)} from ${composed.sources.length} trunk commit(s), ${greenIn})`
        : trunk
          ? ` (on ${trunk.remote}/${trunk.branch}, ${greenIn})`
          : "";
      console.log(`Dry run: cut ${name} from commit ${plan.commit.slice(0, 12)}${where}`);
      if (args.channel) console.log(`  channel ${args.channel}: a publish moves ${args.channel}, not latest`);
      if (prereleaseOf(plan.label)) console.log(`  prerelease: ${prereleaseNote(plan.label, args.channel)}`);
      if (computed && !computed.alreadyCut) console.log(`  label from release next: ${computed.bump ?? "the prerelease's version"} from ${computed.from.label}, ${computed.commits.length} commit(s) and ${computed.intents.length} intent file(s) since`);
      for (const i of intents) console.log(`  consumes ${i.path} (${i.bump})`);
      if (plan.green) console.log(`  gate: ${describeGreen(plan.green)}`);
      if (plan.green?.source === "none") console.error(formatWarning({ message: GREEN_NONE_WARNING }));
      if (plan.publishes) console.log(`  an artifact release: no environment is compiled, and it records ${plan.publishes.length} publish target(s)`);
      if (plan.override) console.log(`  under the override by ${plan.override.by} at ${plan.override.at}${plan.override.sealed ? ", sealed" : ""}: ${plan.override.reason}; the cut spends it`);
      if (plan.alreadyCut) console.log(`  already cut as ${plan.alreadyCut}: the cut would record nothing new`);
      console.log(`  actor ${actor} (from ${describeActorSource(who.source)})`);
      console.log(`  run ${ci ? `${ci.runId} (${ci.runOrigin.forge})` : "minted on this machine at the cut (local)"}`);
      console.log(
        `  ${args.sign !== undefined ? `signed with ${publicKey ? publicKey.split(" ")[0] : "a key whose public half can't be read until it signs"}` : "not signed"}` +
          (plan.signatureRequired ? "; identity.gates.release requires a signed cut" : ""),
      );
      console.log(`  tag ${tag ? `${tag.name}${tag.state === "present" ? " (exists)" : ""}, made here and not pushed` : "none, since the release has no label"}`);
      for (const t of plan.targets) {
        console.log(`  ${t.env}: ${t.templates.length} template(s)${t.params.length > 0 ? `, ${t.params.map((p) => `${p.name}=${p.value}`).join(" ")}` : ""}`);
        // #4155, #4542: the directories recorded file by file, a terraform root's among them.
        for (const tree of t.trees ?? []) console.log(`    ${tree.component ?? "-"}: ${tree.path}/ recorded`);
      }
      for (const b of plan.build) console.log(`  ${b.component}: artifacts built in ${b.env}`);
      for (const r of plan.reused) console.log(`  ${r.component}: artifacts unchanged, carried from ${r.from}`);
      for (const h of plan.handed) console.log(`  ${h.component}: image ${h.ref}, handed to the cut, not built`);
      console.log(`  digest ${plan.releaseDigest ?? "decided when the artifacts are built"}`);
      console.log("What will be published where:");
      if (plan.publishSteps.length === 0 && !plan.publishes) console.log("  no component declares a publish step");
      for (const p of plan.publishSteps) {
        console.log(`  ${p.component}: ${p.kind}${p.to ? ` to ${p.to}` : ""} in ${p.envs.join(", ")}, by that environment's deploy (chant components promote --release ${deployRef})`);
      }
      const publishCmd = `chant release publish ${ref ?? "<label|digest>"}`;
      if (!Array.isArray(publishTargets)) console.log(`  ${publishCmd}: the publish targets can't be read: ${publishTargets.message}`);
      else if (publishTargets.length === 0) console.log(`  ${publishCmd}: nothing, since this member declares no publish target (release.publish in chant.config.ts)`);
      else for (const t of publishTargets) console.log(`  ${publishCmd}: ${t}`);
      if (!provenance.oidc) console.log(`  a publish from here would carry no OIDC provenance: ${provenance.reason}`);
      console.error(`Dry run: nothing was cut, signed or tagged. Run again with --yes to cut: ${doc.next[0]}`);
      return 0;
    }

    const result = await cutRelease(request);
    // #4657: under --at the images were built in the commit's own checkout, which is removed below; the archives the
    // release records are put where release.images names them here, so the job's next step (the hand-off to the
    // publish job) finds them.
    if (checkout && declaredImages.length > 0) copyImageArchives((await import("../../lifecycle/release-images")).resolveReleaseImages(declaredImages), cutCwd, cwd);
    // #5151: the files too, so `release artifacts -o` in the same job stages them for the publish job.
    if (checkout && declaredArtifacts.length > 0) {
      const { copyArtifactFiles, releaseArtifactFiles } = await import("../../lifecycle/release-artifacts");
      copyArtifactFiles(releaseArtifactFiles(result.release, declaredArtifacts.map((a) => a.name)), cutCwd, cwd, { missingOk: true });
    }
    // #4965: the record must be on the remote before the release is tagged. The release workflow pushes the tag
    // right after the cut, and a tag whose record never landed spends the label: the publish job finds no release.
    // A refused push is tried again; one that never lands stops the cut here, untagged and non-zero.
    let push: { pushed: boolean; pushWarning?: string };
    try {
      push = await pushLifecycleRebasing({ cwd, requireLanded: true });
    } catch (err) {
      return fail(
        "release-record-not-pushed",
        `the release was cut and its record did not reach the remote, so the commit was not tagged: ${err instanceof Error ? err.message : String(err)}`,
        "Nothing was tagged, so the label is not spent. Run the cut again (in CI, run the release workflow again) once the remote takes pushes to chant/lifecycle.",
      );
    }
    // The tag names the release's label, which a re-cut with no label reads from the earlier cut.
    let tagged: { name: string; created: boolean } | null = null;
    let tagWarning: string | undefined;
    if (result.label !== null && top) {
      const name = tagName(result.label);
      try {
        const state = ws.checkReleaseTag(top, name, result.release.commit);
        if (state === "absent") ws.createReleaseTag(top, name, result.release.commit, { releaseDigest: result.release.releaseDigest, label: result.label, member });
        tagged = { name, created: state === "absent" };
      } catch (err) {
        tagWarning = `the release was cut, and the commit was not tagged: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const firstEnv = result.release.targets[0]?.env ?? null;
    const next = nextCommands({
      ref: result.label ?? result.release.releaseDigest,
      tag: tagged?.name ?? null,
      inCi: ci !== undefined,
      firstEnv,
      noComponents: result.release.targets.every((t) => t.templates.every((tpl) => tpl.component === null)) && result.release.artifactDigests.length === 0,
    });
    if (args.json) {
      console.log(
        JSON.stringify(
          { dryRun: false, release: result.release, label: result.label, cut: result.cut, stored: result.stored, reused: result.reused, handed: result.handed, actor, actorSource: who.source, tag: tagged, composed: composed ?? null, channel: args.channel ?? null, prerelease: prereleaseOf(result.label) !== null, lane: lane ?? null, next },
          null,
          2,
        ),
      );
    } else {
      const name = result.label ? formatBold(result.label) : "unlabelled release";
      if (result.cut) console.error(formatSuccess(`Cut ${name}: ${result.release.releaseDigest}`));
      else console.error(formatSuccess(`Already cut${result.label ? ` as ${formatBold(result.label)}` : ""}: ${result.release.releaseDigest}`));
      console.error(`  commit ${result.release.commit}${composed ? `, composed on ${composed.base.slice(0, 12)} on ${composed.branch}` : ""}${lane !== undefined ? `, green in lane ${lane}` : ""}`);
      if (args.channel) console.error(`  channel ${args.channel}`);
      if (prereleaseOf(result.label)) console.error(`  prerelease: ${prereleaseNote(result.label, args.channel)}`);
      for (const i of result.cut?.intents ?? []) console.error(`  consumed ${i.path} (${i.bump})`);
      if (result.cut?.override) console.error(`  not green: cut under the override by ${result.cut.override.by}: ${result.cut.override.reason}`);
      if (result.cut?.green) console.error(`  gate: ${describeGreen(result.cut.green)}`);
      if (result.release.publishes) console.error(`  publishes: ${result.release.publishes.map((p) => `${p.kind} to ${p.destination}`).join("; ") || "nothing"}`);
      if (result.cut) console.error(`  ${result.cut.signature ? `signed by ${result.cut.actor}` : `not signed; actor ${result.cut.actor}`}, run ${result.cut.runId}`);
      console.error(
        `  artifacts ${result.release.artifactDigests.length}, ${result.release.publishes ? "no environment (an artifact release)" : `targets ${result.release.targets.map((t) => `${t.env} (${t.templates.length} template${t.templates.length === 1 ? "" : "s"})`).join(", ")}`}`,
      );
      for (const r of result.reused) console.error(`  ${r.component}: artifacts unchanged, carried from ${r.from}`);
      for (const h of result.handed) console.error(`  ${h.component}: image ${h.ref}, handed to the cut`);
      if (tagged) console.error(`  tag ${tagged.name}${tagged.created ? "" : " (already there)"}, not pushed`);
      console.error(`Next: ${next[0]}`);
      for (const n of next.slice(1)) console.error(`  or: ${n}`);
      console.log(result.release.releaseDigest);
    }
    if (push.pushWarning) console.error(formatWarning({ message: push.pushWarning }));
    if (tagWarning) console.error(formatWarning({ message: tagWarning }));
    if (result.cut?.green?.source === "none") console.error(formatWarning({ message: GREEN_NONE_WARNING }));
    return 0;
  } catch (err) {
    if (err instanceof (await import("../../lifecycle/release-tag")).ReleaseTagError) return fail(err.code, `no release was cut: ${err.message}`, err.fix);
    if (err instanceof ws.WorkstationCheckError || err instanceof ReleaseCutError || err instanceof at.CutAtError) {
      // #4693: a request for an override goes where the person who answers it reads.
      if (err instanceof ReleaseCutError && err.recorded) {
        const { pushLifecycleReport } = await import("../../lifecycle/git");
        const push = await pushLifecycleReport({ cwd }).catch(() => ({ pushed: false, pushWarning: undefined }));
        if (push.pushWarning) console.error(formatWarning({ message: push.pushWarning }));
      }
      return fail(err.code, err.message, err.fix);
    }
    if (err instanceof ReleaseLabelError) return fail(err.code, err.message);
    if (err instanceof ReleaseCompileError) {
      console.error(formatError({ message: `no release was cut: ${err.message}` }));
      return 1;
    }
    throw err;
  } finally {
    (stamped as import("../../lifecycle/release-version").Stamped | null)?.restore();
    checkout?.remove();
  }
}

/**
 * `release publish <label|digest> [--yes]` (#4027, #4047): publish a cut
 * release to the targets the member declares under `release.publish` in
 * its `chant.config.ts`. It refuses a release no cut names, one cut from a
 * revoked commit, one with no signature that verifies against the signers
 * file at base unless `--allow-unsigned` (#4049; never under
 * identity.gates.release), and, when there is a target, a checkout that is
 * not the release's commit with a clean tree. It warns before publishing
 * when the run has no OIDC token, so what it publishes carries no
 * provenance, and refuses under `--require-provenance`. Each target attaches
 * an SBOM and the release's provenance statement (#4049). Every
 * target is planned (its files read and checked, its credentials found)
 * before any publishes. Without `--yes` it is a dry run that prints the plan
 * and uploads nothing. With `--yes` it stages every target, then reveals them
 * (#4048, `runPublish`), recording each step in `_releases/publishes.jsonl`,
 * so running it again after a failure resumes. Every line is redacted.
 */
export async function runReleasePublish(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const ref = args.extraPositional;
  if (!ref) {
    console.error(formatError({ message: "release publish needs a release", hint: USAGE }));
    return 1;
  }
  const dryRun = args.yes !== true;
  const cwd = resolve(".");
  const fail = (code: string, message: string, fix?: string): number => {
    console.error(formatError({ message: `${message} [${code}]`, ...(fix ? { hint: fix } : {}) }));
    return 1;
  };
  const { fetchLifecycle } = await import("../../lifecycle/git");
  const { preparePublish, publishContext, runPublish, PublishTargetError, PublishRunError } = await import("../../lifecycle/release-publish");
  const { publishProgress, progressOf, readPublishRecords } = await import("../../lifecycle/publish-record");
  await fetchLifecycle({ cwd }).catch(() => false);
  const prepared = await preparePublish({ cwd, ref, allowUnsigned: args.allowUnsigned === true, requireProvenance: args.requireProvenance === true });
  if ("refusal" in prepared) return fail(prepared.refusal.code, prepared.refusal.message, prepared.refusal.fix);
  const { release, label, signature, provenance, warning, signatureWarning, signingWarning, targets, redactor } = prepared;
  const name = label ?? release.releaseDigest;
  const deploySteps = release.targets.map((t) => t.env);
  const say = (line: string) => console.error(redactor.redact(line));
  const failed = (code: string, message: string, fix?: string) => fail(code, redactor.redact(message), fix);
  const errorOf = (err: unknown): { code: string; message: string; fix?: string } =>
    err instanceof PublishTargetError ? { code: err.code, message: err.message, ...(err.fix ? { fix: err.fix } : {}) } : { code: "publish-failed", message: err instanceof Error ? err.message : String(err) };

  if (!args.json) {
    say(`${dryRun ? "Dry run: publish" : "Publishing"} ${formatBold(name)} (${release.releaseDigest}) from commit ${release.commit.slice(0, 12)}`);
    say(`  ${signature.status === "verified" ? `signed by ${signature.actor}` : signature.status === "unsigned" ? "not signed" : `signature unverified: ${signature.reason}`}`);
  }
  // The warnings go to stderr with --json too, before any target runs.
  if (signatureWarning) console.error(formatWarning({ message: signatureWarning }));
  if (warning) console.error(formatWarning({ message: warning }));
  if (signingWarning) console.error(formatWarning({ message: signingWarning }));
  if (prepared.signing && !args.json) say(`  signing images and forge assets with Sigstore (${prepared.signing.signer.name}) as ${prepared.signing.identity.identity}, issuer ${prepared.signing.identity.issuer}`);
  // #4168 4.3: a release cut with --channel moves that tag, not latest.
  const pctx = publishContext(prepared, { cwd, tag: prepared.channel, log: (line) => (args.json ? undefined : console.error(`    ${line}`)) });

  // Every target is planned before any publishes, so a missing file or credential stops the publish with nothing sent.
  const progress = publishProgress(await readPublishRecords(release.releaseDigest, { cwd }).catch(() => []));
  const planned: Array<{ kind: string; name: string; destination: string; progress: "none" | "staged" | "revealed"; items: import("../../lifecycle/release-publish").PublishItem[] }> = [];
  for (const target of targets) {
    try {
      planned.push({ kind: target.kind, name: target.name, destination: target.destination, progress: progressOf(progress, target), items: await target.plan(pctx) });
    } catch (err) {
      const e = errorOf(err);
      return failed(e.code, `nothing was published: ${target.name}: ${e.message}`, e.fix);
    }
  }
  const promoteHint = (): string | null => {
    if (deploySteps.length === 0) return null;
    const noComponents = release.artifactDigests.length === 0 && release.targets.every((t) => t.templates.every((tpl) => tpl.component === null));
    return noComponents
      ? `  Each environment deploys the files the release recorded: chant release export ${name} --env ${deploySteps[0]}`
      : `  A component's publish steps run in each environment's deploy of the release: chant components promote --release ${name} --to ${deploySteps[0]}`;
  };
  const pre = prereleaseOf(label);
  if (pre && !args.json) say(`  prerelease: ${prereleaseNote(label, prepared.channel ?? undefined)}`);
  const floating = prepared.floating ?? null;
  const base = { releaseDigest: release.releaseDigest, label, prerelease: pre !== null, ...(pre ? { distTag: prepared.channel ?? pre.distTag } : {}), commit: release.commit, signature, provenance, warnings: [signatureWarning, warning, signingWarning].filter((w): w is string => w !== null), signing: prepared.signing ? { identity: prepared.signing.identity, signer: prepared.signing.signer.name } : null, ...(floating ? { floating } : {}) };
  const floatingLine = (f: import("../../lifecycle/release-publish").FloatingTag, done: boolean): string =>
    f.move ? `  floating tag ${f.name}: ${done ? "moved" : "moves"} to ${f.commit.slice(0, 12)} once every target has revealed` : `  floating tag ${f.name}: left where it is, since ${f.reason}`;

  if (dryRun) {
    const next = [sameWithYes(process.argv.slice(2))];
    if (args.json) {
      console.log(redactor.redact(JSON.stringify({ dryRun: true, ...base, targets: planned, published: [], environments: deploySteps, next }, null, 2)));
      return 0;
    }
    const out = (line: string) => console.log(redactor.redact(line));
    out("What would be published where:");
    if (planned.length === 0) out("  nothing: this member declares no publish target (release.publish in chant.config.ts)");
    if (floating) out(floatingLine(floating, false));
    for (const p of planned) {
      const earlier = p.progress === "revealed" ? " (published by an earlier run; skipped)" : p.progress === "staged" ? " (staged by an earlier run; only revealed)" : "";
      out(`  ${p.name}${provenance.oidc && p.kind === "npm" ? ", with --provenance" : ""}${earlier}:`);
      for (const i of p.items) out(`    ${describeItem(i)}`);
    }
    say(`Dry run: nothing was published. Run again with --yes to publish: ${next[0]}`);
    const hint = planned.length === 0 ? promoteHint() : null;
    if (hint) say(hint);
    return 0;
  }

  if (targets.length > 0 && !args.json) say("  every target stages first, and none is visible until all have staged");
  let run: import("../../lifecycle/release-publish").PublishRun;
  try {
    run = await runPublish({ cwd, release, label, targets, ctx: pctx, say: (line) => (args.json ? undefined : say(line)) });
  } catch (err) {
    if (err instanceof PublishRunError) {
      const again = sameWithYes(process.argv.slice(2));
      const where =
        err.step === "stage"
          ? `nothing is visible yet${err.staged.length > 0 ? `; staged: ${err.staged.join(", ")}` : ""}`
          : `revealed: ${err.revealed.length > 0 ? err.revealed.join(", ") : "none"}; staged and not yet revealed: ${err.staged.filter((t) => !err.revealed.includes(t)).join(", ")}`;
      return failed(err.code, `${err.message}; ${where}`, `${err.fix ? `${err.fix} ` : ""}Run the same command again to resume; what went out is not published again: ${again}`);
    }
    const e = errorOf(err);
    return failed(e.code, e.message, e.fix);
  }
  const { published } = run;
  // #5150: the floating tag moves only once every target has revealed; a target that refused with a warning leaves it.
  let floatingWarning: string | null = null;
  if (floating?.move) {
    if (published.some((p) => p.warning)) floatingWarning = `the floating tag ${floating.name} was not moved, since a target refused the release`;
    else floatingWarning = (await import("../../lifecycle/release-publish")).moveFloatingTag(cwd, floating);
  }
  if (floatingWarning) console.error(formatWarning({ message: floatingWarning }));
  if (run.recordWarning && targets.length > 0) console.error(formatWarning({ message: redactor.redact(`${run.recordWarning}. A resume asks the registries what is already there.`) }));
  if (args.json) {
    console.log(redactor.redact(JSON.stringify({ dryRun: false, ...base, targets: planned, published, resumed: run.resumed, environments: deploySteps, ...(floating ? { floatingMoved: floating.move && floatingWarning === null } : {}) }, null, 2)));
    return 0;
  }
  if (targets.length === 0) {
    say("Nothing was published: this member declares no publish target (release.publish in chant.config.ts).");
    const hint = promoteHint();
    if (hint) say(hint);
  } else {
    for (const p of published) for (const i of p.items) say(`  ${i.refused ? "refused" : i.present ? "already there" : "published"}: ${describeItem(i)}`);
    const refused = published.filter((p) => p.warning);
    console.error(formatSuccess(`Published ${name} to ${published.length - refused.length} target(s)${refused.length > 0 ? `; ${refused.length} refused it, with a warning` : ""}`));
  }
  if (floating && !floatingWarning) say(floatingLine(floating, true));
  return 0;
}

/** One item a target publishes, for a line: what, where, and the SBOM or attachment it is (#4049). */
function describeItem(i: import("../../lifecycle/release-publish").PublishItem): string {
  const what =
    i.attachment === "sbom"
      ? `${i.name} (SBOM)`
      : i.attachment === "provenance"
        ? `${i.name} (provenance)`
        : i.attachment === "signature"
          ? `${i.name} (Sigstore signature)`
          : i.attachment === "attestation"
            ? `${i.name} (SLSA provenance, Sigstore)`
            : i.name;
  if (i.notes !== undefined) return `${i.name} to ${i.destination}:\n${i.notes.trimEnd().split("\n").map((l) => `      ${l}`.trimEnd()).join("\n")}`;
  return `${what} to ${i.destination}${i.sbom ? `, carrying ${i.sbom}` : ""}`;
}

/**
 * `release verify <label|digest> [--json]` (#4049): check, offline, that the
 * release was signed by a key `.chant/allowed_signers` lists at the release's
 * commit, and that its file is the digest of what it holds. Exits 0 when it
 * verifies and 1 when it does not or can't be checked.
 */
export async function runReleaseVerify(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const ref = args.extraPositional;
  if (!ref) {
    console.error(formatError({ message: "release verify needs a release", hint: USAGE }));
    return 1;
  }
  const { verifyRelease, verificationCode, verifySigstore, recordedSignatures } = await import("../../lifecycle/release-verify");
  const result = await verifyRelease({ cwd: resolve("."), ref });
  if ("error" in result) {
    if (args.json) console.log(JSON.stringify({ ref, error: result.error }, null, 2));
    else console.error(formatError({ message: `${result.error.message} [${result.error.code}]`, ...(result.error.fix ? { hint: result.error.fix } : {}) }));
    return 1;
  }
  let code: string | null = verificationCode(result);
  // #4657: a package built here that pins an image digest the release does not record fails the check.
  const pins = code ? null : await unknownPackagePins(resolve("."), result.releaseDigest);
  if (pins) {
    code = "release-pin-unknown";
    result.reason = pins;
  }
  // #5164: --sigstore checks the bundles the publish recorded; without it, verify stays offline and says how many there are.
  const sigstore = args.sigstore ? await verifySigstore({ cwd: resolve("."), releaseDigest: result.releaseDigest, ...(args.assets ? { assetsDir: args.assets } : {}) }) : null;
  const recorded = sigstore ? sigstore.checks.length : (await recordedSignatures(resolve("."), result.releaseDigest)).length;
  if (!code && sigstore && sigstore.status !== "verified") {
    code = sigstore.status === "none" ? "release-sigstore-unsigned" : "release-sigstore-unverified";
    result.reason = sigstore.reason;
  }
  if (args.json) {
    console.log(JSON.stringify({ ...result, ...(sigstore ? { sigstore } : { sigstore: { recorded } }), ...(code ? { error: { code, message: result.reason } } : {}) }, null, 2));
    return code ? 1 : 0;
  }
  const name = result.label ? `${formatBold(result.label)} (${result.releaseDigest})` : result.releaseDigest;
  for (const c of result.cuts) {
    console.log(`  cut by ${c.actor} at ${c.timestamp}: ${c.signatureCheck.status}${c.signatureCheck.key ? ` (${c.signatureCheck.key})` : ""}`);
    // #5149: what let the commit be cut.
    console.log(`    ${c.override ? `not green: cut under the override by ${c.override.by}: ${c.override.reason}` : describeGreen(c.green)}`);
  }
  for (const c of sigstore?.checks ?? []) console.log(`  ${c.name} (${c.target}): ${c.status}, ${c.reason}`);
  if (!sigstore && recorded > 0) console.error(`  the publish recorded ${recorded} Sigstore signature(s); check them with: chant release verify ${result.label ?? result.releaseDigest} --sigstore`);
  if (code) {
    console.error(
      formatError({
        message: `${name} does not verify: ${result.reason} [${code}]`,
        hint: code === "release-digest-mismatch"
          ? "Do not publish or deploy it; cut the release again."
          : code === "release-sigstore-unsigned"
            ? "Publish it from CI with release.signing on, or drop --sigstore."
            : code === "release-sigstore-unverified"
              ? "Download the release's assets into a directory and pass it as --assets; install cosign 3 or set CHANT_COSIGN; a bundle that failed was not signed by the identity shown."
              : code === "release-pin-unknown" ? "Build the package from the digests the release records: chant release images <label>, then the build with CHANT_RELEASE_DIGESTS set." : `Cut it again signed with a key ${result.signers.path} lists: chant release cut ${result.label ?? "<label>"} --sign --yes`,
      }),
    );
    return 1;
  }
  console.error(formatSuccess(`Verified ${name}: ${result.reason}${sigstore ? `; ${sigstore.reason}` : ""}`));
  return 0;
}

/** The first package built here that pins an image digest release `digest` does not record (#4657), said in a sentence, or null. */
async function unknownPackagePins(cwd: string, digest: string): Promise<string | null> {
  const { loadChantConfig } = await import("../../config");
  const { readRelease } = await import("../../lifecycle/release-store");
  const { packagePinProblem } = await import("../../lifecycle/release-images");
  const targets = (await loadChantConfig(cwd).catch(() => null))?.config.release?.publish ?? [];
  const release = await readRelease(digest, { cwd });
  return release ? packagePinProblem(cwd, release, targets) : null;
}

/**
 * `release candidates [--env <env>] [--forge-issues] [--json]` (#4168 4.2):
 * the green commits of trunk a release can be cut from, newest first, each
 * with what it would ship since the previous one, and what each environment
 * runs. `--forge-issues` (#4649) asks the forge which issues each pull
 * request closes and groups the changes no work id names by them. `--json`
 * prints the read contract's `release-candidates` document.
 */
export async function runReleaseCandidates(ctx: CommandContext): Promise<number> {
  const { releaseCandidatesDocument } = await import("../../workspace/release-candidates");
  const lane = await laneOf(ctx, resolve("."));
  const doc = await releaseCandidatesDocument({
    cwd: resolve("."),
    ...(ctx.args.env ? { env: ctx.args.env } : {}),
    ...(ctx.args.branch ? { branch: ctx.args.branch } : {}),
    ...(lane !== undefined ? { lane } : {}),
    ...(ctx.args.forgeIssues ? { forgeIssues: {} } : {}),
  });
  if (ctx.args.json) {
    console.log(JSON.stringify(doc, null, 2));
    return "error" in doc ? 1 : 0;
  }
  if ("error" in doc) {
    console.error(formatError({ message: `${doc.error.message} [${doc.error.code}]`, hint: USAGE }));
    return 1;
  }
  for (const e of doc.environments) {
    const runs = e.running.map((r) => `${r.label ?? r.releaseDigest.slice(0, 19)}${r.commit ? ` at ${r.commit.slice(0, 12)}` : ""}`).join(", ");
    console.log(`${e.env}: ${runs || "runs no release yet"}`);
  }
  if (!doc.tip) {
    console.error(`No candidates: this clone knows no ${doc.branch}. Fetch it: git fetch origin ${doc.branch} --tags`);
    return 0;
  }
  const greenIn = doc.lane !== null ? `green in lane ${doc.lane}` : "green";
  if (doc.lane !== null) console.log(`Lane ${doc.lane}: candidates carry ci/green-${doc.lane}/<sha>`);
  if (doc.pending.length > 0) console.log(`${doc.pending.length} commit(s) on ${doc.branch} after the newest candidate are not ${greenIn} yet`);
  if (doc.candidates.length === 0) console.log(`No ${greenIn} commit on ${doc.branch}${doc.since ? ` since ${doc.since.slice(0, 12)}` : ""} to cut from.`);
  for (const c of doc.candidates) {
    const tags = [...(c.newFor.length > 0 ? [`new for ${c.newFor.join(", ")}`] : []), ...(c.cut.length > 0 ? [`cut as ${c.cut.join(", ")}`] : [])];
    console.log(`${c.commit.slice(0, 12)}  ${c.subject}${tags.length > 0 ? `  (${tags.join("; ")})` : ""}`);
    // #4168 4.4: by work item, then pull request, then commit.
    const subjectOf = new Map(c.changes.map((ch) => [ch.commit, ch.subject]));
    for (const g of c.groups) {
      console.log(`    ${g.work !== null ? `work:${g.work}` : g.issue !== null ? `issue #${g.issue}` : "no work item"}`);
      for (const p of g.pullRequests) {
        console.log(`      ${p.pr !== null ? `#${p.pr}` : "no pull request"}`);
        for (const sha of p.commits) console.log(`        ${sha.slice(0, 12)}  ${subjectOf.get(sha) ?? ""}`);
      }
    }
    for (const f of c.flags) console.log(`    flag ${f.id} (${f.member} ${f.param}) changed`);
  }
  for (const sk of doc.skipped) console.log(`skipped ${sk.commit.slice(0, 12)}  ${sk.subject}  (revoked)`);
  // --forge-issues: why a pull request's issues were not read, once per reason.
  const unread = new Set([...doc.candidates.flatMap((c) => c.changes), ...doc.pending].map((ch) => ch.closes?.reason).filter((r): r is string => typeof r === "string"));
  for (const r of unread) console.error(`Issues not read from the forge: ${r}`);
  if (doc.candidates.length > 0) console.error(`Cut one: chant release cut <label> --at <sha>${doc.lane !== null && ctx.args.lane !== undefined ? ` --lane ${doc.lane}` : ""}`);
  return 0;
}

/**
 * `release next [--at <sha>] [--pre <id>] [--json]` (#5159): the label the
 * next release of this member carries, from the conventional commits and
 * the intent files since its previous release. The label alone goes to
 * stdout, so a script can read it; why goes to stderr.
 */
export async function runReleaseNext(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const cwd = resolve(".");
  const rn = await import("../../lifecycle/release-next");
  const { fetchLifecycle } = await import("../../lifecycle/git");
  await fetchLifecycle({ cwd }).catch(() => false);
  let doc: import("../../lifecycle/release-next").NextRelease;
  try {
    doc = await rn.nextRelease({ cwd, ...(args.at ? { at: args.at } : {}), ...(args.pre !== undefined ? { pre: args.pre } : {}) });
  } catch (err) {
    if (!(err instanceof rn.ReleaseNextError)) throw err;
    if (args.json) console.log(JSON.stringify({ error: { code: err.code, message: err.message, ...(err.fix ? { fix: err.fix } : {}) } }, null, 2));
    else console.error(formatError({ message: `${err.message} [${err.code}]`, ...(err.fix ? { hint: err.fix } : {}) }));
    return 1;
  }
  let tag: string | null = null;
  try {
    const t = await import("../../lifecycle/release-tag");
    const tags = await t.memberTags(cwd);
    tag = t.renderReleaseTag(tags.template, tags.place, doc.label);
  } catch {
    tag = null;
  }
  if (args.json) {
    console.log(JSON.stringify({ ...doc, tag }, null, 2));
    return 0;
  }
  console.log(doc.label);
  if (doc.alreadyCut) {
    console.error(`  ${doc.at.slice(0, 12)} is already released as ${doc.label}`);
    return 0;
  }
  const n = doc.commits.length;
  console.error(`  ${doc.bump ?? "the prerelease's version"} from ${doc.from.label} (${doc.from.commit.slice(0, 12)}): ${n} commit${n === 1 ? "" : "s"}${doc.intents.length > 0 ? `, ${doc.intents.length} intent file${doc.intents.length === 1 ? "" : "s"}` : ""}`);
  for (const c of doc.commits.filter((c) => c.bump !== "patch")) console.error(`    ${c.bump}  ${c.sha.slice(0, 7)} ${c.subject}`);
  for (const i of doc.intents) console.error(`    ${i.bump}  ${i.path}`);
  if (tag) console.error(`  tag ${tag}`);
  return 0;
}

/**
 * `release changed [--at <sha>] [--bump-member <member>=<level>]... [--json]`
 * (#5134): the members a release at a commit has to cut, in publish order,
 * each with why. `--json` prints the read contract's `release-changed` document.
 */
export async function runReleaseChanged(ctx: CommandContext): Promise<number> {
  const { releaseChangedDocument } = await import("../../workspace/release-changed");
  const doc = await releaseChangedDocument({
    cwd: resolve("."),
    ...(ctx.args.at ? { at: ctx.args.at } : {}),
    ...(ctx.args.bumpMember ? { bump: ctx.args.bumpMember } : {}),
  });
  if (ctx.args.json) {
    console.log(JSON.stringify(doc, null, 2));
    return "error" in doc ? 1 : 0;
  }
  if ("error" in doc) {
    console.error(formatError({ message: `${doc.error.message} [${doc.error.code}]`, hint: USAGE }));
    return 1;
  }
  if (doc.members.length === 0) {
    console.log(`Nothing to release at ${doc.at.slice(0, 12)}.`);
    return 0;
  }
  for (const m of doc.members) {
    const why = m.reason.member !== null ? `${m.reason.code} ${m.reason.member}` : m.reason.code;
    const label = m.next !== null ? `${m.last?.label ?? "?"} -> ${m.next}` : "no release yet";
    const from = m.next !== null && m.bumpFrom !== "flag" ? `; ${m.bump} from ${m.bumpFrom === "default" ? "no feat or breaking commit" : m.bumpFrom}` : "";
    console.log(`layer ${m.layer}  ${m.member}  ${label}  (${why}${from})`);
  }
  return 0;
}

export async function runReleaseList(ctx: CommandContext): Promise<number> {
  const { releasesDocument } = await import("../../workspace/releases");
  const doc = await releasesDocument({ cwd: resolve(".") });
  if (ctx.args.json) {
    console.log(JSON.stringify(doc, null, 2));
    return "error" in doc ? 1 : 0;
  }
  if ("error" in doc) {
    console.error(formatError({ message: doc.error.message, hint: USAGE }));
    return 1;
  }
  if (doc.reason) console.error(formatWarning({ message: doc.reason.message }));
  if (doc.releases.length === 0) {
    console.error("No releases. Cut one from a green commit: chant release cut <label>");
    return 0;
  }
  for (const r of doc.releases) {
    const where = r.environments.map((e) => e.env).join(", ") || "not deployed from the release";
    // #4031: the newest cut's signature, as the policy at base judges it.
    const newest = r.cuts.at(-1);
    const signature = newest ? (newest.signatureCheck.status === "verified" ? `signed by ${newest.actor}` : newest.signatureCheck.status) : "-";
    // #4033: a release cut from a revoked commit says so at the end of its line, and why on stderr.
    // #4692: a release cut from a lane's green tag names the lane.
    const lane = r.cuts.find((c) => c.lane !== undefined)?.lane;
    const overridden = r.cuts.some((c) => c.override !== undefined);
    console.log(`${(r.label ?? "-").padEnd(16)}  ${r.releaseDigest}  ${r.commit.slice(0, 12)}  ${signature}  ${where}${lane !== undefined ? `  lane ${lane}` : ""}${overridden ? "  not green" : ""}${r.revoked ? "  revoked" : ""}`);
    if (newest?.signatureCheck.status === "unverified") console.error(`  ${r.label ?? r.releaseDigest}: ${newest.signatureCheck.reason}`);
    // #4693: a release cut under an override says the commit was not green.
    for (const c of r.cuts) if (c.override) console.error(`  ${r.label ?? r.releaseDigest}: not green (no ${c.override.tag}), cut under the override by ${c.override.by}: ${c.override.reason}`);
    if (r.revoked) {
      const { describeRevocation } = await import("../../lifecycle/release-revocation");
      console.error(`  ${r.label ?? r.releaseDigest}: revoked by ${r.revoked.tag}, ${describeRevocation(r.revoked)}`);
    }
  }
  return 0;
}

/**
 * `release export <label|digest> --env <env> [-o <dir>]` (#4046): write each
 * file the release's target for <env> records, at the path it was compiled to,
 * under <dir> (the member's directory by default), after checking each one's
 * bytes against its digest. This is how a project with no components deploys
 * a release: its own deploy reads these files instead of building again.
 */
export async function runReleaseExport(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const ref = args.extraPositional;
  if (!ref || !args.env) {
    console.error(formatError({ message: "release export needs a release and an environment", hint: USAGE }));
    return 1;
  }
  const { fetchLifecycle } = await import("../../lifecycle/git");
  const { resolveRelease, readReleaseTemplate } = await import("../../lifecycle/release-store");
  const { targetFor, targetFiles, writePinnedTemplates } = await import("../../components/release-promote");
  await fetchLifecycle().catch(() => false);
  const found = await resolveRelease(ref);
  if (!found) {
    console.error(formatError({ message: `no release is labelled or digested "${ref}" in this member`, hint: "List them with: chant release list" }));
    return 1;
  }
  const target = targetFor(found.release, args.env);
  if ("error" in target) {
    console.error(formatError({ message: target.error }));
    return 1;
  }
  const read = await targetFiles(found.release, target.target, (digest, encoding) => readReleaseTemplate(digest, undefined, encoding));
  if ("errors" in read) {
    for (const e of read.errors) console.error(formatError({ message: e }));
    return 1;
  }
  const dir = resolve(args.output ?? ".");
  writePinnedTemplates(dir, read.files);
  if (args.json) {
    console.log(
      JSON.stringify(
        { releaseDigest: found.release.releaseDigest, label: found.label, env: args.env, dir, templates: target.target.templates, params: target.target.params },
        null,
        2,
      ),
    );
  } else {
    console.error(formatSuccess(`Wrote ${read.files.length} file(s) of ${found.label ? formatBold(found.label) : found.release.releaseDigest} for "${args.env}"`));
    for (const f of read.files) console.log(f.path);
  }
  return 0;
}

/**
 * Internal: compile one environment, or build artifacts, in this process, and
 * write the JSON the cut reads to the file `CHANT_RELEASE_COMPILE_RESULT`
 * names (#4764), or print it when that is unset.
 */
export async function runReleaseCompile(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const env = args.env;
  if (!env) {
    console.error(formatError({ message: "release compile needs --env <env>" }));
    return 1;
  }
  const { compileEnvironment, buildReleaseArtifacts, RELEASE_COMPILE_RESULT_ENV } = await import("../../components/release-compile");
  // Read and cleared before the project loads, so neither a build command nor a project module inherits it.
  const resultFile = process.env[RELEASE_COMPILE_RESULT_ENV];
  delete process.env[RELEASE_COMPILE_RESULT_ENV];
  const params = parseParamFlags(args.param);
  const inputs = compileInputs(ctx, params);
  try {
    let result: unknown;
    if (args.artifacts) {
      const names = (args.component ?? "").split(",").map((n) => n.trim()).filter(Boolean);
      result = { artifacts: await buildReleaseArtifacts(inputs, env, names) };
    } else {
      result = await compileEnvironment(inputs, env);
    }
    if (resultFile) writeFileSync(resultFile, JSON.stringify(result));
    else console.log(JSON.stringify(result));
    return 0;
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }
}

export async function runReleaseUnknown(ctx: CommandContext): Promise<number> {
  console.error(formatError({ message: `Unknown release subcommand: ${ctx.args.path}`, hint: USAGE }));
  return 1;
}

/**
 * `release compose <name> [--base <label|sha>] (--pr <n> | --work <id>)... [--yes] [--json]`
 * (#4168 4.3): pick the chosen trunk changes onto a base, on
 * `chant/compose/<name>` (../../lifecycle/release-compose.ts). A dry run
 * unless `--yes`, which moves the branch and pushes it so CI builds it.
 */
export async function runReleaseCompose(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const name = args.extraPositional;
  if (!name) {
    console.error(formatError({ message: "release compose needs a name for the compose branch", hint: USAGE }));
    return 1;
  }
  const cwd = resolve(".");
  const { composeRelease, ComposeError } = await import("../../lifecycle/release-compose");
  const ws = await import("../../lifecycle/release-workstation");
  const { scopeSource } = await import("../../workspace/write-scope");
  const top = (() => {
    try {
      return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  })();
  if (!top) {
    console.error(formatError({ message: "a compose picks commits, and this directory is not in a git repository [not-a-git-repository]" }));
    return 1;
  }
  const trunk = ws.resolveTrunk(top, scopeSource(cwd).declaration?.ci?.green?.branch ?? null);
  try {
    const r = await composeRelease({
      cwd,
      name,
      ...(args.base !== undefined ? { base: args.base } : {}),
      prs: args.prs ?? [],
      works: args.works ?? [],
      yes: args.yes === true,
      trunk,
    });
    if (args.json) {
      console.log(JSON.stringify({ dryRun: args.yes !== true, ...r, next: r.written || r.pushed ? [`chant release cut <label> --at ${r.tip}`] : [sameWithYes(process.argv.slice(2))] }, null, 2));
      return 0;
    }
    const verb = args.yes === true ? "Composed" : "Dry run: would compose";
    console.log(`${verb} ${formatBold(r.branch)} on ${r.base.slice(0, 12)}${r.from ? `, after ${r.from.slice(0, 12)}` : ""}`);
    for (const s of r.picked) console.log(`  pick ${s.commit.slice(0, 12)}  ${s.subject}  [${s.chosenBy.join(", ")}]`);
    for (const s of r.already) console.log(`  carried already ${s.commit.slice(0, 12)}  ${s.subject}`);
    if (r.picked.length === 0) console.log("  nothing new to pick");
    console.log(`  tip ${r.tip.slice(0, 12)}${r.pushed ? `, pushed to ${trunk.remote}` : ""}`);
    if (args.yes !== true) console.error(`Dry run: no branch was moved or pushed. Run again with --yes: ${sameWithYes(process.argv.slice(2))}`);
    else console.error(`Next: once CI tags ${r.tip.slice(0, 12)} green, cut it: chant release cut <label> --at ${r.tip} --channel <channel>`);
    return 0;
  } catch (err) {
    if (err instanceof ComposeError) {
      if (args.json) console.log(JSON.stringify({ error: { code: err.code, message: err.message, ...(err.conflict ? { conflict: err.conflict } : {}) } }, null, 2));
      console.error(formatError({ message: `${err.message} [${err.code}]`, ...(err.fix ? { hint: err.fix } : {}) }));
      return 1;
    }
    throw err;
  }
}
