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
 */
import { readFileSync } from "node:fs";
import { ACTION_PINS, tagComments, usesRef } from "../action-pins";
import { IMAGE_PINS, imageRef } from "../image-pins";
import { TOOL_PINS, toolInstallLine } from "../tool-pins";
import { releaseImagePlatforms, resolveReleaseImages } from "../lifecycle/release-images";
import { GENERATED_MARKER } from "../discovery/files";
import { tagShape, type MemberTags } from "../lifecycle/release-tag";
import type { SecurityGroup } from "./security";
import type { OpSetupStep } from "../lexicon";
import { checkBuilds, releaseBuildArchive, releaseBuildArtifact, resolveToolchains, toolchainLines, type ReleaseBuildConfig, type ReleaseToolchainDecl } from "./release-toolchains";

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
}

/** npm trusted publishing needs this npm or later (#4786). */
export const NPM_TRUSTED_PUBLISHING_MIN = "11.5.1";
/** The npm a publish job installs when the runner's Node bundles one older than {@link NPM_TRUSTED_PUBLISHING_MIN}. */
export const NPM_TRUSTED_PUBLISHING_VERSION = "11.19.0";

/**
 * The shell line that installs {@link NPM_TRUSTED_PUBLISHING_VERSION} when the
 * runner's npm is older than {@link NPM_TRUSTED_PUBLISHING_MIN}, and prints the
 * npm in use.
 */
export const NPM_TRUSTED_PUBLISHING_SETUP = `have="$(npm --version)"; if [ "$(printf '%s\\n' "${NPM_TRUSTED_PUBLISHING_MIN}" "$have" | sort -V | head -n1)" != "${NPM_TRUSTED_PUBLISHING_MIN}" ]; then npm install -g npm@${NPM_TRUSTED_PUBLISHING_VERSION}; fi; npm --version`;

/**
 * What a GitHub release workflow needs for its targets, worked out from them
 * (#4786), so no product wires it by hand:
 *
 * - an `oci` target on `ghcr.io` that names no credentials pushes with the
 *   job's token: `packages: write`, and `OCI_USERNAME` and `OCI_PASSWORD`
 *   from `github.actor` and `github.token`;
 * - an `npm` target on npmjs publishes with trusted publishing, which needs
 *   npm {@link NPM_TRUSTED_PUBLISHING_MIN}: the jobs upgrade npm when the
 *   runner's is older.
 *
 * `release.workflow` wins: a scope, variable or the same setup line it names
 * is not added again. Other forges, and configs without such targets, get
 * nothing.
 */
