/**
 * `chant release workflow` (#4168 step 6): the publish workflow, generated
 * the way `chant ci workflow` writes the tick, where the guides used to have
 * one pasted (guide/release-from-workstation.mdx).
 *
 * The job runs on a `release/**` tag, checks the tag out, fetches the ci tags
 * and `chant/lifecycle`, builds what the targets upload, and runs `chant
 * release publish` for the label the tag names. The security groups decide
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
 */
import { ACTION_PINS, tagComments, usesRef } from "../action-pins";
import { releaseImagePlatforms, resolveReleaseImages } from "../lifecycle/release-images";
import { GENERATED_MARKER } from "../discovery/files";
import type { SecurityGroup } from "./security";
import type { OpSetupStep } from "../lexicon";

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
  /** `tag` (default): the publish job runs on a `release/**` tag. `dispatch`: the whole release starts by hand with a label. */
  trigger?: "tag" | "dispatch";
  /** For `dispatch`: the commit to cut. `last-green` (default) is the newest green commit at or below the dispatched one; `head` is the dispatched commit, which must be green. */
  gate?: "last-green" | "head";
  /** The command that installs what the build needs. Default `npm ci`. */
  install?: string;
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
  /** Where the workflow is written, from the repository root, such as `.github/workflows/publish.yml` for an npm trusted publisher that names that file. Default {@link RELEASE_WORKFLOW_FILES}. */
  file?: string;
}

