/**
 * `chant release workflow` (#4168 step 6): the publish workflow, generated
 * the way `chant ci workflow` writes the tick, where the guides used to have
 * one pasted (guide/release-from-workstation.mdx).
 *
 * The job runs on a `release/**` tag, checks the tag out, fetches the ci tags
 * and `chant/lifecycle`, builds what the targets upload, and runs `chant
 * release publish` for the label the tag names. With `release.tag` (#5150)
 * it runs on the tags the template makes instead, and reads the label from
 * the ledger with `chant release tag`. The security groups decide
 * the rest, and nothing is on without one (#4168 section 8):
 *
 * - `supply-chain` adds `--require-provenance`, so a run with no OIDC token
 *   fails rather than publishing without provenance.
 * - `verified-releases` adds a `chant release verify` step before the publish.
 *
 * The OIDC permission (`id-token: write`, or GitLab's `id_tokens`) is always
 * there: it costs nothing, and with it what the job uploads carries
 * provenance whether or not the group requires it.
 *
 * `release.workflow` in the root's `chant.config.ts` (#4656) renders the
 * rest of the release from the same file. `trigger: "dispatch"` starts it by
 * hand with a label, and four jobs follow: the gate names the commit to cut
 * (`chant ci last-green`, or the dispatched commit itself under `gate:
 * "head"`), the cut runs `chant release cut <label> --at <commit>` and pushes
 * the release's tag, the publish job publishes it, and the post-release job
 * runs `after`. No tag exists until the gate has passed. With
 * `release.images` (#4657) the publish job builds the images again with
 * `chant release images` before the build. A config with only `publish`
 * renders the tag-triggered file it always did.
 *
 * `chant release doctor` (#5161) runs in the cut job before the cut of a
 * dispatched release, unless `doctor: false`, and in the tag-triggered
 * publish job before the build under `doctor: true`.
 *
 * `release.train` at the root (#5154) renders a train instead: the root's
 * members cut together by `chant workspace train cut` and published by
 * `chant workspace train publish` (./release-train-workflow.ts).
 *
 * The cut and publish jobs here are a frame of named slots (#5196). Each
 * feature's steps (doctor, goreleaser, stamp, images, artifacts, builds,
 * verify, signing, QEMU, the targets' setup) come from its own file under
 * ./release-steps, which says which slot of which job they go in; a new
 * feature adds a file there rather than lines in these functions.
 */
import { readFileSync } from "node:fs";
import { ACTION_PINS, tagComments, usesRef } from "../action-pins";
import { TOOL_PINS } from "../tool-pins";
import { placeReleaseImages, releaseImagePlatforms, resolveReleaseImages } from "../lifecycle/release-images";
import { GENERATED_MARKER } from "../discovery/files";
import { tagShape, type MemberTags } from "../lifecycle/release-tag";
import type { SecurityGroup } from "./security";
import type { OpSetupStep } from "../lexicon";
import { buildJobToolchains, checkBuilds, releaseBuildArchive, releaseBuildArtifact, resolveToolchains, toolchainLines, type ReleaseBuildConfig, type ReleaseToolchainDecl } from "./release-toolchains";
import { releaseJobSteps, releaseSetupSteps, type ReleaseStepItem, type ReleaseStepSlot, type ReleaseWorkflowContext, type ReleaseWorkflowShape } from "./release-steps";
import { packLine } from "./release-steps/builds";
import { RELEASE_BINFMT_IMAGE, qemuArchitectures } from "./release-steps/qemu";
import { targetExtras } from "./release-steps/targets";
import { pullLoginEnv } from "./release-steps/pull";
import { goreleaserSetup, setsUpGo } from "./release-steps/goreleaser";
import { renderTrainWorkflow } from "./release-train-workflow";

export const RELEASE_WORKFLOW_FORGES = ["github", "forgejo", "gitlab"] as const;
export type ReleaseWorkflowForge = (typeof RELEASE_WORKFLOW_FORGES)[number];

/** Where each forge's publish workflow is written, relative to the repository root. */
export const RELEASE_WORKFLOW_FILES: Record<ReleaseWorkflowForge, string> = {
  github: ".github/workflows/chant-release.yml",
  forgejo: ".forgejo/workflows/chant-release.yml",
  // GitLab reads one .gitlab-ci.yml, which includes this file: `include: { local: .gitlab/chant-release.yml }`.
  gitlab: ".gitlab/chant-release.yml",
};

/** `release.workflow` in `chant.config.ts` (#4656): how the release pipeline starts and what it runs. */
export interface ReleasePipelineConfig {
  /** `tag` (default): the publish job runs on the tag the cut made (`release.tag`, default `release/**`). `dispatch`: the whole release starts by hand with a label. */
  trigger?: "tag" | "dispatch";
  /** For `dispatch`: the commit to cut. `last-green` (default) is the newest green commit at or below the dispatched one; `head` is the dispatched commit, which must be green. */
  gate?: "last-green" | "head";
  /** The command that installs what the build needs. Default `npm ci` for a project with a package.json, none otherwise. `false` for none. */
  install?: string | false;
  /** The command that builds what the targets upload, run by the cut (as its `--build`) and the publish job. `false` for none. Default `npm run build`. */
  build?: string | false;
  /** What runs chant. Default `npx chant`. */
  chant?: string;
  /** Shell lines run after the publish, with `CHANT_RELEASE_LABEL` set: steps that need a published release. */
  after?: string[];
  /**
   * Scopes added to the workflow's `contents: write` and `id-token: write`
   * (#4751), such as `{ packages: "write" }` for an `oci` target that pushes to
   * GHCR with the run's token. A scope already granted is refused. GitHub and
   * Forgejo only; GitLab has no `permissions:` and refuses it by name.
   */
  permissions?: Record<string, "read" | "write">;
  /**
   * Variables for the cut and publish jobs (#4751), such as an `oci` target's
   * `OCI_USERNAME: "${{ github.actor }}"` and `OCI_PASSWORD: "${{ github.token }}"`.
   * A value may be a forge expression: it goes in the job's `env:` (GitLab:
   * `variables:`), never on a `run:` line.
   */
  env?: Record<string, string>;
  /**
   * Steps the cut and publish jobs run after the install (#4751): `{ run }`,
   * or `{ uses, with }` on GitHub and Forgejo, such as a newer npm. GitLab
   * takes `run` steps as script lines and refuses `uses` by name. QEMU for
   * the platforms `release.images` builds is set up without one (#4876).
   */
  setup?: OpSetupStep[];
  /**
   * The toolchains the jobs set up (#5152): `node`, `go`, `python`, `rust`,
   * `java`, each by name or as `{ name, version }`. Default: those the
   * project's root files name (`package.json`, `go.mod`, `pyproject.toml`,
   * `Cargo.toml`, `pom.xml`, ...). Jobs that run chant get Node as well.
   * `false` sets up nothing; the runner brings its own. GitHub and Forgejo;
   * GitLab jobs take theirs from the runner's image and refuse it by name.
   */
  toolchains?: ReleaseToolchainDecl[] | false;
  /**
   * Per-platform build jobs (#5152), each on its own runner (a native arm64
   * runner, macOS, Windows), run after the gate and before the cut. Each
   * hands its `outputs` to the cut and publish jobs, where they land at the
   * same paths in the checkout before `chant release cut` runs. `dispatch`
   * only: with the tag trigger the release was cut before the workflow ran.
   * In a train (#5237) each member declares its own, in its directory, and
   * the root's train workflow runs them with the label the gate plans for
   * that member; the root itself declares none.
   */
  builds?: ReleaseBuildConfig[];
  /** Where the workflow is written, from the repository root, such as `.github/workflows/publish.yml` for an npm trusted publisher that names that file. Default {@link RELEASE_WORKFLOW_FILES}. */
  file?: string;
  /**
   * Run `chant release doctor` before anything is published (#5161). With
   * `trigger: "dispatch"` the cut job runs it before the cut, so a target
   * that can't publish stops the release before a tag exists; on by default
   * there, `false` turns it off. With `trigger: "tag"` the cut already
   * happened, and `true` runs it in the publish job before the build.
   */
  doctor?: boolean;
}