export function targetExtras(forge: ReleaseWorkflowForge, targets: ReadonlyArray<ReleaseWorkflowTarget>, p: ReleasePipelineConfig): Pick<ReleasePipelineConfig, "permissions" | "env" | "setup"> {
  if (forge !== "github") return {};
  const ghcr = targets.some((t) => t.type === "oci" && /^ghcr\.io\//.test(t.repository ?? "") && !t.usernameEnv && !t.passwordEnv);
  const npm = targets.some((t) => t.type === "npm" && (t.registry === undefined || /^https:\/\/registry\.npmjs\.org\/?$/.test(t.registry)));
  const permissions = ghcr && p.permissions?.packages === undefined ? { packages: "write" as const } : undefined;
  const env = ghcr ? Object.fromEntries((["OCI_USERNAME", "OCI_PASSWORD"] as const).filter((k) => p.env?.[k] === undefined).map((k) => [k, k === "OCI_USERNAME" ? "${{ github.actor }}" : "${{ github.token }}"])) : {};
  const setup = npm && !(p.setup ?? []).some((s) => !("uses" in s) && s.run === NPM_TRUSTED_PUBLISHING_SETUP) ? [{ run: NPM_TRUSTED_PUBLISHING_SETUP }] : [];
  return { ...(permissions ? { permissions } : {}), ...(Object.keys(env).length > 0 ? { env } : {}), ...(setup.length > 0 ? { setup } : {}) };
}

/** The platform the jobs `chant release workflow` writes run on: GitHub's and Forgejo's `ubuntu-latest`, and a GitLab runner's default (#4876). */
export const RELEASE_RUNNER_PLATFORM = "linux/amd64";

/** The binfmt image a GitLab job installs QEMU's handlers with (#4876): the repository, which a config's own setup line is recognised by. */
export const RELEASE_BINFMT_IMAGE = IMAGE_PINS.binfmt.repository;

/** The architectures among `platforms` the runner can't run, as QEMU names them (`linux/arm/v7` is `arm`), each once. */
export function qemuArchitectures(platforms: readonly string[]): string[] {
  return [...new Set(platforms.filter((p) => p.split("/").slice(0, 2).join("/") !== RELEASE_RUNNER_PLATFORM).map((p) => p.split("/")[1] ?? p))].sort();
}

/**
 * QEMU's binfmt setup for the platforms `release.images` builds that the
 * runner can't, such as `linux/arm64` on an amd64 runner (#4876), so no
 * product names it in `release.workflow.setup`. GitHub and Forgejo get
 * `docker/setup-qemu-action` at its pin; GitLab a `docker run --privileged`
 * of {@link RELEASE_BINFMT_IMAGE} by the digest `IMAGE_PINS.binfmt` records
 * (#4941, ../image-pins.ts), which `chant release workflow` notes needs
 * an executor that runs privileged containers. A config whose `setup` names
 * the action or the binfmt image already gets nothing more, so its file
 * renders as it did.
 */
export function qemuSetup(forge: ReleaseWorkflowForge, platforms: readonly string[], p: ReleasePipelineConfig): OpSetupStep[] {
  const archs = qemuArchitectures(platforms);
  if (archs.length === 0) return [];
  const named = (p.setup ?? []).some((s) => ("uses" in s ? /^docker\/setup-qemu-action@/.test(s.uses) : s.run.includes(RELEASE_BINFMT_IMAGE)));
  if (named) return [];
  return forge === "gitlab" ? [{ run: `docker run --privileged --rm ${imageRef(IMAGE_PINS.binfmt)} --install ${archs.join(",")}` }] : [{ uses: usesRef(ACTION_PINS.dockerSetupQemu4), with: { platforms: archs.join(",") } }];
}

/** The workflow artifact the cut job hands the files `release.artifacts` built on in (#5151). */
export const RELEASE_ARTIFACTS_ARTIFACT = "chant-release-artifacts";

/** Where a job stages, and the publish job finds, the files the cut built (#5151): outside the checkout on GitHub and Forgejo; GitLab keeps job artifacts only inside the project directory, so its publish job moves them out first. */
export const RELEASE_ARTIFACTS_STAGE: Record<ReleaseWorkflowForge, string> = {
  github: "$RUNNER_TEMP/chant-release-artifacts",
  forgejo: "$RUNNER_TEMP/chant-release-artifacts",
  gitlab: "$CI_PROJECT_DIR/.chant-release-artifacts",
};

/**
 * What a job that builds goreleaser entries runs first (#5151): Go from the
 * member's `go.mod` (GitHub and Forgejo, unless `release.workflow.setup`
 * names `actions/setup-go`), then the pinned goreleaser, downloaded, checked
 * by SHA-256 and named by `CHANT_GORELEASER`. A config that sets
 * `CHANT_GORELEASER` in `release.workflow.env` gets no install. GitLab
 * jobs run in the project's image, which brings its own Go.
 */
export function goreleaserSetup(forge: ReleaseWorkflowForge, root: string | null, p: ReleasePipelineConfig): { github: string[]; gitlab: string[] } {
  const install = p.env?.CHANT_GORELEASER === undefined;
  if (forge === "gitlab") {
    return { github: [], gitlab: install ? [`${toolInstallLine(TOOL_PINS.goreleaser, RELEASE_RUNNER_PLATFORM, "/tmp/goreleaser")} && export CHANT_GORELEASER=/tmp/goreleaser/goreleaser`] : [] };
  }
  const go = (p.setup ?? []).some((s) => "uses" in s && /^actions\/setup-go@/.test(s.uses))
    ? []
    : [`      - uses: ${usesRef(ACTION_PINS.setupGo7)}`, "        with:", `          go-version-file: ${root ? `${root}/` : ""}go.mod`];
  const line = `${toolInstallLine(TOOL_PINS.goreleaser, RELEASE_RUNNER_PLATFORM, "$RUNNER_TEMP/goreleaser")} && echo "CHANT_GORELEASER=$RUNNER_TEMP/goreleaser/goreleaser" >> "$GITHUB_ENV"`;
  return { github: [...go, ...(install ? [`      - name: goreleaser ${TOOL_PINS.goreleaser.version}`, `        run: ${JSON.stringify(line)}`] : [])], gitlab: [] };
}

/**
 * The step that installs cosign for Sigstore signing (#5164): the binary
 * {@link TOOL_PINS} pins for the runner's platform, downloaded to the job's
 * temp directory and checked against its SHA-256, and `CHANT_COSIGN` set to
 * it. A config whose `setup` already sets `CHANT_COSIGN` gets nothing.
 */
export function cosignSetup(forge: ReleaseWorkflowForge, p: ReleasePipelineConfig): OpSetupStep[] {
  if ((p.setup ?? []).some((s) => !("uses" in s) && s.run.includes("CHANT_COSIGN")) || p.env?.CHANT_COSIGN !== undefined) return [];
  if (forge === "gitlab") return [{ run: `${toolInstallLine(TOOL_PINS.cosign, RELEASE_RUNNER_PLATFORM, "/tmp")} && export CHANT_COSIGN=/tmp/cosign` }];
  return [{ name: `Install cosign ${TOOL_PINS.cosign.version}`, run: `${toolInstallLine(TOOL_PINS.cosign, RELEASE_RUNNER_PLATFORM, "$RUNNER_TEMP")} && echo "CHANT_COSIGN=$RUNNER_TEMP/cosign" >> "$GITHUB_ENV"` }];
}

/** The flags `chant release publish` gets under the groups. */
export function publishFlags(groups: ReadonlySet<SecurityGroup>): string[] {
  return [...(groups.has("supply-chain") ? ["--require-provenance"] : []), "--yes"];
}

/** Where `chant release images` writes the digests the publish job's build reads (#4657), by default and at a workstation. */
export const RELEASE_DIGESTS_FILE = ".chant/release-digests.json";

/**
 * Where a generated publish job writes the digests: the runner's temp
 * directory, outside the checkout, so `chant release publish` finds the tree
 * as the cut left it (#4853). A repository that commits files under `.chant/`
 * can't ignore the directory, and a digests file there made the publish
 * refuse with `release-worktree-dirty`.
 */
export const RELEASE_DIGESTS_PATHS: Record<ReleaseWorkflowForge, string> = {
  github: "$RUNNER_TEMP/chant-release-digests.json",
  forgejo: "$RUNNER_TEMP/chant-release-digests.json",
  gitlab: "/tmp/chant-release-digests.json",
};

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
  const verify = input.groups.has("verified-releases");
  const flags = publishFlags(input.groups).join(" ");
  const after = p.after ?? [];
  const images = input.images === true;
  const version = input.version === true;
  // #5152: the toolchains each job sets up, and the per-platform builds.
  const files = new Set(input.projectFiles ?? (p.toolchains === undefined ? ["package.json"] : []));
  if (input.forge === "gitlab" && p.toolchains && p.toolchains.some((t) => (typeof t === "string" ? t : t.name) !== "node")) {
    throw new Error("release.workflow.toolchains: a GitLab job runs in its runner's image, which brings the toolchain; name the image in .gitlab-ci.yml (default: image:) and leave toolchains out");
  }
  const chantSetup = toolchainLines(resolveToolchains(p.toolchains === false ? false : (p.toolchains ?? []).filter((t) => (typeof t === "string" ? t : t.name) === "node"), new Set(), root, p.toolchains !== false));
  const fullSetup = toolchainLines(resolveToolchains(p.toolchains, files, root, true));
  const builds = p.builds ?? [];
  if (builds.length > 0) {
    if (p.trigger !== "dispatch") throw new Error('release.workflow.builds: the tag trigger publishes a release cut before the workflow ran, so nothing built here would be in it; use trigger: "dispatch"');
    checkBuilds(builds);
  }
  const artifacts = input.artifacts === true;
  const goreleaser = artifacts && input.goreleaser === true ? goreleaserSetup(input.forge, root, p) : { github: [], gitlab: [] };
  // #4786: the targets' own needs first, then the config's, so a config that set them by hand renders the same file without them.
  const derived = targetExtras(input.forge, input.publish ?? [], p);
  // #5149: the cut asks the forge for the commit's checks with the run's token.
  const green = input.green ?? "chant";
  if (green === "forge-checks" && p.trigger === "dispatch" && input.forge === "github") {
    const reads = Object.fromEntries((["checks", "statuses"] as const).filter((k) => p.permissions?.[k] === undefined).map((k) => [k, "read" as const]));
    if (Object.keys(reads).length > 0) derived.permissions = { ...derived.permissions, ...reads };
  }
  // #4876: QEMU before the config's setup, where the products named it.
  const qemu = images ? qemuSetup(input.forge, input.imagePlatforms ?? [], p) : [];
  // #5164: cosign after the config's setup, so a config that installs its own is left alone. It goes in the jobs that run chant release (the cut, whose doctor checks it, and the publish, which signs), never in a per-platform build job.
  const cosign = input.signing === true ? cosignSetup(input.forge, p) : [];
  const extra = jobExtras(
    {
      ...p,
      ...(derived.permissions ? { permissions: { ...p.permissions, ...derived.permissions } } : {}),
      ...(derived.env ? { env: { ...p.env, ...derived.env } } : {}),
      ...(derived.setup || qemu.length > 0 || cosign.length > 0 ? { setup: [...qemu, ...(p.setup ?? []), ...(derived.setup ?? []), ...cosign] } : {}),
    },
    input.forge,
  );
  // #4767: Forgejo's job token is not a GitHub token, and GitLab has no such expression.
  const forgeToken =
    input.forge === "github" && p.env?.GITHUB_TOKEN === undefined && (input.publish ?? []).some((t) => t.type === "forge" && t.forge === "github" && !t.tokenEnv)
      ? ["      GITHUB_TOKEN: ${{ github.token }}"]
      : [];
  if (p.trigger === "dispatch") {
    const archives = images ? (input.imageArchives ?? []).map((a) => (root ? `${root}/${a.replace(/^\.\//, "")}` : a.replace(/^\.\//, ""))) : [];
    const cutToken = green === "forge-checks" && input.forge !== "gitlab" && p.env?.GITHUB_TOKEN === undefined ? ["      GITHUB_TOKEN: ${{ github.token }}"] : [];
    const buildJobs = builds.map((b) => ({ ...b, setup: toolchainLines(resolveToolchains(b.toolchains !== undefined ? b.toolchains : p.toolchains, files, root, false)) }));
    if (input.forge === "gitlab" && builds.some((b) => b.toolchains && b.toolchains.length > 0)) throw new Error("release.workflow.builds: toolchains: a GitLab job runs in its runner's image, which brings the toolchain; leave toolchains out");
    const o = { chant, install, chantSetup, fullSetup, builds: buildJobs, build, root, verify, flags, after, images, version, archives, artifacts, goreleaser, forge: input.forge, extra, forgeToken, cutToken, green, doctor: p.doctor !== false, signing: input.signing === true, gate: p.gate ?? "last-green", ...(input.lane ? { lane: input.lane } : {}) };
    return input.forge === "gitlab" ? renderGitlabDispatch(o) : renderGithubDispatch(o);
  }
  // #5150: a release.tag template triggers on its own tags.
  if (input.tags && !input.tags.template.legacy) {
    return renderTemplatedTagWorkflow(input, { chant, install, fullSetup, build, root, verify, flags, after, images, version, extra, forgeToken, doctor: p.doctor === true, artifacts, goreleaser, tags: input.tags });
  }
  // #4657: the images are built from the release, so chant/lifecycle is fetched before them and the build after.
  const digests = RELEASE_DIGESTS_PATHS[input.forge];
  const imageLines = (label: string, env: string): string[] => [`${chant} release images ${label} -o "${digests}"`, env];
  if (input.forge === "gitlab") {
    const label = '"${CI_COMMIT_TAG#release/}"';
    const fetches = ["    - git fetch origin 'refs/tags/ci/*:refs/tags/ci/*'", "    - git fetch origin chant/lifecycle:chant/lifecycle"];
    const lines = [
      "chant-release-publish:",
      "  rules:",
      "    - if: $CI_COMMIT_TAG =~ /^release\\//",
      "  id_tokens:",
      "    SIGSTORE_ID_TOKEN:",
      "      aud: sigstore",
      ...(extra.gitlabVariables.length > 0 ? ["  variables:", ...extra.gitlabVariables] : []),
      "  script:",
      ...(root ? [`    - cd ${root}`] : []),
      ...(install ? [`    - ${install}`] : []),
      ...extra.gitlabScript.map((l) => `    - ${l}`),
      ...(p.doctor === true ? [`    - ${chant} release doctor`] : []),
      ...goreleaser.gitlab.map((l) => `    - ${JSON.stringify(l)}`),
      ...(version ? [`    - ${chant} release stamp ${label}`] : []),
      ...(images || artifacts ? fetches : []),
      ...(images ? imageLines(label, `export CHANT_RELEASE_DIGESTS="${digests}"`).map((l) => `    - ${l}`) : []),
      ...(artifacts ? [`    - ${chant} release artifacts ${label}`] : []),
      ...(build ? [`    - ${build}`] : []),
      ...(images || artifacts ? [] : fetches),
      ...(verify ? [`    - ${chant} release verify ${label}`] : []),
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
  const lines = [
    "name: chant release publish",
    "on:",
    "  push:",
    '    tags: ["release/**"]',
    "permissions:",
    "  contents: write",
    "  id-token: write",
    ...extra.permissions,
    "jobs:",
    "  publish:",
    "    runs-on: ubuntu-latest",
    ...(root ? ["    defaults:", "      run:", `        working-directory: ${root}`] : []),
    ...extra.githubEnv(forgeToken),
    "    steps:",
    ...githubSetup(undefined, fullSetup),
    ...(install ? [`      - run: ${install}`] : []),
    ...extra.githubSteps,
    ...(p.doctor === true ? [`      - run: ${chant} release doctor`] : []),
    ...goreleaser.github,
    ...(version ? [`      - run: ${chant} release stamp ${label}`] : []),
    ...(images || artifacts ? fetches : []),
    ...(images ? imageLines(label, `echo "CHANT_RELEASE_DIGESTS=${digests}" >> "$GITHUB_ENV"`).map((l) => `      - run: ${l}`) : []),
    ...(artifacts ? [`      - run: ${chant} release artifacts ${label}`] : []),
    ...(build ? [`      - run: ${build}`] : []),
    ...(images || artifacts ? [] : fetches),
    ...(verify ? [`      - run: ${chant} release verify ${label}`] : []),
    `      - run: ${chant} release publish ${label} ${flags}`,
  ];
  if (after.length > 0) {
    lines.push(
      "  after-release:",
      "    needs: publish",
      "    runs-on: ubuntu-latest",
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
  chant: string;
  install: string | null;
  /** The toolchain steps of the publish and after-release jobs (#5152). */
  fullSetup: string[];
  build: string | null;
  root: string | null;
  verify: boolean;
  flags: string;
  after: string[];
  images: boolean;
  version: boolean;
  extra: JobExtras;
  forgeToken: string[];
  /** `chant release doctor` before the stamp and build, under `doctor: true` (#5161). */
  doctor: boolean;
  /** `release.artifacts` (#5151): built again and checked after the build. */
  artifacts: boolean;
  goreleaser: { github: string[]; gitlab: string[] };
  tags: MemberTags;
}

/**
 * The tag-triggered publish workflow for a `release.tag` template (#5150).
 * It runs on the template's tags, fetches `chant/lifecycle` first, and
 * reads the release's label from the ledger with `chant release tag`, since
 * a tag is the label's rendering and is never parsed.
 */
function renderTemplatedTagWorkflow(input: ReleaseWorkflowInput, o: TemplatedInput): string {
  const { chant, install, fullSetup, build, root, verify, flags, after, images, version, extra, forgeToken } = o;
  const filters = releaseTagFilters(o.tags);
  const digests = RELEASE_DIGESTS_PATHS[input.forge];
  const label = '"$CHANT_RELEASE_LABEL"';
  const ciFetch = "git fetch origin 'refs/tags/ci/*:refs/tags/ci/*'";
  const ledgerFetch = "git fetch origin chant/lifecycle:chant/lifecycle";
  if (input.forge === "gitlab") {
    const q = (l: string) => `    - ${JSON.stringify(l)}`;
    const labelLines = [ledgerFetch, ...labelOfRefScript(chant, "$CI_COMMIT_TAG"), 'export CHANT_RELEASE_LABEL="$label"'];
    const lines = [
      "chant-release-publish:",
      "  rules:",
      `    - if: ${filters.gitlabRule}`,
      "  id_tokens:",
      "    SIGSTORE_ID_TOKEN:",
      "      aud: sigstore",
      ...(extra.gitlabVariables.length > 0 ? ["  variables:", ...extra.gitlabVariables] : []),
      "  script:",
      ...(root ? [q(`cd ${root}`)] : []),
      ...(install ? [q(install)] : []),
      ...extra.gitlabScript.map(q),
      ...labelLines.map(q),
      ...(o.doctor ? [q(`${chant} release doctor`)] : []),
      ...o.goreleaser.gitlab.map((l) => `    - ${JSON.stringify(l)}`),
      ...(version ? [q(`${chant} release stamp ${label}`)] : []),
      ...(images || o.artifacts ? [q(ciFetch)] : []),
      ...(images ? [`${chant} release images ${label} -o "${digests}"`, `export CHANT_RELEASE_DIGESTS="${digests}"`].map(q) : []),
      ...(o.artifacts ? [q(`${chant} release artifacts ${label}`)] : []),
      ...(build ? [q(build)] : []),
      ...(images || o.artifacts ? [] : [q(ciFetch)]),
      ...(verify ? [q(`${chant} release verify ${label}`)] : []),
      q(`${chant} release publish ${label} ${flags}`),
    ];
    if (after.length > 0) {
      lines.push("", "chant-release-after:", "  rules:", `    - if: ${filters.gitlabRule}`, "  needs: [chant-release-publish]", "  script:", ...(root ? [q(`cd ${root}`)] : []), ...(install ? [q(install)] : []), ...labelLines.map(q), ...after.map((l) => `    - ${l}`));
    }
    return `${lines.join("\n")}\n`;
  }
  const run = (l: string) => `      - run: ${l}`;
  const lines = [
    "name: chant release publish",
    "on:",
    "  push:",
    `    tags: [${filters.globs.map((g) => JSON.stringify(g)).join(", ")}]`,
    "permissions:",
    "  contents: write",
    "  id-token: write",
    ...extra.permissions,
    "jobs:",
    "  publish:",
    "    runs-on: ubuntu-latest",
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
    ...(o.doctor ? [run(`${chant} release doctor`)] : []),
    ...o.goreleaser.github,
    ...(version ? [run(`${chant} release stamp ${label}`)] : []),
    ...(images || o.artifacts ? [run(ciFetch)] : []),
    ...(images ? [run(`${chant} release images ${label} -o "${digests}"`), run(`echo "CHANT_RELEASE_DIGESTS=${digests}" >> "$GITHUB_ENV"`)] : []),
    ...(o.artifacts ? [run(`${chant} release artifacts ${label}`)] : []),
    ...(build ? [run(build)] : []),
    ...(images || o.artifacts ? [] : [run(ciFetch)]),
    ...(verify ? [run(`${chant} release verify ${label}`)] : []),
    run(`${chant} release publish ${label} ${flags}`),
  ];
  if (after.length > 0) {
    lines.push(
      "  after-release:",
      "    needs: publish",
      "    runs-on: ubuntu-latest",
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

interface JobExtras {
  /** Lines added under the workflow's `permissions:`. */
  permissions: string[];
  /** The job's `env:` block with `base` entries first, or nothing when there is neither. */
  githubEnv: (base: string[]) => string[];
  /** Steps after the install. */
  githubSteps: string[];
  /** GitLab: the job's `variables:` entries, under a `variables:` key of their own. */
  gitlabVariables: string[];
  /** GitLab: script lines after the install. */
  gitlabScript: string[];
}

/** `release.workflow`'s `permissions`, `env` and `setup` (#4751) as lines of the forge's file. Empty for a config without them, so its file is what it was. */
function jobExtras(p: ReleasePipelineConfig, forge: ReleaseWorkflowForge): JobExtras {
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
    permissions: permissions.map(([k, v]) => `  ${k}: ${v}`),
    githubEnv: (base) => (base.length + env.length > 0 ? ["    env:", ...base, ...map("      ", env)] : []),
    githubSteps,
    gitlabVariables: map("    ", env),
    gitlabScript: setup.flatMap((s) => ("uses" in s ? [] : [...Object.entries(s.env ?? {}).map(([k, v]) => `export ${k}=${q(v)}`), s.run])),
  };
}

/** The checkout and toolchain setup a GitHub or Forgejo job starts with (#5152); `ref` checks out that commit. */
function githubSetup(ref: string | undefined, setup: readonly string[], persist = true): string[] {
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
  chant: string;
  install: string | null;
  /** The toolchain steps of the gate (Node, for chant) and of the jobs that build (#5152). */
  chantSetup: string[];
  fullSetup: string[];
  /** The per-platform builds (#5152), each with its toolchain steps. */
  builds: Array<ReleaseBuildConfig & { setup: string[] }>;
  build: string | null;
  root: string | null;
  verify: boolean;
  flags: string;
  after: string[];
  images: boolean;
  /** `release.version` (#4840): the publish job stamps the label before the images and the build. */
  version: boolean;
  /** The image archives the cut hands to the publish job, from the repository root. Empty: the publish job builds them again. */
  archives: string[];
  /** `release.artifacts` (#5151): the cut job stages the files and the publish job checks them. */
  artifacts: boolean;
  /** The goreleaser setup of the cut job (#5151), as GitHub steps and GitLab script lines. */
  goreleaser: { github: string[]; gitlab: string[] };
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
  /** The publish signs with Sigstore (#5164). The doctor in the GitLab cut job then gets the publish job's `SIGSTORE_ID_TOKEN`, so it can check that signing will work. */
  signing: boolean;
}

/** The cut job's token lines: `forge-checks`' (#5149) and, when the doctor runs there (#5161), the publish job's forge token, once. */
function cutEnvToken(o: DispatchInput): string[] {
  return [...new Set([...o.cutToken, ...(o.doctor ? o.forgeToken : [])])];
}

/** The workflow artifact the cut job hands its image archives on in. */
export const RELEASE_IMAGES_ARTIFACT = "chant-release-images";

/** The directory every path is under, which the artifact actions store the files relative to. */
function commonDir(paths: readonly string[]): string {
  const dirs = paths.map((p) => p.split("/").slice(0, -1));
  const first = dirs[0] ?? [];
  let n = 0;
  while (n < first.length && dirs.every((d) => d[n] === first[n])) n++;
  return first.slice(0, n).join("/") || ".";
}

/** The `release images` line of a publish job: checking the archives handed on, or building them again. */
function imagesLine(o: DispatchInput): string {
  return `${o.chant} release images "$CHANT_RELEASE_LABEL"${o.archives.length > 0 ? " --no-build" : ""} -o "${RELEASE_DIGESTS_PATHS[o.forge]}"`;
}

/** The publish job's `release stamp` line (#4840). */
function stampLine(o: DispatchInput): string {
  return `${o.chant} release stamp "$CHANT_RELEASE_LABEL"`;
}

/** The node one-liner that prints a JSON document's field from stdin, or from the file its argument names. */
const field = (path: string): string =>
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
function gateScript(o: DispatchInput, dispatched: string): string[] {
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
const LEDGER_FETCH_FIRST =
  'rc=0; git ls-remote --exit-code --heads origin chant/lifecycle >/dev/null || rc=$?; if [ "$rc" = 0 ]; then git fetch origin chant/lifecycle:chant/lifecycle; elif [ "$rc" != 2 ]; then exit "$rc"; fi';

/** The shell line that packs a build job's outputs into its archive (#5152): tar keeps each file's path and mode, which an upload of the files would not. */
function packLine(b: ReleaseBuildConfig): string {
  return `tar -cf ${releaseBuildArchive(b.name)} -- ${b.outputs.join(" ")}`;
}

/**
 * The shell line that unpacks a build's archive into the project root (#5152).
 * In the cut, `-k` refuses a file that is already there, so a build cannot
 * replace a file of the commit, and two builds cannot write one path.
 */
function unpackLine(archive: string, cut: boolean): string {
  return `tar -x${cut ? "k" : ""}f ${archive}`;
}

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
  const download = usesRef(o.forge === "forgejo" ? ACTION_PINS.downloadArtifact3 : ACTION_PINS.downloadArtifact4);
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
  const restore = (cut: boolean): string[] =>
    o.builds.flatMap((b) => [
      `      - uses: ${download}`,
      "        with:",
      `          name: ${releaseBuildArtifact(b.name)}`,
      "          path: ${{ runner.temp }}/chant-release-builds",
      `      - run: ${unpackLine(`"$RUNNER_TEMP/chant-release-builds/${releaseBuildArchive(b.name)}"`, cut)}`,
    ]);
  const built = o.builds.map((b) => `build-${b.name}`);
  const lines = [
    "name: chant release",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      label:",
    "        description: The release's label, such as v1.4.0, or auto for the one chant release next computes",
    "        required: true",
    "        type: string",
    "permissions:",
    "  contents: write",
    "  id-token: write",
    ...o.extra.permissions,
    "concurrency:",
    "  group: chant-release",
    "  cancel-in-progress: false",
    "env:",
    "  CHANT_RELEASE_LABEL: ${{ inputs.label }}",
    "jobs:",
    "  gate:",
    "    runs-on: ubuntu-latest",
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
    ...defaults,
    ...o.extra.githubEnv([`      CHANT_RELEASE_COMMIT: ${commit}`, `      CHANT_RELEASE_LABEL: ${GATE_LABEL}`, ...cutEnvToken(o)]),
    "    steps:",
    ...githubSetup(commit, o.fullSetup),
    ...installLines,
    ...o.extra.githubSteps,
    ...(o.doctor ? [`      - run: ${o.chant} release doctor`] : []),
    ...o.goreleaser.github,
    fetches[0]!,
    `      - run: ${LEDGER_FETCH_FIRST}`,
    ...restore(true),
    ...block(cutScript(o, '"$RUNNER_TEMP/chant-cut.json"')),
    ...(o.artifacts
      ? [
          `      - run: ${o.chant} release artifacts "$CHANT_RELEASE_LABEL" --no-build -o "${RELEASE_ARTIFACTS_STAGE[o.forge]}"`,
          `      - uses: ${usesRef(o.forge === "forgejo" ? ACTION_PINS.uploadArtifact3 : ACTION_PINS.uploadArtifact4)}`,
          "        with:",
          `          name: ${RELEASE_ARTIFACTS_ARTIFACT}`,
          "          path: ${{ runner.temp }}/chant-release-artifacts",
          "          if-no-files-found: error",
          "          retention-days: 1",
        ]
      : []),
    ...(o.archives.length > 0
      ? [
          `      - uses: ${upload}`,
          "        with:",
          `          name: ${RELEASE_IMAGES_ARTIFACT}`,
          "          path: |",
          ...o.archives.map((a) => `            ${a}`),
          "          if-no-files-found: error",
          "          retention-days: 1",
        ]
      : []),
    "  publish:",
    `    needs: [gate, cut${built.map((b) => `, ${b}`).join("")}]`,
    "    runs-on: ubuntu-latest",
    ...defaults,
    ...o.extra.githubEnv([`      CHANT_RELEASE_LABEL: ${GATE_LABEL}`, ...o.forgeToken]),
    "    steps:",
    ...githubSetup(commit, o.fullSetup),
    ...installLines,
    ...o.extra.githubSteps,
    ...fetches,
    ...(o.archives.length > 0 ? [`      - uses: ${download}`, "        with:", `          name: ${RELEASE_IMAGES_ARTIFACT}`, `          path: ${commonDir(o.archives)}`] : []),
    ...restore(false),
    ...(o.version ? [`      - run: ${stampLine(o)}`] : []),
    ...(o.images ? [`      - run: ${imagesLine(o)}`, `      - run: echo "CHANT_RELEASE_DIGESTS=${RELEASE_DIGESTS_PATHS[o.forge]}" >> "$GITHUB_ENV"`] : []),
    ...(o.artifacts
      ? [`      - uses: ${usesRef(o.forge === "forgejo" ? ACTION_PINS.downloadArtifact3 : ACTION_PINS.downloadArtifact4)}`, "        with:", `          name: ${RELEASE_ARTIFACTS_ARTIFACT}`, "          path: ${{ runner.temp }}/chant-release-artifacts"]
      : []),
    ...(o.build ? [`      - run: ${o.build}`] : []),
    ...(o.artifacts ? [`      - run: ${o.chant} release artifacts "$CHANT_RELEASE_LABEL" --from "${RELEASE_ARTIFACTS_STAGE[o.forge]}"`] : []),
    ...(o.verify ? [`      - run: ${o.chant} release verify "$CHANT_RELEASE_LABEL"`] : []),
    `      - run: ${o.chant} release publish "$CHANT_RELEASE_LABEL" ${o.flags}`,
  ];
  if (o.after.length > 0) {
    lines.push("  after-release:", "    needs: [gate, publish]", "    runs-on: ubuntu-latest", ...defaults, "    env:", `      CHANT_RELEASE_LABEL: ${GATE_LABEL}`, "    steps:", ...githubSetup(commit, o.fullSetup), ...installLines, ...o.after.map((l) => `      - run: ${l}`));
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
  const job = (name: string, needs: string[], script: string[], extra: string[] = [], vars: string[] = []): string[] => [
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
    ...(needs.length > 0 ? ['export CHANT_RELEASE_LABEL="$CHANT_RELEASE_NEXT"'] : []).concat(script).map((l) => `    - ${JSON.stringify(l)}`),
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
  // Unpacked, then moved out of the checkout, so the publish finds the tree as the cut left it.
  const restore = (cut: boolean): string[] => o.builds.flatMap((b) => [unpackLine(releaseBuildArchive(b.name), cut), `mv ${releaseBuildArchive(b.name)} /tmp/`]);
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
        ...o.goreleaser.gitlab,
        fetches[0]!,
        ...auth,
        LEDGER_FETCH_FIRST,
        ...restore(true),
        ...(o.green === "forge-checks" ? ['export CHANT_GITLAB_TOKEN="${CHANT_GITLAB_TOKEN:-$CHANT_RELEASE_TOKEN}"'] : []),
        ...(o.doctor ? [`${o.chant} release doctor`] : []),
        ...cutScript(o, "/tmp/chant-cut.json"),
        ...(o.artifacts ? [`${o.chant} release artifacts "$CHANT_RELEASE_LABEL" --no-build -o "${RELEASE_ARTIFACTS_STAGE.gitlab}"`] : []),
      ],
      [
        ...(o.archives.length > 0 || o.artifacts ? ["  artifacts:", "    paths:", ...o.archives.map((a) => `      - ${JSON.stringify(a)}`), ...(o.artifacts ? ['      - ".chant-release-artifacts/"'] : []), "    expire_in: 1 day"] : []),
        // #5164: the doctor checks the token the publish will sign with.
        ...(o.signing && o.doctor ? ["  id_tokens:", "    SIGSTORE_ID_TOKEN:", "      aud: sigstore"] : []),
      ],
      o.extra.gitlabVariables,
    ),
    "",
    ...job(
      "chant-release-publish",
      ["chant-release-gate", "chant-release-cut", ...built],
      [
        ...checkout,
        // #5151: the staged files leave the checkout, which the publish finds as the cut left it.
        ...(o.artifacts ? ['mv "$CI_PROJECT_DIR/.chant-release-artifacts" /tmp/chant-release-artifacts'] : []),
        ...cd,
        ...install,
        ...o.extra.gitlabScript,
        ...fetches,
        ...auth,
        ...restore(false),
        ...(o.version ? [stampLine(o)] : []),
        ...(o.images ? [imagesLine(o), `export CHANT_RELEASE_DIGESTS="${RELEASE_DIGESTS_PATHS.gitlab}"`] : []),
        ...(o.build ? [o.build] : []),
        ...(o.artifacts ? [`${o.chant} release artifacts "$CHANT_RELEASE_LABEL" --from /tmp/chant-release-artifacts`] : []),
        ...(o.verify ? [`${o.chant} release verify "$CHANT_RELEASE_LABEL"`] : []),
        `${o.chant} release publish "$CHANT_RELEASE_LABEL" ${o.flags}`,
      ],
      ["  id_tokens:", "    SIGSTORE_ID_TOKEN:", "      aud: sigstore"],
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
  const usage = "chant release workflow [--forge github|gitlab|forgejo] [--install <command>] [--build <command>] [--chant <command>] [--output <file>]";
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
  const { resolveSigning } = await import("../lifecycle/publish-signing");
  const signs = resolveSigning(release?.signing, groups).on && (release?.publish ?? []).some((t) => t.type === "oci" || t.type === "forge" || t.type === "pypi");
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
    ...((release?.images?.length ?? 0) > 0 ? { images: true, imageArchives: resolveReleaseImages(release!.images!).map((i) => i.archive), imagePlatforms: releaseImagePlatforms(release!.images!) } : {}),
    ...((release?.artifacts?.length ?? 0) > 0 ? { artifacts: true, ...((await import("../lifecycle/release-artifacts")).usesGoreleaser(release!.artifacts!) ? { goreleaser: true } : {}) } : {}),
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
    ...(release?.publish ? { publish: release.publish } : {}),
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
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, releaseWorkflowHeader(parts.map(shellArg).join(" ")) + text);
  const shown = relative(process.cwd(), target).split(sep).join("/") || target;
  const extras = [groups.has("supply-chain") ? "requires OIDC provenance (supply-chain)" : null, groups.has("verified-releases") ? "verifies the release first (verified-releases)" : null, signs ? `signs with Sigstore, with cosign ${TOOL_PINS.cosign.version} pinned by SHA-256` : null].filter(Boolean);
  const what =
    release?.workflow?.trigger === "dispatch"
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
  return 0;
}