export interface ReleaseWorkflowInput {
  forge: ReleaseWorkflowForge;
  /** The security groups the workspace opts into at its root. */
  groups: ReadonlySet<SecurityGroup>;
  /** The command that installs what the build needs. Default `npm ci`. */
  install?: string;
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

/** The binfmt image a GitLab job installs QEMU's handlers with (#4876). */
export const RELEASE_BINFMT_IMAGE = "tonistiigi/binfmt";

/** The architectures among `platforms` the runner can't run, as QEMU names them (`linux/arm/v7` is `arm`), each once. */
export function qemuArchitectures(platforms: readonly string[]): string[] {
  return [...new Set(platforms.filter((p) => p.split("/").slice(0, 2).join("/") !== RELEASE_RUNNER_PLATFORM).map((p) => p.split("/")[1] ?? p))].sort();
}

/**
 * QEMU's binfmt setup for the platforms `release.images` builds that the
 * runner can't, such as `linux/arm64` on an amd64 runner (#4876), so no
 * product names it in `release.workflow.setup`. GitHub and Forgejo get
 * `docker/setup-qemu-action` at its pin; GitLab a `docker run --privileged`
 * of {@link RELEASE_BINFMT_IMAGE}, which `chant release workflow` notes needs
 * an executor that runs privileged containers. A config whose `setup` names
 * the action or the binfmt image already gets nothing more, so its file
 * renders as it did.
 */
export function qemuSetup(forge: ReleaseWorkflowForge, platforms: readonly string[], p: ReleasePipelineConfig): OpSetupStep[] {
  const archs = qemuArchitectures(platforms);
  if (archs.length === 0) return [];
  const named = (p.setup ?? []).some((s) => ("uses" in s ? /^docker\/setup-qemu-action@/.test(s.uses) : s.run.includes(RELEASE_BINFMT_IMAGE)));
  if (named) return [];
  return forge === "gitlab" ? [{ run: `docker run --privileged --rm ${RELEASE_BINFMT_IMAGE} --install ${archs.join(",")}` }] : [{ uses: usesRef(ACTION_PINS.dockerSetupQemu4), with: { platforms: archs.join(",") } }];
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
  const install = input.install ?? p.install ?? "npm ci";
  const build = input.build !== undefined ? input.build : p.build === false ? null : (p.build ?? "npm run build");
  const root = input.workspaceRoot && input.workspaceRoot !== "." ? input.workspaceRoot : null;
  const verify = input.groups.has("verified-releases");
  const flags = publishFlags(input.groups).join(" ");
  const after = p.after ?? [];
  const images = input.images === true;
  const version = input.version === true;
  // #4786: the targets' own needs first, then the config's, so a config that set them by hand renders the same file without them.
  const derived = targetExtras(input.forge, input.publish ?? [], p);
  // #4876: QEMU before the config's setup, where the products named it.
  const qemu = images ? qemuSetup(input.forge, input.imagePlatforms ?? [], p) : [];
  const extra = jobExtras(
    {
      ...p,
      ...(derived.permissions ? { permissions: { ...p.permissions, ...derived.permissions } } : {}),
      ...(derived.env ? { env: { ...p.env, ...derived.env } } : {}),
      ...(derived.setup || qemu.length > 0 ? { setup: [...qemu, ...(p.setup ?? []), ...(derived.setup ?? [])] } : {}),
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
    const o = { chant, install, build, root, verify, flags, after, images, version, archives, forge: input.forge, extra, forgeToken, gate: p.gate ?? "last-green", ...(input.lane ? { lane: input.lane } : {}) };
    return input.forge === "gitlab" ? renderGitlabDispatch(o) : renderGithubDispatch(o);
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
      `    - ${install}`,
      ...extra.gitlabScript.map((l) => `    - ${l}`),
      ...(version ? [`    - ${chant} release stamp ${label}`] : []),
      ...(images ? [...fetches, ...imageLines(label, `export CHANT_RELEASE_DIGESTS="${digests}"`).map((l) => `    - ${l}`)] : []),
      ...(build ? [`    - ${build}`] : []),
      ...(images ? [] : fetches),
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
        `    - ${install}`,
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
    ...githubSetup(),
    `      - run: ${install}`,
    ...extra.githubSteps,
    ...(version ? [`      - run: ${chant} release stamp ${label}`] : []),
    ...(images ? [...fetches, ...imageLines(label, `echo "CHANT_RELEASE_DIGESTS=${digests}" >> "$GITHUB_ENV"`).map((l) => `      - run: ${l}`)] : []),
    ...(build ? [`      - run: ${build}`] : []),
    ...(images ? [] : fetches),
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
      ...githubSetup(),
      '      - run: echo "CHANT_RELEASE_LABEL=${GITHUB_REF_NAME#release/}" >> "$GITHUB_ENV"',
      `      - run: ${install}`,
      ...after.map((l) => `      - run: ${l}`),
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
  }
  const q = (v: string | number | boolean): string => JSON.stringify(v);
  const map = (indent: string, entries: Array<[string, string | number | boolean]>): string[] => entries.map(([k, v]) => `${indent}${k}: ${q(v)}`);
  const githubSteps = setup.flatMap((s) => [
    "uses" in s ? `      - uses: ${s.uses}` : `      - run: ${q(s.run)}`,
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

/** The checkout and node setup a GitHub or Forgejo job starts with; `ref` checks out that commit. */
function githubSetup(ref?: string): string[] {
  return [
    `      - uses: ${usesRef(ACTION_PINS.checkout4)}`,
    "        with:",
    ...(ref ? [`          ref: ${ref}`] : []),
    "          fetch-depth: 0",
    `      - uses: ${usesRef(ACTION_PINS.setupNode4)}`,
    "        with:",
    "          node-version: 24",
    "          registry-url: https://registry.npmjs.org",
  ];
}

interface DispatchInput {
  chant: string;
  install: string;
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
  forge: ReleaseWorkflowForge;
  gate: "last-green" | "head";
  lane?: string;
  extra: JobExtras;
  /** The publish job's `GITHUB_TOKEN` line for a GitHub forge target (#4767), or nothing. */
  forgeToken: string[];
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
  return [
    `commit="$(${o.chant} ci last-green --from "${dispatched}"${o.lane ? ` --lane ${o.lane}` : ""} --json | ${field("d.commit?.sha")})"`,
    `if [ -z "$commit" ]; then echo "no green commit at or below ${dispatched}, so no release is cut" >&2; exit 1; fi`,
    ...(o.gate === "head" ? [`if [ "$commit" != "${dispatched}" ]; then echo "${dispatched} is not green (the newest green commit below it is $commit), so no release is cut" >&2; exit 1; fi`] : []),
    ...(o.forge === "github" && o.gate !== "head" ? workflowFilesCheck(dispatched) : []),
  ];
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

/** GitHub and Forgejo: the release started by hand with a label (#4656). */
function renderGithubDispatch(o: DispatchInput): string {
  const defaults = o.root ? ["    defaults:", "      run:", `        working-directory: ${o.root}`] : [];
  const commit = "${{ needs.gate.outputs.commit }}";
  const fetches = ["      - run: git fetch origin 'refs/tags/ci/*:refs/tags/ci/*'", "      - run: git fetch origin chant/lifecycle:chant/lifecycle"];
  const block = (lines: string[]): string[] => ["      - run: |", ...lines.map((l) => `          ${l}`)];
  const lines = [
    "name: chant release",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      label:",
    "        description: The release's label, such as v1.4.0",
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
    "    steps:",
    ...githubSetup(),
    `      - run: ${o.install}`,
    fetches[0]!,
    "      - id: green",
    "        run: |",
    ...[...gateScript(o, "$GITHUB_SHA"), 'echo "commit=$commit" >> "$GITHUB_OUTPUT"'].map((l) => `          ${l}`),
    "  cut:",
    "    needs: gate",
    "    runs-on: ubuntu-latest",
    ...defaults,
    ...o.extra.githubEnv([`      CHANT_RELEASE_COMMIT: ${commit}`]),
    "    steps:",
    ...githubSetup(commit),
    `      - run: ${o.install}`,
    ...o.extra.githubSteps,
    fetches[0]!,
    `      - run: ${LEDGER_FETCH_FIRST}`,
    ...block(cutScript(o, '"$RUNNER_TEMP/chant-cut.json"')),
    ...(o.archives.length > 0
      ? [
          `      - uses: ${usesRef(o.forge === "forgejo" ? ACTION_PINS.uploadArtifact3 : ACTION_PINS.uploadArtifact4)}`,
          "        with:",
          `          name: ${RELEASE_IMAGES_ARTIFACT}`,
          "          path: |",
          ...o.archives.map((a) => `            ${a}`),
          "          if-no-files-found: error",
          "          retention-days: 1",
        ]
      : []),
    "  publish:",
    "    needs: [gate, cut]",
    "    runs-on: ubuntu-latest",
    ...defaults,
    ...o.extra.githubEnv(o.forgeToken),
    "    steps:",
    ...githubSetup(commit),
    `      - run: ${o.install}`,
    ...o.extra.githubSteps,
    ...fetches,
    ...(o.archives.length > 0
      ? [`      - uses: ${usesRef(o.forge === "forgejo" ? ACTION_PINS.downloadArtifact3 : ACTION_PINS.downloadArtifact4)}`, "        with:", `          name: ${RELEASE_IMAGES_ARTIFACT}`, `          path: ${commonDir(o.archives)}`]
      : []),
    ...(o.version ? [`      - run: ${stampLine(o)}`] : []),
    ...(o.images ? [`      - run: ${imagesLine(o)}`, `      - run: echo "CHANT_RELEASE_DIGESTS=${RELEASE_DIGESTS_PATHS[o.forge]}" >> "$GITHUB_ENV"`] : []),
    ...(o.build ? [`      - run: ${o.build}`] : []),
    ...(o.verify ? [`      - run: ${o.chant} release verify "$CHANT_RELEASE_LABEL"`] : []),
    `      - run: ${o.chant} release publish "$CHANT_RELEASE_LABEL" ${o.flags}`,
  ];
  if (o.after.length > 0) {
    lines.push("  after-release:", "    needs: [gate, publish]", "    runs-on: ubuntu-latest", ...defaults, "    steps:", ...githubSetup(commit), `      - run: ${o.install}`, ...o.after.map((l) => `      - run: ${l}`));
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
    ...script.map((l) => `    - ${JSON.stringify(l)}`),
  ];
  const checkout = ['git checkout --detach "$CHANT_RELEASE_COMMIT"'];
  const lines = [
    ...job("chant-release-gate", [], [...cd, o.install, fetches[0]!, ...gateScript(o, "$CI_COMMIT_SHA"), 'echo "CHANT_RELEASE_COMMIT=$commit" > "$CI_PROJECT_DIR/chant-release-gate.env"'], ["  artifacts:", "    reports:", "      dotenv: chant-release-gate.env"]),
    "",
    ...job("chant-release-cut", ["chant-release-gate"], [...checkout, ...cd, o.install, ...o.extra.gitlabScript, fetches[0]!, ...auth, LEDGER_FETCH_FIRST, ...cutScript(o, "/tmp/chant-cut.json")], o.archives.length > 0 ? ["  artifacts:", "    paths:", ...o.archives.map((a) => `      - ${JSON.stringify(a)}`), "    expire_in: 1 day"] : [], o.extra.gitlabVariables),
    "",
    ...job(
      "chant-release-publish",
      ["chant-release-gate", "chant-release-cut"],
      [
        ...checkout,
        ...cd,
        o.install,
        ...o.extra.gitlabScript,
        ...fetches,
        ...auth,
        ...(o.version ? [stampLine(o)] : []),
        ...(o.images ? [imagesLine(o), `export CHANT_RELEASE_DIGESTS="${RELEASE_DIGESTS_PATHS.gitlab}"`] : []),
        ...(o.build ? [o.build] : []),
        ...(o.verify ? [`${o.chant} release verify "$CHANT_RELEASE_LABEL"`] : []),
        `${o.chant} release publish "$CHANT_RELEASE_LABEL" ${o.flags}`,
      ],
      ["  id_tokens:", "    SIGSTORE_ID_TOKEN:", "      aud: sigstore"],
      o.extra.gitlabVariables,
    ),
  ];
  if (o.after.length > 0) lines.push("", ...job("chant-release-after", ["chant-release-gate", "chant-release-publish"], [...checkout, ...cd, o.install, ...o.after]));
  return `${lines.join("\n")}\n`;
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
  const found = findWorkspaceRoot(process.cwd());
  if (!found) {
    console.error(formatError({ message: "no chant.workspace.json between this directory and the git root", hint: usage }));
    return 1;
  }
  const root = realpathSync(found.dir);
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
  const text = renderReleaseWorkflow({
    forge,
    groups,
    workspaceRoot,
    ...(release?.workflow ? { pipeline: release.workflow } : {}),
    ...((release?.images?.length ?? 0) > 0 ? { images: true, imageArchives: resolveReleaseImages(release!.images!).map((i) => i.archive), imagePlatforms: releaseImagePlatforms(release!.images!) } : {}),
    ...(release?.lane ? { lane: release.lane } : {}),
    ...(release?.version ? { version: true } : {}),
    ...(release?.publish ? { publish: release.publish } : {}),
    ...(args.ciInstall ? { install: args.ciInstall } : {}),
    ...(args.buildCommand ? { build: args.buildCommand } : {}),
    ...(args.ciChant ? { chant: args.ciChant } : {}),
  });
  const target = args.output ? resolve(process.cwd(), args.output) : join(repoRoot, release?.workflow?.file ?? RELEASE_WORKFLOW_FILES[forge]);
  // #4909: under `chant dev generated-check` the header names the committed file the render stands for.
  const { committedPathOf, isRenderPath } = await import("../generated-check");
  const asCommitted = committedPathOf(target);
  const defaultTarget = join(repoRoot, release?.workflow?.file ?? RELEASE_WORKFLOW_FILES[forge]);
  const parts = ["chant", "release", "workflow", "--forge", forge];
  if (args.ciInstall) parts.push("--install", args.ciInstall);
  if (args.buildCommand) parts.push("--build", args.buildCommand);
  if (args.ciChant) parts.push("--chant", args.ciChant);
  if (args.output && !(isRenderPath(target) && asCommitted === defaultTarget)) parts.push("--output", relative(root, asCommitted).split(sep).join("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, releaseWorkflowHeader(parts.map(shellArg).join(" ")) + text);
  const shown = relative(process.cwd(), target).split(sep).join("/") || target;
  const extras = [groups.has("supply-chain") ? "requires OIDC provenance (supply-chain)" : null, groups.has("verified-releases") ? "verifies the release first (verified-releases)" : null].filter(Boolean);
  const what = release?.workflow?.trigger === "dispatch" ? "cuts and publishes a release started by hand with its label, from a green commit" : "publishes the release a release/** tag names";
  console.log(formatSuccess(`Wrote ${shown}: ${what}${extras.length > 0 ? `, and ${extras.join(" and ")}` : ""}.`));
  if (forge === "gitlab") console.log(`Include it from .gitlab-ci.yml: include: [{ local: ${release?.workflow?.file ?? RELEASE_WORKFLOW_FILES.gitlab} }]`);
  // #4876: a GitLab executor that refuses privileged containers can't install the handlers from the job.
  const archs = (release?.images?.length ?? 0) > 0 ? qemuArchitectures(releaseImagePlatforms(release!.images!)) : [];
  if (forge === "gitlab" && archs.length > 0 && text.includes(`${RELEASE_BINFMT_IMAGE} --install`))
    console.log(`The cut and publish jobs install QEMU's binfmt handlers for ${archs.join(", ")} with docker run --privileged ${RELEASE_BINFMT_IMAGE}: the runner's executor must run privileged containers, or have the handlers installed on its host.`);
  if (forge === "gitlab" && release?.workflow?.trigger === "dispatch") console.log("The cut and publish jobs push with CHANT_RELEASE_TOKEN: a project access token with write_repository, as a masked CI/CD variable.");
  return 0;
}