export interface ReleaseWorkflowInput {
  forge: ReleaseWorkflowForge;
  /** The security groups the workspace opts into at its root. */
  groups: ReadonlySet<SecurityGroup>;
  /** The command that installs what the build needs, or none. Default `npm ci`. */
  install?: string | null;
  /**
   * The toolchain files at the project's root (#5152), from
   * `TOOLCHAIN_MARKERS`: what the jobs set up when `release.workflow.toolchains`
   * names none. Absent, the jobs set up Node alone, as they always did.
   */
  projectFiles?: readonly string[];
  /** The command that builds what the targets upload, or none. Default `npm run build`. */
  build?: string | null;
  /** What runs chant. Default `npx chant`. */
  chant?: string;
  /** The workspace root relative to the repository root, `.` at the top. */
  workspaceRoot?: string;
  /** `release.workflow` (#4656). A flag above wins over the field it names. */
  pipeline?: ReleasePipelineConfig;
  /** The config declares `release.images` (#4657): the publish job builds them again first. */
  images?: boolean;
  /**
   * The archives `release.images` names, from the workspace root. In a
   * dispatched release the cut job hands them to the publish job, which
   * checks them against the recorded digests (`release images --no-build`)
   * rather than building them again, so a moved package mirror between the
   * two jobs cannot change what is published.
   */
  imageArchives?: string[];
  /**
   * The platforms `release.images` builds (#4876). Those the runner can't run
   * ({@link RELEASE_RUNNER_PLATFORM}) get QEMU's binfmt handlers in the cut
   * and publish jobs, before `release.workflow.setup`.
   */
  imagePlatforms?: string[];
  /**
   * The registries `release.images` pulls its bases from that need a login
   * (#5457), at the root or in a train's members: the cut and publish jobs
   * log docker in to each before they build ({@link pullLoginSetup}).
   */
  pullRegistries?: import("../lifecycle/release-images").ReleaseImagePull[];
  /** `release.lane` (#4692): the gate's green lane. */
  lane?: string;
  /**
   * The config declares `release.artifacts` (#5151). In a dispatched release
   * the cut job stages the files it built (`chant release artifacts --no-build
   * -o`) and hands them to the publish job as the workflow artifact
   * {@link RELEASE_ARTIFACTS_ARTIFACT}, which checks them against the record
   * (`--from`) before the publish. On a release tag the publish job builds
   * them again and checks them.
   */
  artifacts?: boolean;
  /**
   * An entry of `release.artifacts` is built by goreleaser (#5151): the job
   * that builds the files installs the goreleaser {@link TOOL_PINS} pins,
   * checked by SHA-256, and on GitHub and Forgejo sets up Go from the
   * member's `go.mod`.
   */
  goreleaser?: boolean;
  /**
   * An entry of `release.artifacts` is packaged by nfpm (#5233): the job that
   * builds the files installs the nfpm {@link TOOL_PINS} pin, checked by
   * SHA-256, and names it in `CHANT_NFPM`.
   */
  nfpm?: boolean;
  /**
   * The green gate the cut checks (#5149), `release.green` resolved. Under
   * `forge-checks` or `none` a dispatched release's gate names the
   * dispatched commit, since no `ci/green` tag exists to search, and the cut
   * checks it; under `forge-checks` the cut job gets the run's token and,
   * on GitHub, `checks: read` and `statuses: read`. Default `chant`.
   */
  green?: import("../lifecycle/release-green").ReleaseGreenSource;
  /**
   * `release.tag` (#5150) and where it renders. A tag-triggered workflow runs
   * on the tags it makes, and its publish job reads the label of the tag that
   * started it from the ledger (`chant release tag`). Absent, or the legacy
   * default: the `release/**` file it always was.
   */
  tags?: MemberTags;
  /**
   * The publish signs with Sigstore (#5164): `release.signing` or the
   * `supply-chain` group, with an `oci` or `forge` target. The jobs download
   * cosign pinned by SHA-256 ({@link cosignSetup}).
   */
  signing?: boolean;
  /**
   * The variables the signing step alone gets (#5458): a `release.signing.key`
   * held in a variable and its password. On GitHub and Forgejo the step that
   * runs `chant release publish` reads each from the repository's secret of
   * the same name ({@link signingStepEnv}); GitLab hands CI/CD variables to
   * every job, so its file names none.
   */
  signingEnv?: string[];
  /**
   * The publish scans what it would put out before the stage (#5446):
   * `release.scan` or the `supply-chain` group, with an `oci`, `forge` or
   * `npm` target. The jobs download grype and syft pinned by SHA-256
   * ({@link scanSetup}).
   */
  scan?: boolean;
  /**
   * The config declares `release.version` (#4840): the publish job runs
   * `chant release stamp <label>` before the images and the build, so what
   * it builds and publishes carries the label as its version. The cut
   * stamps on its own.
   */
  version?: boolean;
  /**
   * `release.publish` (#4767). On GitHub, a `forge: "github"` target with no
   * `tokenEnv` reads `GITHUB_TOKEN`, so the publish job sets it to the job's
   * token unless `release.workflow.env` sets it.
   */
  publish?: ReadonlyArray<ReleaseWorkflowTarget>;
  /**
   * `release.train` at the workspace root (#5154): the workflow releases the
   * root's members as a train, recorded for `env`, rather than the root as
   * one member. See ./release-train-workflow.ts.
   */
  train?: {
    env: string;
    /**
     * What the members declare (#5216): `release.images` (with the platforms
     * they build, for QEMU), `release.artifacts`, and an artifact goreleaser
     * builds. The jobs hand them from the cut to the publish.
     */
    imagePlatforms?: string[];
    images?: boolean;
    artifacts?: boolean;
    goreleaser?: boolean;
    /** The directory, from the workspace root, of the member whose goreleaser build Go is set up for: its `go.mod` names the Go. */
    goreleaserDir?: string;
    /**
     * The members' `release.workflow.builds` (#5237): each a per-platform
     * build job of the member at `dir` (from the workspace root), run with
     * the label the gate's plan gives that member. `files` are the toolchain
     * marker files in the member's directory, which a build with no
     * `toolchains` sets up from.
     */
    builds?: Array<{ member: string; dir: string; files?: string[]; build: ReleaseBuildConfig }>;
  };
}

/** What the generator reads of a `release.publish` target: enough to know which credentials and tools its job needs. */
export interface ReleaseWorkflowTarget {
  type: string;
  forge?: string;
  tokenEnv?: string;
  /** An `oci` target's `<registry host>/<name>`. */
  repository?: string;
  usernameEnv?: string;
  passwordEnv?: string;
  /** An `npm` target's registry. */
  registry?: string;
  /** A `pypi` target's `auth`, `index` and `uploadUrl`. */
  auth?: string;
  /** A `pypi` target's index name, or a `helm` target's chart repository (#5233). */
  index?: string | { repo: string };
  uploadUrl?: string;
  /** A `helm` target's registry (#5233). */
  oci?: { repository: string; usernameEnv?: string; passwordEnv?: string };
  /** A `nuget` target's `pushUrl` (#5232). */
  pushUrl?: string;
}

// #5196: each feature's helpers and constants live with its steps in ./release-steps; these keep their names here.
export { RELEASE_RUNNER_PLATFORM } from "./release-steps/types";
export { NPM_TRUSTED_PUBLISHING_MIN, NPM_TRUSTED_PUBLISHING_SETUP, NPM_TRUSTED_PUBLISHING_VERSION, targetExtras } from "./release-steps/targets";
export { RELEASE_BINFMT_IMAGE, qemuArchitectures, qemuSetup } from "./release-steps/qemu";
export { RELEASE_ARTIFACTS_ARTIFACT, RELEASE_ARTIFACTS_STAGE } from "./release-steps/artifacts";
export { goreleaserSetup } from "./release-steps/goreleaser";
export { cosignSetup, signingStepEnv } from "./release-steps/signing";
export { scanSetup } from "./release-steps/scan";
export { pullLoginEnv, pullLoginLine, pullLoginSetup } from "./release-steps/pull";
export { RELEASE_DIGESTS_FILE, RELEASE_DIGESTS_PATHS, RELEASE_IMAGES_ARTIFACT } from "./release-steps/images";

/** The flags `chant release publish` gets under the groups. */
export function publishFlags(groups: ReadonlySet<SecurityGroup>): string[] {
  return [...(groups.has("supply-chain") ? ["--require-provenance"] : []), "--yes"];
}

/** A string as a single-quoted shell word. */
function sq(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/** The workflow file's text, without the generated-by header. */
export function renderReleaseWorkflow(input: ReleaseWorkflowInput): string {
  const p = input.pipeline ?? {};
  const chant = input.chant ?? p.chant ?? "npx chant";
  const install = input.install !== undefined ? input.install : p.install === false ? null : (p.install ?? "npm ci");
  const build = input.build !== undefined ? input.build : p.build === false ? null : (p.build ?? "npm run build");
  const root = input.workspaceRoot && input.workspaceRoot !== "." ? input.workspaceRoot : null;
  const flags = publishFlags(input.groups).join(" ");
  const after = p.after ?? [];
  const images = input.images === true;
  // #5152: the toolchains each job sets up, and the per-platform builds.
  const files = new Set(input.projectFiles ?? (p.toolchains === undefined ? ["package.json"] : []));
  if (input.forge === "gitlab" && p.toolchains && p.toolchains.some((t) => (typeof t === "string" ? t : t.name) !== "node")) {
    throw new Error("release.workflow.toolchains: a GitLab job runs in its runner's image, which brings the toolchain; name the image in .gitlab-ci.yml (default: image:) and leave toolchains out");
  }
  const chantSetup = toolchainLines(resolveToolchains(p.toolchains === false ? false : (p.toolchains ?? []).filter((t) => (typeof t === "string" ? t : t.name) === "node"), new Set(), root, p.toolchains !== false));
  const fullSetup = toolchainLines(buildJobToolchains(p.toolchains, input.projectFiles, root));
  const builds = p.builds ?? [];
  if (builds.length > 0) {
    if (p.trigger !== "dispatch") throw new Error('release.workflow.builds: the tag trigger publishes a release cut before the workflow ran, so nothing built here would be in it; use trigger: "dispatch"');
    checkBuilds(builds);
  }
  // #4786: the targets' own needs first, then the config's, so a config that set them by hand renders the same file without them.
  const derived = targetExtras(input.forge, input.publish ?? [], p);
  // #5457: the pull logins' credentials, from the repository's secrets, in the cut and publish jobs.
  const pullEnv = pullLoginEnv(input.forge, p, input.pullRegistries ?? []);
  if (Object.keys(pullEnv).length > 0) derived.env = { ...derived.env, ...pullEnv };
  // #5149: the cut asks the forge for the commit's checks with the run's token.
  const green = input.green ?? "chant";
  if (green === "forge-checks" && p.trigger === "dispatch" && input.forge === "github") {
    const reads = Object.fromEntries((["checks", "statuses"] as const).filter((k) => p.permissions?.[k] === undefined).map((k) => [k, "read" as const]));
    if (Object.keys(reads).length > 0) derived.permissions = { ...derived.permissions, ...reads };
  }
  const shape: ReleaseWorkflowShape = p.trigger === "dispatch" ? "dispatch" : input.tags && !input.tags.template.legacy ? "templated" : "tag";
  // #5196: what each feature reads; ./release-steps decides where its steps go.
  const context: ReleaseWorkflowContext = {
    forge: input.forge,
    shape,
    input,
    pipeline: p,
    chant,
    root,
    verify: input.groups.has("verified-releases"),
    images,
    archives: shape === "dispatch" && images ? (input.imageArchives ?? []).map((a) => (root ? `${root}/${a.replace(/^\.\//, "")}` : a.replace(/^\.\//, ""))) : [],
    artifacts: input.artifacts === true,
    version: input.version === true,
    doctor: shape === "dispatch" ? p.doctor !== false : p.doctor === true,
    signing: input.signing === true,
    signingEnv: input.signingEnv ?? [],
    scan: input.scan === true,
    green,
    builds,
    ...(input.tags ? { tags: input.tags } : {}),
  };
  const extra = jobExtras(
    {
      ...p,
      ...(derived.permissions ? { permissions: { ...p.permissions, ...derived.permissions } } : {}),
      ...(derived.env ? { env: { ...p.env, ...derived.env } } : {}),
      setup: releaseSetupSteps(context),
    },
    input.forge,
  );
  // #4767: Forgejo's job token is not a GitHub token, and GitLab has no such expression.
  const forgeToken =
    input.forge === "github" && p.env?.GITHUB_TOKEN === undefined && (input.publish ?? []).some((t) => t.type === "forge" && t.forge === "github" && !t.tokenEnv)
      ? ["      GITHUB_TOKEN: ${{ github.token }}"]
      : [];
  // #5154: the root's members released as a train.
  if (input.train) {
    if (builds.length > 0) throw new Error("release.workflow.builds at the root: a train releases its members, not the root; declare each build in the release.workflow.builds of the member whose files it builds");
    if (images || input.artifacts) throw new Error("release.images and release.artifacts at the root: a train releases its members, not the root; declare them in the member that publishes them");
    const t = input.train;
    // #5237: the members' per-platform builds, each run with the label the gate's plan gives its member.
    const memberBuilds = t.builds ?? [];
    if (memberBuilds.length > 0) {
      if (p.trigger !== "dispatch") throw new Error('release.workflow.builds in a member: the tag trigger publishes a train cut before the workflow ran, so nothing built here would be in it; use trigger: "dispatch"');
      try {
        checkBuilds(memberBuilds.map((b) => b.build));
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : String(err)} (a train runs every member's builds in one workflow, so each job name is used once across the members)`);
      }
      if (input.forge === "gitlab" && memberBuilds.some((b) => b.build.toolchains && b.build.toolchains.length > 0)) throw new Error("release.workflow.builds: toolchains: a GitLab job runs in its runner's image, which brings the toolchain; leave toolchains out");
    }
    const trainBuilds = memberBuilds.map((b) => {
      const dir = [root, b.dir].filter((d): d is string => !!d && d !== ".").join("/") || ".";
      // The toolchains the build names, else those the member's files name, else the root's.
      const own = (b.files ?? []).length > 0;
      const setup = toolchainLines(resolveToolchains(b.build.toolchains !== undefined ? b.build.toolchains : p.toolchains === false ? false : own ? undefined : p.toolchains, own ? new Set(b.files) : files, own ? (dir === "." ? null : dir) : root, false));
      return { ...b.build, member: b.member, memberDir: b.dir, path: dir, setup };
    });
    const trainContext: ReleaseWorkflowContext = { forge: input.forge, shape: "dispatch", input: { ...input, imagePlatforms: t.imagePlatforms ?? [] }, pipeline: p, chant, root, verify: false, images: t.images === true, archives: [], artifacts: false, version: false, doctor: false, signing: input.signing === true, signingEnv: input.signingEnv ?? [], scan: input.scan === true, green, builds: [] };
    return renderTrainWorkflow({
      forge: input.forge,
      env: input.train.env,
      trigger: p.trigger === "dispatch" ? "dispatch" : "tag",
      chant,
      install,
      build,
      root,
      flags,
      after,
      chantSetup,
      fullSetup,
      extra: jobExtras({ ...p, ...(derived.permissions ? { permissions: { ...p.permissions, ...derived.permissions } } : {}), ...(derived.env ? { env: { ...p.env, ...derived.env } } : {}), setup: releaseSetupSteps(trainContext) }, input.forge),
      forgeToken,
      cutToken: green === "forge-checks" && p.env?.GITHUB_TOKEN === undefined ? ["      GITHUB_TOKEN: ${{ github.token }}"] : [],
      green,
      gate: p.gate ?? "last-green",
      ...(input.lane ? { lane: input.lane } : {}),
      // #5216: the members' images and files, from the cut to the publish; the doctor before the cut; verify before the publish.
      files: t.images === true || t.artifacts === true,
      ...(t.artifacts && t.goreleaser ? { goreleaser: ((g) => (input.forge === "gitlab" ? g.gitlab : g.github))(goreleaserSetup(input.forge, [root, t.goreleaserDir].filter((d): d is string => !!d && d !== ".").join("/") || null, p, setsUpGo(p, input.projectFiles, root))) } : {}),
      ...(input.signing ? { signing: true } : {}),
      ...(input.forge === "gitlab" ? { idTokens: stepLines(releaseJobSteps({ ...trainContext, job: "publish", label: '"$CHANT_RELEASE_TRAIN"' })("idTokens"), (l) => l) } : {}),
      // #5458: the signing step's own variables.
      publishEnv: publishStepEnv(releaseJobSteps({ ...trainContext, job: "publish", label: '"$CHANT_RELEASE_TRAIN"' })("publishEnv")),
      doctor: p.trigger === "dispatch" && p.doctor !== false,
      verify: input.groups.has("verified-releases"),
      ...(trainBuilds.length > 0 ? { builds: trainBuilds } : {}),
    });
  }
  if (shape === "dispatch") {
    const cutToken = green === "forge-checks" && input.forge !== "gitlab" && p.env?.GITHUB_TOKEN === undefined ? ["      GITHUB_TOKEN: ${{ github.token }}"] : [];
    const buildJobs = builds.map((b) => ({ ...b, setup: toolchainLines(resolveToolchains(b.toolchains !== undefined ? b.toolchains : p.toolchains, files, root, false)) }));
    if (input.forge === "gitlab" && builds.some((b) => b.toolchains && b.toolchains.length > 0)) throw new Error("release.workflow.builds: toolchains: a GitLab job runs in its runner's image, which brings the toolchain; leave toolchains out");
    const o = { context, chant, install, chantSetup, fullSetup, builds: buildJobs, build, root, flags, after, forge: input.forge, extra, forgeToken, cutToken, green, doctor: context.doctor, gate: p.gate ?? "last-green", ...(input.lane ? { lane: input.lane } : {}) };
    return input.forge === "gitlab" ? renderGitlabDispatch(o) : renderGithubDispatch(o);
  }
  // #5150: a release.tag template triggers on its own tags.
  if (shape === "templated") {
    return renderTemplatedTagWorkflow(input, { context, chant, install, fullSetup, build, root, flags, after, extra, forgeToken, tags: input.tags! });
  }
  // #4657: steps that read the release (the images, the artifacts) fetch the ci tags and chant/lifecycle before them, and the build runs after.
  if (input.forge === "gitlab") {
    const label = '"${CI_COMMIT_TAG#release/}"';
    const fetches = ["    - git fetch origin 'refs/tags/ci/*:refs/tags/ci/*'", "    - git fetch origin chant/lifecycle:chant/lifecycle"];
    const at = releaseJobSteps({ ...context, job: "publish", label });
    const step = (slot: ReleaseStepSlot) => stepLines(at(slot), (l) => `    - ${l}`);
    const beforeBuild = step("beforeBuild");
    const lines = [
      "chant-release-publish:",
      "  rules:",
      "    - if: $CI_COMMIT_TAG =~ /^release\\//",
      ...publishIdTokens(at("idTokens")),
      ...(extra.gitlabVariables.length > 0 ? ["  variables:", ...extra.gitlabVariables] : []),
      "  script:",
      ...(root ? [`    - cd ${root}`] : []),
      ...(install ? [`    - ${install}`] : []),
      ...extra.gitlabScript.map((l) => `    - ${l}`),
      ...step("prepare"),
      ...(beforeBuild.length > 0 ? fetches : []),
      ...beforeBuild,
      ...(build ? [`    - ${build}`] : []),
      ...(beforeBuild.length > 0 ? [] : fetches),
      ...step("afterBuild"),
      ...step("beforePublish"),
      `    - ${chant} release publish ${label} ${flags}`,
    ];
    if (after.length > 0) {
      lines.push(
        "",
        "chant-release-after:",
        "  rules:",
        "    - if: $CI_COMMIT_TAG =~ /^release\\//",
        "  needs: [chant-release-publish]",
        "  script:",
        '    - export CHANT_RELEASE_LABEL="${CI_COMMIT_TAG#release/}"',
        ...(root ? [`    - cd ${root}`] : []),
        ...(install ? [`    - ${install}`] : []),
        ...after.map((l) => `    - ${l}`),
      );
    }
    return `${lines.join("\n")}\n`;
  }
  const label = '"${GITHUB_REF_NAME#release/}"';
  const fetches = ["      - run: git fetch origin 'refs/tags/ci/*:refs/tags/ci/*'", "      - run: git fetch origin chant/lifecycle:chant/lifecycle"];
  const at = releaseJobSteps({ ...context, job: "publish", label });
  const step = (slot: ReleaseStepSlot) => stepLines(at(slot), (l) => `      - run: ${l}`);
  const beforeBuild = step("beforeBuild");
  const lines = [
    "name: chant release publish",
    "on:",
    "  push:",
    '    tags: ["release/**"]',
    "permissions:",
    "  contents: read",
    "jobs:",
    "  publish:",
    "    runs-on: ubuntu-latest",
    ...jobPermissions(extra, { contents: "write", "id-token": "write" }, "publish"),
    ...(root ? ["    defaults:", "      run:", `        working-directory: ${root}`] : []),
    ...extra.githubEnv(forgeToken),
    "    steps:",
    ...githubSetup(undefined, fullSetup),
    ...(install ? [`      - run: ${install}`] : []),
    ...extra.githubSteps,
    ...step("prepare"),
    ...(beforeBuild.length > 0 ? fetches : []),
    ...beforeBuild,
    ...(build ? [`      - run: ${build}`] : []),
    ...(beforeBuild.length > 0 ? [] : fetches),
    ...step("afterBuild"),
    ...step("beforePublish"),
    `      - run: ${chant} release publish ${label} ${flags}`,
    ...publishStepEnv(at("publishEnv")),
  ];
  if (after.length > 0) {
    lines.push(
      "  after-release:",
      "    needs: publish",
      "    runs-on: ubuntu-latest",
      ...jobPermissions(extra, { contents: "read" }, "after"),
      ...(root ? ["    defaults:", "      run:", `        working-directory: ${root}`] : []),
      "    steps:",
      ...githubSetup(undefined, fullSetup),
      '      - run: echo "CHANT_RELEASE_LABEL=${GITHUB_REF_NAME#release/}" >> "$GITHUB_ENV"',
      ...(install ? [`      - run: ${install}`] : []),
      ...after.map((l) => `      - run: ${l}`),
    );
  }
  return tagComments(`${lines.join("\n")}\n`);
}

/** A job's steps as lines: each shell line as the job writes one, and each feature's own lines as they are. */
function stepLines(items: readonly ReleaseStepItem[], run: (line: string) => string): string[] {
  return items.flatMap((i) => (typeof i === "string" ? [run(i)] : i.lines));
}

/** The `env:` of the step that runs the publish, from the `publishEnv` slot (#5458): nothing when it is empty. */
export function publishStepEnv(items: readonly ReleaseStepItem[]): string[] {
  const entries = stepLines(items, (l) => `          ${l}`);
  return entries.length > 0 ? ["        env:", ...entries] : [];
}

/** A GitLab publish job's `id_tokens:`: `SIGSTORE_ID_TOKEN`, and the entries the features add. */
function publishIdTokens(extra: readonly ReleaseStepItem[]): string[] {
  return ["  id_tokens:", "    SIGSTORE_ID_TOKEN:", "      aud: sigstore", ...stepLines(extra, (l) => l)];
}

/** A glob character GitHub's and Forgejo's tag filters treat as special, escaped. */
function globLiteral(s: string): string {
  return s.replace(/[*?+[\]!\\]/g, (c) => `\\${c}`);
}

/** A literal for a GitLab (RE2) regex between slashes. */
function regexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, (c) => `\\${c}`);
}

/**
 * The filters for the tags a template makes (#5150): GitHub and Forgejo
 * globs (the release tags, and a negated pattern for the floating tag so its
 * move starts nothing), and GitLab's rule.
 */
export function releaseTagFilters(tags: MemberTags): { globs: string[]; gitlabRule: string } {
  const name = tagShape(tags.template.name, tags.place);
  const floating = tags.template.floating ? tagShape(tags.template.floating, tags.place) : null;
  const globs = [`${globLiteral(name.prefix)}*${globLiteral(name.suffix)}`, ...(floating ? [`!${globLiteral(floating.prefix)}[0-9]+${globLiteral(floating.suffix)}`] : [])];
  const re = (s: { prefix: string; suffix: string }, v: string) => `/^${regexLiteral(s.prefix)}${v}${regexLiteral(s.suffix)}$/`;
  const gitlabRule = `$CI_COMMIT_TAG =~ ${re(name, "[A-Za-z0-9._+-]+")}${floating ? ` && $CI_COMMIT_TAG !~ ${re(floating, "[0-9]+")}` : ""}`;
  return { globs, gitlabRule };
}

/** The shell that reads the label of the tag `ref` names from the ledger and refuses a tag that names no release. */
function labelOfRefScript(chant: string, ref: string): string[] {
  return [
    `label="$(${chant} release tag "${ref}" --json | ${field("d.label")})" || label=""`,
    `if [ -z "$label" ]; then echo "${ref} names no release of this member, so nothing is published" >&2; exit 1; fi`,
  ];
}

interface TemplatedInput {
  context: ReleaseWorkflowContext;
  chant: string;
  install: string | null;
  /** The toolchain steps of the publish and after-release jobs (#5152). */
  fullSetup: string[];
  build: string | null;
  root: string | null;
  flags: string;
  after: string[];
  extra: JobExtras;
  forgeToken: string[];
  tags: MemberTags;
}

/**
 * The tag-triggered publish workflow for a `release.tag` template (#5150).
 * It runs on the template's tags, fetches `chant/lifecycle` first, and
 * reads the release's label from the ledger with `chant release tag`, since
 * a tag is the label's rendering and is never parsed.
 */
function renderTemplatedTagWorkflow(input: ReleaseWorkflowInput, o: TemplatedInput): string {
  const { chant, install, fullSetup, build, root, flags, after, extra, forgeToken } = o;
  const filters = releaseTagFilters(o.tags);
  const label = '"$CHANT_RELEASE_LABEL"';
  const ciFetch = "git fetch origin 'refs/tags/ci/*:refs/tags/ci/*'";
  const ledgerFetch = "git fetch origin chant/lifecycle:chant/lifecycle";
  const at = releaseJobSteps({ ...o.context, job: "publish", label });
  if (input.forge === "gitlab") {
    const q = (l: string) => `    - ${JSON.stringify(l)}`;
    const step = (slot: ReleaseStepSlot) => stepLines(at(slot), q);
    const beforeBuild = step("beforeBuild");
    const labelLines = [ledgerFetch, ...labelOfRefScript(chant, "$CI_COMMIT_TAG"), 'export CHANT_RELEASE_LABEL="$label"'];
    const lines = [
      "chant-release-publish:",
      "  rules:",
      `    - if: ${filters.gitlabRule}`,
      ...publishIdTokens(at("idTokens")),
      ...(extra.gitlabVariables.length > 0 ? ["  variables:", ...extra.gitlabVariables] : []),
      "  script:",
      ...(root ? [q(`cd ${root}`)] : []),
      ...(install ? [q(install)] : []),
      ...extra.gitlabScript.map(q),
      ...labelLines.map(q),
      ...step("prepare"),
      ...(beforeBuild.length > 0 ? [q(ciFetch)] : []),
      ...beforeBuild,
      ...(build ? [q(build)] : []),
      ...(beforeBuild.length > 0 ? [] : [q(ciFetch)]),
      ...step("afterBuild"),
      ...step("beforePublish"),
      q(`${chant} release publish ${label} ${flags}`),
    ];
    if (after.length > 0) {
      lines.push("", "chant-release-after:", "  rules:", `    - if: ${filters.gitlabRule}`, "  needs: [chant-release-publish]", "  script:", ...(root ? [q(`cd ${root}`)] : []), ...(install ? [q(install)] : []), ...labelLines.map(q), ...after.map((l) => `    - ${l}`));
    }
    return `${lines.join("\n")}\n`;
  }
  const run = (l: string) => `      - run: ${l}`;
  const step = (slot: ReleaseStepSlot) => stepLines(at(slot), run);
  const beforeBuild = step("beforeBuild");
  const lines = [
    "name: chant release publish",
    "on:",
    "  push:",
    `    tags: [${filters.globs.map((g) => JSON.stringify(g)).join(", ")}]`,
    "permissions:",
    "  contents: read",
    "jobs:",
    "  publish:",
    "    runs-on: ubuntu-latest",
    ...jobPermissions(extra, { contents: "write", "id-token": "write" }, "publish"),
    ...(root ? ["    defaults:", "      run:", `        working-directory: ${root}`] : []),
    ...(after.length > 0 ? ["    outputs:", "      label: ${{ steps.label.outputs.label }}"] : []),
    ...extra.githubEnv(forgeToken),
    "    steps:",
    ...githubSetup(undefined, fullSetup),
    ...(install ? [run(install)] : []),
    ...extra.githubSteps,
    run(ledgerFetch),
    "      - id: label",
    "        run: |",
    ...[...labelOfRefScript(chant, "$GITHUB_REF_NAME"), 'echo "CHANT_RELEASE_LABEL=$label" >> "$GITHUB_ENV"', 'echo "label=$label" >> "$GITHUB_OUTPUT"'].map((l) => `          ${l}`),
    ...step("prepare"),
    ...(beforeBuild.length > 0 ? [run(ciFetch)] : []),
    ...beforeBuild,
    ...(build ? [run(build)] : []),
    ...(beforeBuild.length > 0 ? [] : [run(ciFetch)]),
    ...step("afterBuild"),
    ...step("beforePublish"),
    run(`${chant} release publish ${label} ${flags}`),
    ...publishStepEnv(at("publishEnv")),
  ];
  if (after.length > 0) {
    lines.push(
      "  after-release:",
      "    needs: publish",
      "    runs-on: ubuntu-latest",
      ...jobPermissions(extra, { contents: "read" }, "after"),
      ...(root ? ["    defaults:", "      run:", `        working-directory: ${root}`] : []),
      "    env:",
      "      CHANT_RELEASE_LABEL: ${{ needs.publish.outputs.label }}",
      "    steps:",
      ...githubSetup(undefined, fullSetup),
      ...(install ? [run(install)] : []),
      ...after.map(run),
    );
  }
  return tagComments(`${lines.join("\n")}\n`);
}

export interface JobExtras {
  /** The scopes the config and the targets add, which the jobs that need them take (#5234). */
  permissions: Array<[string, string]>;
  /** The job's `env:` block with `base` entries first, or nothing when there is neither. */
  githubEnv: (base: string[]) => string[];
  /** Steps after the install. */
  githubSteps: string[];
  /** GitLab: the job's `variables:` entries, under a `variables:` key of their own. */
  gitlabVariables: string[];
  /** GitLab: script lines after the install. */
  gitlabScript: string[];
}

/**
 * A job's `permissions:` block (#5234): the scopes it needs, then the config's
 * and targets' extras it takes, one per line at the job's indent. The workflow
 * itself grants `contents: read`, so no job holds a scope it does not name.
 * The cut never takes `packages` (the publish pushes the images), and the
 * extras the config set by hand go to both.
 */
export function jobPermissions(extra: Pick<JobExtras, "permissions">, base: Record<string, string>, job: "gate" | "cut" | "publish" | "after", indent = "    "): string[] {
  const scopes: Record<string, string> = { ...base };
  if (job === "cut" || job === "publish") {
    for (const [k, v] of extra.permissions) {
      if (job === "cut" && k === "packages") continue;
      scopes[k] = v;
    }
  }
  return [`${indent}permissions:`, ...Object.entries(scopes).map(([k, v]) => `${indent}  ${k}: ${v}`)];
}

/** `release.workflow`'s `permissions`, `env` and `setup` (#4751) as lines of the forge's file. Empty for a config without them, so its file is what it was. */
export function jobExtras(p: ReleasePipelineConfig, forge: ReleaseWorkflowForge): JobExtras {
  const permissions = Object.entries(p.permissions ?? {});
  const env = Object.entries(p.env ?? {});
  const setup = p.setup ?? [];
  const where = "release.workflow";
  for (const [k, v] of env) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== "string") throw new Error(`${where}.env: ${JSON.stringify(k)} is not a variable name with a string value`);
  if (forge === "gitlab") {
    if (permissions.length > 0) throw new Error(`${where}.permissions: GitLab has no permissions: block; a GitLab job's token scopes are the project's`);
    const uses = setup.find((s) => "uses" in s);
    if (uses) throw new Error(`${where}.setup: "${(uses as { uses: string }).uses}" is an action, and a GitLab job runs script lines; give it as { run }`);
  } else {
    for (const [k, v] of permissions) {
      if (k === "contents" || k === "id-token") throw new Error(`${where}.permissions: ${k} is already granted (contents: write, id-token: write)`);
      if (!/^[a-z][a-z-]*$/.test(k) || (v !== "read" && v !== "write")) throw new Error(`${where}.permissions: ${k}: ${String(v)} is not a scope and read or write`);
    }
    for (const s of setup) if (!("uses" in s) && s.run.trim() === "") throw new Error(`${where}.setup: a run step is empty`);
    for (const s of setup) if (s.name !== undefined && (s.name.trim() === "" || /[\r\n]/.test(s.name))) throw new Error(`${where}.setup: a step's name is blank or more than one line`);
  }
  const q = (v: string | number | boolean): string => JSON.stringify(v);
  const map = (indent: string, entries: Array<[string, string | number | boolean]>): string[] => entries.map(([k, v]) => `${indent}${k}: ${q(v)}`);
  // #4932: a named step opens with its name.
  const githubSteps = setup.flatMap((s) => [
    ...(s.name !== undefined ? [`      - name: ${q(s.name)}`] : []),
    `      ${s.name !== undefined ? " " : "-"} ${"uses" in s ? `uses: ${s.uses}` : `run: ${q(s.run)}`}`,
    ...("uses" in s && s.with && Object.keys(s.with).length > 0 ? ["        with:", ...map("          ", Object.entries(s.with))] : []),
    ...(s.env && Object.keys(s.env).length > 0 ? ["        env:", ...map("          ", Object.entries(s.env))] : []),
  ]);
  return {
    permissions,
    githubEnv: (base) => (base.length + env.length > 0 ? ["    env:", ...base, ...map("      ", env)] : []),
    githubSteps,
    gitlabVariables: map("    ", env),
    gitlabScript: setup.flatMap((s) => ("uses" in s ? [] : [...Object.entries(s.env ?? {}).map(([k, v]) => `export ${k}=${q(v)}`), s.run])),
  };
}

/**
 * A job that uploads a workflow artifact checks out without persisting the
 * token in `.git/config` (#5268), where the upload could sweep it up, and
 * these lines give its git the job's token instead: a credential helper for
 * the forge's own host only, read from the job's environment, which no
 * upload carries. The cut's fetches, the ledger push and the tag push use it.
 */
export const GIT_TOKEN_ENV = [
  "      CHANT_RELEASE_GIT_TOKEN: ${{ github.token }}",
  '      GIT_CONFIG_COUNT: "1"',
  "      GIT_CONFIG_KEY_0: credential.${{ github.server_url }}.helper",
  `      GIT_CONFIG_VALUE_0: ${JSON.stringify('!f() { test "$1" = get && echo username=x-access-token && echo "password=$CHANT_RELEASE_GIT_TOKEN"; }; f')}`,
];

/** The job's steps upload a workflow artifact (#5268). */
export const uploadsArtifact = (steps: readonly string[]): boolean => steps.some((l) => /uses:\s*actions\/upload-artifact@/.test(l));

/** The checkout and toolchain setup a GitHub or Forgejo job starts with (#5152); `ref` checks out that commit. */
export function githubSetup(ref: string | undefined, setup: readonly string[], persist = true): string[] {
  return [
    `      - uses: ${usesRef(ACTION_PINS.checkout4)}`,
    "        with:",
    ...(ref ? [`          ref: ${ref}`] : []),
    "          fetch-depth: 0",
    ...(persist ? [] : ["          persist-credentials: false"]),
    ...setup,
  ];
}

interface DispatchInput {
  /** What the features read (#5196). */
  context: ReleaseWorkflowContext;
  chant: string;
  install: string | null;
  /** The toolchain steps of the gate (Node, for chant) and of the jobs that build (#5152). */
  chantSetup: string[];
  fullSetup: string[];
  /** The per-platform builds (#5152), each with its toolchain steps. */
  builds: Array<ReleaseBuildConfig & { setup: string[] }>;
  build: string | null;
  root: string | null;
  flags: string;
  after: string[];
  forge: ReleaseWorkflowForge;
  gate: "last-green" | "head";
  lane?: string;
  extra: JobExtras;
  /** The publish job's `GITHUB_TOKEN` line for a GitHub forge target (#4767), or nothing. */
  forgeToken: string[];
  /** The cut job's `GITHUB_TOKEN` line under `forge-checks` (#5149), or nothing. */
  cutToken: string[];
  /** The green gate the cut checks (#5149). */
  green: import("../lifecycle/release-green").ReleaseGreenSource;
  /** The cut job runs `chant release doctor` before the cut (#5161), with the publish job's forge token. */
  doctor: boolean;
}

/** The cut job's token lines: `forge-checks`' (#5149) and, when the doctor runs there (#5161), the publish job's forge token, once. */
function cutEnvToken(o: DispatchInput): string[] {
  return [...new Set([...o.cutToken, ...(o.doctor ? o.forgeToken : [])])];
}

/**
 * The `label` input's description, from what the cut accepts. Under
 * `release.version` the label is the package version, so `v1.4.0` is refused
 * (`release-version-label-invalid`). A `release.tag` template that names
 * `{version}` drops one leading `v` and adds its own, so `0.13.5` and `v0.13.5`
 * make the tag `v0.13.5`. Otherwise the tag carries the label as given. Plain
 * YAML scalar: no colon followed by a space, no ` #`.
 */
export function dispatchLabelDescription(c: Pick<ReleaseWorkflowContext, "version" | "tags">): string {
  const auto = "or auto for the one chant release next computes";
  if (c.version) return `The release's label, a bare version such as 1.4.0 with no leading v since it becomes the package version, ${auto}`;
  if (c.tags && !c.tags.template.legacy && c.tags.template.name.includes("{version}")) return `The release's label, a bare version such as 1.4.0 since the tag template adds any v (one leading v is dropped), ${auto}`;
  return `The release's label, such as 1.4.0 (the tag carries it as given), ${auto}`;
}

/** The label in a dispatched release's cut and publish jobs. */
const DISPATCH_LABEL = '"$CHANT_RELEASE_LABEL"';

/** The node one-liner that prints a JSON document's field from stdin, or from the file its argument names. */
export const field = (path: string): string =>
  `node -e 'const f=process.argv[1];const t=f?require("fs").readFileSync(f,"utf8"):require("fs").readFileSync(0,"utf8");const d=JSON.parse(t);process.stdout.write(String(${path}??""))'`;

/**
 * GitHub refuses the job's token a ref on a commit whose workflow files differ
 * from the default branch's (#4852). The gate checks before the cut builds
 * anything: when the green commit's `.github/workflows` differs from the
 * dispatched commit's, it stops and names the newest commit that changed
 * them, the one to wait for.
 */
function workflowFilesCheck(dispatched: string): string[] {
  const files = '":(top).github/workflows"';
  return [
    `if ! git diff --quiet "$commit" "${dispatched}" -- ${files}; then`,
    `  changed="$(git log -1 --format=%H "$commit..${dispatched}" -- ${files})"`,
    `  echo "the newest green commit, $commit, has other workflow files than ${dispatched}, and GitHub refuses this job's token a tag on it, so no release is cut. Dispatch again once \${changed:-${dispatched}}, which changed .github/workflows, or a commit after it is green." >&2`,
    "  exit 1",
    "fi",
  ];
}

/** The gate's shell: the commit to cut, from `ci last-green`, refused when there is none or, under `head`, when it is not the dispatched one. */
export function gateScript(o: Pick<DispatchInput, "green" | "chant" | "lane" | "gate" | "forge">, dispatched: string): string[] {
  // #5149: with no ci/green tags to search, the gate names the dispatched commit and the cut checks it.
  if (o.green !== "chant") return [`commit="${dispatched}"`];
  return [
    `commit="$(${o.chant} ci last-green --from "${dispatched}"${o.lane ? ` --lane ${o.lane}` : ""} --json | ${field("d.commit?.sha")})"`,
    `if [ -z "$commit" ]; then echo "no green commit at or below ${dispatched}, so no release is cut" >&2; exit 1; fi`,
    ...(o.gate === "head" ? [`if [ "$commit" != "${dispatched}" ]; then echo "${dispatched} is not green (the newest green commit below it is $commit), so no release is cut" >&2; exit 1; fi`] : []),
    ...(o.forge === "github" && o.gate !== "head" ? workflowFilesCheck(dispatched) : []),
  ];
}

/**
 * The gate's line that decides the label (#5159): the one dispatched, or for
 * `auto` the one `chant release next` computes at the gate's commit from the
 * commits and intent files since the member's previous release. One line,
 * so GitLab runs it as one command.
 */
function labelScript(o: DispatchInput): string {
  return [
    'label="$CHANT_RELEASE_LABEL"',
    `if [ "$label" = auto ]; then ${LEDGER_FETCH_FIRST}`,
    `next="$(${o.chant} release next --at "$commit" --json)" || { echo "release next found no label for $commit, so no release is cut: $next" >&2; exit 1; }`,
    `label="$(printf '%s' "$next" | ${field("d.label")})"`,
    "fi",
  ].join("; ");
}

/** The cut's shell: cut the label at the gate's commit, then push the tag the cut made. */
function cutScript(o: DispatchInput, out: string): string[] {
  return [
    'git config user.name "chant release"',
    'git config user.email "chant-release@localhost"',
    `${o.chant} release cut "$CHANT_RELEASE_LABEL" --at "$CHANT_RELEASE_COMMIT" --yes${o.build ? ` --build ${sq(o.build)}` : ""}${o.lane ? ` --lane ${o.lane}` : ""} --json > ${out}`,
    `tag="$(${field("d.tag?.name")} ${out})"`,
    'if [ -n "$tag" ]; then git push origin "refs/tags/$tag"; fi',
  ];
}

/**
 * The cut job's fetch of `chant/lifecycle`. A repository's first release has
 * no ledger branch yet, and the cut is what creates it, so a remote without
 * the branch is not an error here; any other failure of git still stops the
 * job. The publish job runs after the cut has pushed it and fetches it plainly.
 */
export const LEDGER_FETCH_FIRST =
  'rc=0; git ls-remote --exit-code --heads origin chant/lifecycle >/dev/null || rc=$?; if [ "$rc" = 0 ]; then git fetch origin chant/lifecycle:chant/lifecycle; elif [ "$rc" != 2 ]; then exit "$rc"; fi';

/** The label the gate decided (#5159): the dispatched one, or the one `auto` resolved to. */
const GATE_LABEL = "${{ needs.gate.outputs.label }}";

/** GitHub and Forgejo: the release started by hand with a label (#4656). */
function renderGithubDispatch(o: DispatchInput): string {
  const defaults = o.root ? ["    defaults:", "      run:", `        working-directory: ${o.root}`] : [];
  const commit = "${{ needs.gate.outputs.commit }}";
  const fetches = ["      - run: git fetch origin 'refs/tags/ci/*:refs/tags/ci/*'", "      - run: git fetch origin chant/lifecycle:chant/lifecycle"];
  const block = (lines: string[]): string[] => ["      - run: |", ...lines.map((l) => `          ${l}`)];
  const installLines = o.install ? [`      - run: ${o.install}`] : [];
  const q = (v: string): string => JSON.stringify(v);
  const upload = usesRef(o.forge === "forgejo" ? ACTION_PINS.uploadArtifact3 : ACTION_PINS.uploadArtifact4);
  // #5152: each build job runs on its own runner with the commit, its toolchains and nothing else: no secrets, and a token that can only read.
  const buildJobs = o.builds.flatMap((b) => {
    const install = b.install === false ? null : (b.install ?? o.install);
    const runner = Array.isArray(b.runner) ? `[${b.runner.map(q).join(", ")}]` : q(b.runner);
    const env = Object.entries(b.env ?? {});
    for (const [k] of env) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`release.workflow.builds.${b.name}.env: ${JSON.stringify(k)} is not a variable name`);
    return [
      `  build-${b.name}:`,
      "    needs: gate",
      `    runs-on: ${runner}`,
      "    permissions:",
      "      contents: read",
      "    defaults:",
      "      run:",
      "        shell: bash",
      ...(o.root ? [`        working-directory: ${o.root}`] : []),
      "    env:",
      `      CHANT_RELEASE_LABEL: ${GATE_LABEL}`,
      ...env.map(([k, v]) => `      ${k}: ${q(v)}`),
      "    steps:",
      ...githubSetup(commit, b.setup, false),
      ...(install ? [`      - run: ${install}`] : []),
      `      - run: ${q(b.build)}`,
      `      - run: ${q(packLine(b))}`,
      `      - uses: ${upload}`,
      "        with:",
      `          name: ${releaseBuildArtifact(b.name)}`,
      `          path: ${o.root ? `${o.root}/` : ""}${releaseBuildArchive(b.name)}`,
      "          if-no-files-found: error",
      "          retention-days: 1",
    ];
  });
  const run = (l: string) => `      - run: ${l}`;
  const cut = releaseJobSteps({ ...o.context, job: "cut", label: DISPATCH_LABEL });
  const publish = releaseJobSteps({ ...o.context, job: "publish", label: DISPATCH_LABEL });
  const cutStep = (slot: ReleaseStepSlot) => stepLines(cut(slot), run);
  const publishStep = (slot: ReleaseStepSlot) => stepLines(publish(slot), run);
  const built = o.builds.map((b) => `build-${b.name}`);
  // #5268: a cut that hands files on keeps no token in .git/config.
  const cutUploads = uploadsArtifact(cutStep("afterCut"));
  const lines = [
    "name: chant release",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      label:",
    `        description: ${dispatchLabelDescription(o.context)}`,
    "        required: true",
    "        type: string",
    "permissions:",
    "  contents: read",
    "concurrency:",
    "  group: chant-release",
    "  cancel-in-progress: false",
    "env:",
    "  CHANT_RELEASE_LABEL: ${{ inputs.label }}",
    "jobs:",
    "  gate:",
    "    runs-on: ubuntu-latest",
    ...jobPermissions(o.extra, { contents: "read" }, "gate"),
    ...defaults,
    "    outputs:",
    "      commit: ${{ steps.green.outputs.commit }}",
    "      label: ${{ steps.green.outputs.label }}",
    "    steps:",
    ...githubSetup(undefined, o.chantSetup),
    ...installLines,
    fetches[0]!,
    "      - id: green",
    "        run: |",
    ...[...gateScript(o, "$GITHUB_SHA"), labelScript(o), 'echo "commit=$commit" >> "$GITHUB_OUTPUT"', 'echo "label=$label" >> "$GITHUB_OUTPUT"'].map((l) => `          ${l}`),
    ...buildJobs,
    "  cut:",
    `    needs: ${built.length > 0 ? `[gate, ${built.join(", ")}]` : "gate"}`,
    "    runs-on: ubuntu-latest",
    ...jobPermissions(o.extra, { contents: "write", ...(o.context.signing && o.context.doctor ? { "id-token": "write" } : {}) }, "cut"),
    ...defaults,
    ...o.extra.githubEnv([`      CHANT_RELEASE_COMMIT: ${commit}`, `      CHANT_RELEASE_LABEL: ${GATE_LABEL}`, ...cutEnvToken(o), ...(cutUploads ? GIT_TOKEN_ENV : [])]),
    "    steps:",
    ...githubSetup(commit, o.fullSetup, !cutUploads),
    ...installLines,
    ...o.extra.githubSteps,
    ...cutStep("prepare"),
    fetches[0]!,
    `      - run: ${LEDGER_FETCH_FIRST}`,
    ...cutStep("beforeCut"),
    ...block(cutScript(o, '"$RUNNER_TEMP/chant-cut.json"')),
    ...cutStep("afterCut"),
    "  publish:",
    `    needs: [gate, cut${built.map((b) => `, ${b}`).join("")}]`,
    "    runs-on: ubuntu-latest",
    ...jobPermissions(o.extra, { contents: "write", "id-token": "write" }, "publish"),
    ...defaults,
    ...o.extra.githubEnv([`      CHANT_RELEASE_LABEL: ${GATE_LABEL}`, ...o.forgeToken]),
    "    steps:",
    ...githubSetup(commit, o.fullSetup),
    ...installLines,
    ...o.extra.githubSteps,
    ...fetches,
    ...publishStep("prepare"),
    ...publishStep("beforeBuild"),
    ...(o.build ? [`      - run: ${o.build}`] : []),
    ...publishStep("afterBuild"),
    ...publishStep("beforePublish"),
    `      - run: ${o.chant} release publish "$CHANT_RELEASE_LABEL" ${o.flags}`,
    ...publishStepEnv(publish("publishEnv")),
  ];
  if (o.after.length > 0) {
    lines.push("  after-release:", "    needs: [gate, publish]", "    runs-on: ubuntu-latest", ...jobPermissions(o.extra, { contents: "read" }, "after"), ...defaults, "    env:", `      CHANT_RELEASE_LABEL: ${GATE_LABEL}`, "    steps:", ...githubSetup(commit, o.fullSetup), ...installLines, ...o.after.map((l) => `      - run: ${l}`));
  }
  return tagComments(`${lines.join("\n")}\n`);
}

/**
 * GitLab: the release started from "Run pipeline" with `CHANT_RELEASE_LABEL`
 * set (#4656). The jobs follow each other by `needs`, in the file's default
 * stage, so the including `.gitlab-ci.yml` keeps its own `stages`. A job
 * token cannot push, so the cut and publish jobs push with
 * `CHANT_RELEASE_TOKEN`, a project access token with `write_repository`.
 */
function renderGitlabDispatch(o: DispatchInput): string {
  const cd = o.root ? [`cd ${o.root}`] : [];
  const install = o.install ? [o.install] : [];
  const fetches = ["git fetch origin 'refs/tags/ci/*:refs/tags/ci/*'", "git fetch origin chant/lifecycle:chant/lifecycle"];
  const auth = [
    `chant_auth="$(printf 'oauth2:%s' "$CHANT_RELEASE_TOKEN" | base64 | tr -d '\\n')"`,
    'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $chant_auth"',
    "unset chant_auth",
  ];
  const job = (name: string, needs: string[], script: ReleaseStepItem[], extra: string[] = [], vars: string[] = []): string[] => [
    `${name}:`,
    "  rules:",
    '    - if: $CHANT_RELEASE_LABEL && $CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/',
    "  variables:",
    '    GIT_DEPTH: "0"',
    ...vars,
    ...(needs.length > 0 ? [`  needs: [${needs.join(", ")}]`] : []),
    ...extra,
    "  script:",
    // #5159: a pipeline variable outranks the gate's dotenv, so the label the gate decided comes in as CHANT_RELEASE_NEXT.
    ...stepLines([...(needs.length > 0 ? ['export CHANT_RELEASE_LABEL="$CHANT_RELEASE_NEXT"'] : []), ...script], (l) => `    - ${JSON.stringify(l)}`),
  ];
  const checkout = ['git checkout --detach "$CHANT_RELEASE_COMMIT"'];
  // #5152: a build job per runner (tags), whose archive GitLab hands to the jobs that need it, in the project directory.
  const built = o.builds.map((b) => `chant-release-build-${b.name}`);
  const buildJobs = o.builds.flatMap((b) => {
    const binstall = b.install === false ? [] : b.install ? [b.install] : install;
    const env = Object.entries(b.env ?? {});
    for (const [k] of env) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`release.workflow.builds.${b.name}.env: ${JSON.stringify(k)} is not a variable name`);
    const tags = Array.isArray(b.runner) ? b.runner : [b.runner];
    return [
      "",
      ...job(
        `chant-release-build-${b.name}`,
        ["chant-release-gate"],
        [...checkout, ...cd, ...binstall, b.build, packLine(b)],
        [`  tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`, "  artifacts:", "    paths:", `      - ${JSON.stringify(`${o.root ? `${o.root}/` : ""}${releaseBuildArchive(b.name)}`)}`, "    expire_in: 1 day"],
        env.map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`),
      ),
    ];
  });
  const cut = releaseJobSteps({ ...o.context, job: "cut", label: DISPATCH_LABEL });
  const publish = releaseJobSteps({ ...o.context, job: "publish", label: DISPATCH_LABEL });
  const artifactPaths = cut("artifactPaths").flatMap((i) => (typeof i === "string" ? [`      - ${JSON.stringify(i)}`] : i.lines));
  const lines = [
    ...job(
      "chant-release-gate",
      [],
      [...cd, ...install, fetches[0]!, ...gateScript(o, "$CI_COMMIT_SHA"), labelScript(o), 'printf \'CHANT_RELEASE_COMMIT=%s\\nCHANT_RELEASE_NEXT=%s\\n\' "$commit" "$label" > "$CI_PROJECT_DIR/chant-release-gate.env"'],
      ["  artifacts:", "    reports:", "      dotenv: chant-release-gate.env"],
    ),
    ...buildJobs,
    "",
    ...job(
      "chant-release-cut",
      ["chant-release-gate", ...built],
      [
        ...checkout,
        ...cd,
        ...install,
        ...o.extra.gitlabScript,
        ...cut("prepare"),
        fetches[0]!,
        ...auth,
        LEDGER_FETCH_FIRST,
        ...cut("beforeCut"),
        ...cutScript(o, "/tmp/chant-cut.json"),
        ...cut("afterCut"),
      ],
      [...(artifactPaths.length > 0 ? ["  artifacts:", "    paths:", ...artifactPaths, "    expire_in: 1 day"] : []), ...stepLines(cut("jobKeys"), (l) => l)],
      o.extra.gitlabVariables,
    ),
    "",
    ...job(
      "chant-release-publish",
      ["chant-release-gate", "chant-release-cut", ...built],
      [
        ...checkout,
        ...publish("afterCheckout"),
        ...cd,
        ...install,
        ...o.extra.gitlabScript,
        ...fetches,
        ...auth,
        ...publish("prepare"),
        ...publish("beforeBuild"),
        ...(o.build ? [o.build] : []),
        ...publish("afterBuild"),
        ...publish("beforePublish"),
        `${o.chant} release publish "$CHANT_RELEASE_LABEL" ${o.flags}`,
      ],
      publishIdTokens(publish("idTokens")),
      o.extra.gitlabVariables,
    ),
  ];
  if (o.after.length > 0) lines.push("", ...job("chant-release-after", ["chant-release-gate", "chant-release-publish"], [...checkout, ...cd, ...install, ...o.after]));
  return `${lines.join("\n")}\n`;
}

/**
 * Whether the default build, `npm run build`, has a script to run at `root`
 * (#5149): a package.json with a `build` script. A package with no build
 * script, and a project with no package.json (#5152), get no build step
 * rather than one that fails.
 */
function hasBuildScript(root: string): boolean {
  let text: string;
  try {
    text = readFileSync(`${root}/package.json`, "utf-8");
  } catch {
    return false;
  }
  try {
    const pkg = JSON.parse(text) as { scripts?: Record<string, unknown> };
    return typeof pkg.scripts?.build === "string";
  } catch {
    return true;
  }
}

/** The header that marks the file generated, naming the command that regenerates it. */
export function releaseWorkflowHeader(command: string): string {
  return `# ${GENERATED_MARKER}. Regenerate with: ${command} (in the workspace root)\n`;
}

/**
 * `chant release workflow [--forge github|gitlab|forgejo] [--install <command>]
 * [--build <command>|--no-build] [--chant <command>] [--output <file>]`: write
 * the publish workflow for the workspace's forge, under its security groups.
 */
export async function runReleaseWorkflow(ctx: import("../cli/registry").CommandContext): Promise<number> {
  const { existsSync, mkdirSync, realpathSync, writeFileSync } = await import("node:fs");
  const { dirname, join, relative, resolve, sep } = await import("node:path");
  const { formatError, formatSuccess } = await import("../cli/format");
  const { findWorkspaceRoot } = await import("../project-root");
  const { gitTop } = await import("./tree");
  const { securityGroupsAt } = await import("./security");
  const { shellArg } = await import("./member-pipeline");
  const usage = "chant release workflow [--forge github|gitlab|forgejo] [--install <command>] [--build <command>] [--chant <command>] [--output <file>] [--force]";
  const { args } = ctx;
  // #5149: a project with only a chant.config.ts, and no chant.workspace.json, renders its release workflow too.
  const found = findWorkspaceRoot(process.cwd());
  const projectDir = found?.dir ?? (["chant.config.ts", "chant.config.json"].some((f) => existsSync(join(process.cwd(), f))) ? process.cwd() : null);
  if (!projectDir) {
    console.error(formatError({ message: "no chant.workspace.json between this directory and the git root, and no chant.config.ts or chant.config.json here", hint: usage }));
    return 1;
  }
  const root = realpathSync(projectDir);
  const repoRoot = gitTop(root) ?? root;
  const forge = (args.forge ??
    (existsSync(join(repoRoot, ".github", "workflows")) ? "github" : existsSync(join(repoRoot, ".forgejo", "workflows")) ? "forgejo" : existsSync(join(repoRoot, ".gitlab-ci.yml")) ? "gitlab" : "github")) as ReleaseWorkflowForge;
  if (!(RELEASE_WORKFLOW_FORGES as readonly string[]).includes(forge)) {
    console.error(formatError({ message: `--forge ${JSON.stringify(forge)} is not one of ${RELEASE_WORKFLOW_FORGES.join(", ")}`, hint: usage }));
    return 1;
  }
  const groups = securityGroupsAt(root);
  const workspaceRoot = relative(repoRoot, root).split(sep).join("/") || ".";
  // #4656: release.workflow, release.images and release.lane in the root's chant.config.ts.
  let release: import("../config").ChantConfig["release"];
  try {
    const { loadChantConfig } = await import("../config");
    release = (await loadChantConfig(root)).config.release;
  } catch (err) {
    console.error(formatError({ message: `chant.config.ts at the workspace root could not be read: ${err instanceof Error ? err.message : String(err)}`, hint: usage }));
    return 1;
  }
  // #5150: release.tag decides the tags the workflow runs on, refused when another member's can make the same tag.
  let tags: MemberTags;
  try {
    const { memberTags, checkTagCollisions } = await import("../lifecycle/release-tag");
    tags = await memberTags(root, { config: release?.tag, top: repoRoot });
    await checkTagCollisions(root, tags);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    console.error(formatError({ message: `${err instanceof Error ? err.message : String(err)}${typeof code === "string" ? ` [${code}]` : ""}`, hint: usage }));
    return 1;
  }
  // #5154: a train publishes its members' targets, so their credentials, tools and signing are the workflow's.
  const memberReleases: Array<NonNullable<typeof release>> = [];
  let goreleaserDir: string | undefined;
  // #5237: the members' per-platform builds, each with its member.
  const memberBuilds: Array<{ member: string; dir: string; files: string[]; build: import("./release-toolchains").ReleaseBuildConfig }> = [];
  if (release?.train) {
    const { locateWorkspace } = await import("./which-chant");
    const { readDeclaration } = await import("./declaration");
    const { loadChantConfig } = await import("../config");
    const located = locateWorkspace(root);
    for (const m of readDeclaration(located.tree, "", { rootChant: true }).members.filter((x) => x.kind === "chant" && x.dir !== ".")) {
      try {
        const r = (await loadChantConfig(join(root, m.dir))).config.release;
        if (r) memberReleases.push(r);
        if ((r?.workflow?.builds?.length ?? 0) > 0) {
          const { TOOLCHAIN_MARKERS } = await import("./release-toolchains");
          const files = TOOLCHAIN_MARKERS.filter((f) => existsSync(join(root, m.dir, f)));
          for (const build of r!.workflow!.builds!) memberBuilds.push({ member: m.name, dir: m.dir.split(sep).join("/"), files, build });
        }
        if (r?.artifacts && goreleaserDir === undefined && (await import("../lifecycle/release-artifacts")).usesGoreleaser(r.artifacts)) goreleaserDir = m.dir.split(sep).join("/");
      } catch (err) {
        console.error(formatError({ message: `member ${m.name}'s chant.config.ts could not be read: ${err instanceof Error ? err.message : String(err)}`, hint: usage }));
        return 1;
      }
    }
    // #5216: a member's files are built by its cut, in the train's cut job; #5237: or by the member's own release.workflow.builds, which builtBy names.
    const { checkReleaseArtifacts, ReleaseArtifactError } = await import("../lifecycle/release-artifacts");
    for (const r of memberReleases) {
      if ((r.artifacts?.length ?? 0) === 0) continue;
      try {
        checkReleaseArtifacts(r.artifacts!, { builds: r.workflow?.builds ?? [] });
      } catch (err) {
        if (!(err instanceof ReleaseArtifactError)) throw err;
        console.error(formatError({ message: `release.train: a member's ${err.message} [${err.code}]`, hint: err.fix ?? "Fix release.artifacts in the member's chant.config.ts." }));
        return 1;
      }
    }
  }
  const memberImages = memberReleases.flatMap((r) => r.images ?? []);
  // #5457: the registries the images pull from that need a login, at the root and in the members.
  const { releaseImagePulls } = await import("../lifecycle/release-images");
  const pullRegistries = releaseImagePulls([...(release?.images ?? []), ...memberImages]);
  const memberArtifacts = memberReleases.flatMap((r) => r.artifacts ?? []);
  const allTargets = [...(release?.publish ?? []), ...memberReleases.flatMap((r) => r.publish ?? [])];
  const { resolveSigning, signingStepVariables } = await import("../lifecycle/publish-signing");
  // #5458: a key signs the SLSA statement that meets --require-provenance with no CI OIDC token, so under supply-chain it signs for any target.
  const signsFor = (r: (typeof memberReleases)[number] | undefined) => {
    const setting = resolveSigning(r?.signing, groups);
    const targets = r?.publish ?? [];
    return setting.on && (targets.some((t) => t.type === "oci" || t.type === "forge" || t.type === "pypi") || (setting.mode !== "keyless" && groups.has("supply-chain") && targets.length > 0));
  };
  const signs = [release, ...memberReleases].some(signsFor);
  const signingEnv = [...new Set([release, ...memberReleases].filter(signsFor).flatMap((r) => signingStepVariables(resolveSigning(r?.signing, groups))))];
  // #5446: the scan before the stage, when release.scan or supply-chain asks for it and a target has something to scan.
  const { resolveScan } = await import("../lifecycle/publish-scan");
  const scans = [release, ...memberReleases].some((r) => resolveScan(r?.scan, groups).on && (r?.publish ?? []).some((t) => t.type === "oci" || t.type === "forge" || t.type === "npm"));
  // #5152: the toolchains the project's root files name, and chant from npm for a project with no package.json.
  const { TOOLCHAIN_MARKERS, detectToolchains } = await import("./release-toolchains");
  const projectFiles = TOOLCHAIN_MARKERS.filter((f) => existsSync(join(root, f)));
  const node = projectFiles.includes("package.json");
  const { readerVersion } = await import("./declaration");
  let text: string;
  // #5183: an artifact's builtBy names a job of release.workflow.builds, so a workflow without it is refused here, not at the cut.
  if ((release?.artifacts?.length ?? 0) > 0) {
    const { checkReleaseArtifacts, ReleaseArtifactError } = await import("../lifecycle/release-artifacts");
    try {
      checkReleaseArtifacts(release!.artifacts!, { builds: release?.workflow?.builds ?? [] });
    } catch (err) {
      if (!(err instanceof ReleaseArtifactError)) throw err;
      console.error(formatError({ message: `${err.message} [${err.code}]`, hint: err.fix ?? "Fix release.artifacts in chant.config.ts." }));
      return 1;
    }
  }
  try {
  text = renderReleaseWorkflow({
    forge,
    projectFiles,
    ...(node || args.ciInstall || release?.workflow?.install !== undefined ? {} : { install: null }),
    ...(node || args.ciChant || release?.workflow?.chant !== undefined ? {} : { chant: `npx --yes @intentius/chant@${readerVersion()}` }),
    groups,
    workspaceRoot,
    tags,
    ...(release?.workflow ? { pipeline: release.workflow } : {}),
    ...((release?.images?.length ?? 0) > 0 ? { images: true, imageArchives: resolveReleaseImages(placeReleaseImages(release!.images!, release!.artifacts ?? [])).map((i) => i.archive), imagePlatforms: releaseImagePlatforms(release!.images!) } : {}),
    ...((release?.artifacts?.length ?? 0) > 0 ? { artifacts: true, ...((await import("../lifecycle/release-artifacts")).usesGoreleaser(release!.artifacts!) ? { goreleaser: true } : {}), ...((await import("../lifecycle/release-artifacts")).usesNfpm(release!.artifacts!) ? { nfpm: true } : {}) } : {}),
    ...(release?.lane ? { lane: release.lane } : {}),
    green: await (async () => {
      const { resolveGreenSource } = await import("../lifecycle/release-green");
      const { scopeSource } = await import("./write-scope");
      const { execFileSync } = await import("node:child_process");
      let greenTags = "";
      try {
        greenTags = execFileSync("git", ["tag", "--list", "ci/green/*", "ci/green-*/*"], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        greenTags = "";
      }
      return resolveGreenSource(release?.green, (scopeSource(root).declaration?.ci?.green ?? null) !== null, release?.green === undefined && greenTags !== "");
    })(),
    ...(release?.version ? { version: true } : {}),
    ...(signs ? { signing: true } : {}),
    ...(signingEnv.length > 0 ? { signingEnv } : {}),
    ...(scans ? { scan: true } : {}),
    ...(pullRegistries.length > 0 ? { pullRegistries } : {}),
    ...(allTargets.length > 0 ? { publish: allTargets } : {}),
    ...(release?.train
      ? {
          train: {
            env: release.train.env,
            ...(memberImages.length > 0 ? { images: true, imagePlatforms: releaseImagePlatforms(memberImages) } : {}),
            ...(memberArtifacts.length > 0 ? { artifacts: true, ...((await import("../lifecycle/release-artifacts")).usesGoreleaser(memberArtifacts) ? { goreleaser: true, ...(goreleaserDir ? { goreleaserDir } : {}) } : {}) } : {}),
            ...(memberBuilds.length > 0 ? { builds: memberBuilds } : {}),
          },
        }
      : {}),
    ...(args.ciInstall ? { install: args.ciInstall } : {}),
    ...(args.buildCommand ? { build: args.buildCommand } : !hasBuildScript(root) && release?.workflow?.build === undefined ? { build: null } : {}),
    ...(args.ciChant ? { chant: args.ciChant } : {}),
  });
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err), hint: "Fix release.workflow in chant.config.ts." }));
    return 1;
  }
  // #4909: under `chant dev generated-check` the header names the committed file the render stands for.
  // #4950: with no --output the file goes to the render tree too, so a render needs no `--output {out}/...`.
  const { committedPathOf, isRenderPath, renderPathOf } = await import("../generated-check");
  const defaultTarget = join(repoRoot, release?.workflow?.file ?? RELEASE_WORKFLOW_FILES[forge]);
  const target = args.output ? resolve(process.cwd(), args.output) : renderPathOf(defaultTarget);
  const asCommitted = committedPathOf(target);
  const parts = ["chant", "release", "workflow", "--forge", forge];
  if (args.ciInstall) parts.push("--install", args.ciInstall);
  if (args.buildCommand) parts.push("--build", args.buildCommand);
  if (args.ciChant) parts.push("--chant", args.ciChant);
  if (args.output && !(isRenderPath(target) && asCommitted === defaultTarget)) parts.push("--output", relative(root, asCommitted).split(sep).join("/"));
  // A file a person wrote, such as the npm publish workflow release.workflow.file names, is replaced only with --force.
  if (args.force !== true && existsSync(target) && !readFileSync(target, "utf-8").includes(GENERATED_MARKER)) {
    const shownTarget = relative(process.cwd(), target).split(sep).join("/") || target;
    console.error(formatError({ message: `${shownTarget} exists and chant did not write it [release-workflow-exists]`, hint: "Run again with --force to replace it." }));
    return 1;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, releaseWorkflowHeader(parts.map(shellArg).join(" ")) + text);
  const shown = relative(process.cwd(), target).split(sep).join("/") || target;
  const extras = [groups.has("supply-chain") ? "requires OIDC provenance (supply-chain)" : null, groups.has("verified-releases") ? "verifies the release first (verified-releases)" : null, signs ? `signs with Sigstore, with cosign ${TOOL_PINS.cosign.version} pinned by SHA-256` : null, scans ? `scans before anything is pushed, with grype ${TOOL_PINS.grype.version} and syft ${TOOL_PINS.syft.version} pinned by SHA-256` : null].filter(Boolean);
  const what = release?.train
    ? release.workflow?.trigger === "dispatch"
      ? `cuts and publishes a release train for ${release.train.env} started by hand, from a green commit, and publishes one a release-train/${release.train.env}/* tag names`
      : `publishes the release train a release-train/${release.train.env}/* tag names`
    : release?.workflow?.trigger === "dispatch"
      ? "cuts and publishes a release started by hand with its label, from a green commit"
      : `publishes the release a ${tags.template.legacy ? "release/**" : releaseTagFilters(tags).globs[0]} tag names`;
  console.log(formatSuccess(`Wrote ${shown}: ${what}${extras.length > 0 ? `, and ${extras.join(" and ")}` : ""}.`));
  if (forge === "gitlab") console.log(`Include it from .gitlab-ci.yml: include: [{ local: ${release?.workflow?.file ?? RELEASE_WORKFLOW_FILES.gitlab} }]`);
  // #4876: a GitLab executor that refuses privileged containers can't install the handlers from the job.
  const archs = (release?.images?.length ?? 0) > 0 ? qemuArchitectures(releaseImagePlatforms(release!.images!)) : [];
  if (forge === "gitlab" && archs.length > 0 && text.includes(`${RELEASE_BINFMT_IMAGE} --install`))
    console.log(`The cut and publish jobs install QEMU's binfmt handlers for ${archs.join(", ")} with docker run --privileged ${RELEASE_BINFMT_IMAGE}: the runner's executor must run privileged containers, or have the handlers installed on its host.`);
  const others = detectToolchains(new Set(projectFiles)).filter((t) => t !== "node");
  if (forge === "gitlab" && others.length > 0 && release?.workflow?.toolchains === undefined) console.log(`The jobs build with ${others.join(", ")}: a GitLab job takes its toolchain from the runner's image, so name an image that has it, and Node for chant, in .gitlab-ci.yml.`);
  if (forge === "gitlab" && release?.workflow?.trigger !== "dispatch" && tags.template.floating)
    console.log(`The publish job moves the floating tag (${tags.template.floating}) with git push, which a GitLab job token can't do: use release.workflow.trigger "dispatch", whose jobs push with CHANT_RELEASE_TOKEN, or move it by hand.`);
  if (forge === "gitlab" && text.includes("CHANT_GORELEASER=/tmp/goreleaser")) console.log("The job that builds release.artifacts runs goreleaser with the Go of the job's image: give it an image with the Go your go.mod names.");
  if (forge === "gitlab" && release?.workflow?.trigger === "dispatch") console.log("The cut and publish jobs push with CHANT_RELEASE_TOKEN: a project access token with write_repository, as a masked CI/CD variable.");
  if (forge === "gitlab" && release?.train && release.workflow?.trigger === "dispatch")
    console.log(`Start a train by running a pipeline with CHANT_RELEASE_LEVELS=auto (or the levels), and publish a recorded one with CHANT_RELEASE_TRAIN=<id>. A release-train/${release.train.env}/* tag pushed from a workstation starts nothing in this file: publish it with CHANT_RELEASE_TRAIN.`);
  return 0;
}
