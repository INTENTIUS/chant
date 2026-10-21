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
 */
import { GENERATED_MARKER } from "../discovery/files";
import type { SecurityGroup } from "./security";

export const RELEASE_WORKFLOW_FORGES = ["github", "forgejo", "gitlab"] as const;
export type ReleaseWorkflowForge = (typeof RELEASE_WORKFLOW_FORGES)[number];

/** Where each forge's publish workflow is written, relative to the repository root. */
export const RELEASE_WORKFLOW_FILES: Record<ReleaseWorkflowForge, string> = {
  github: ".github/workflows/chant-release.yml",
  forgejo: ".forgejo/workflows/chant-release.yml",
  // GitLab reads one .gitlab-ci.yml, which includes this file: `include: { local: .gitlab/chant-release.yml }`.
  gitlab: ".gitlab/chant-release.yml",
};

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
}

/** The flags `chant release publish` gets under the groups. */
export function publishFlags(groups: ReadonlySet<SecurityGroup>): string[] {
  return [...(groups.has("supply-chain") ? ["--require-provenance"] : []), "--yes"];
}

/** The workflow file's text, without the generated-by header. */
export function renderReleaseWorkflow(input: ReleaseWorkflowInput): string {
  const chant = input.chant ?? "npx chant";
  const install = input.install ?? "npm ci";
  const build = input.build === undefined ? "npm run build" : input.build;
  const root = input.workspaceRoot && input.workspaceRoot !== "." ? input.workspaceRoot : null;
  const verify = input.groups.has("verified-releases");
  const flags = publishFlags(input.groups).join(" ");
  if (input.forge === "gitlab") {
    const label = '"${CI_COMMIT_TAG#release/}"';
    const lines = [
      "chant-release-publish:",
      "  rules:",
      "    - if: $CI_COMMIT_TAG =~ /^release\\//",
      "  id_tokens:",
      "    SIGSTORE_ID_TOKEN:",
      "      aud: sigstore",
      "  script:",
      ...(root ? [`    - cd ${root}`] : []),
      `    - ${install}`,
      ...(build ? [`    - ${build}`] : []),
      "    - git fetch origin 'refs/tags/ci/*:refs/tags/ci/*'",
      "    - git fetch origin chant/lifecycle:chant/lifecycle",
      ...(verify ? [`    - ${chant} release verify ${label}`] : []),
      `    - ${chant} release publish ${label} ${flags}`,
    ];
    return `${lines.join("\n")}\n`;
  }
  const label = '"${GITHUB_REF_NAME#release/}"';
  const lines = [
    "name: chant release publish",
    "on:",
    "  push:",
    '    tags: ["release/**"]',
    "permissions:",
    "  contents: write",
    "  id-token: write",
    "jobs:",
    "  publish:",
    "    runs-on: ubuntu-latest",
    ...(root ? ["    defaults:", "      run:", `        working-directory: ${root}`] : []),
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        with:",
    "          fetch-depth: 0",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 24",
    "          registry-url: https://registry.npmjs.org",
    `      - run: ${install}`,
    ...(build ? [`      - run: ${build}`] : []),
    "      - run: git fetch origin 'refs/tags/ci/*:refs/tags/ci/*'",
    "      - run: git fetch origin chant/lifecycle:chant/lifecycle",
    ...(verify ? [`      - run: ${chant} release verify ${label}`] : []),
    `      - run: ${chant} release publish ${label} ${flags}`,
  ];
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
  const text = renderReleaseWorkflow({
    forge,
    groups,
    workspaceRoot,
    ...(args.ciInstall ? { install: args.ciInstall } : {}),
    ...(args.buildCommand ? { build: args.buildCommand } : {}),
    ...(args.ciChant ? { chant: args.ciChant } : {}),
  });
  const target = args.output ? resolve(process.cwd(), args.output) : join(repoRoot, RELEASE_WORKFLOW_FILES[forge]);
  const parts = ["chant", "release", "workflow", "--forge", forge];
  if (args.ciInstall) parts.push("--install", args.ciInstall);
  if (args.buildCommand) parts.push("--build", args.buildCommand);
  if (args.ciChant) parts.push("--chant", args.ciChant);
  if (args.output) parts.push("--output", relative(root, target).split(sep).join("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, releaseWorkflowHeader(parts.map(shellArg).join(" ")) + text);
  const shown = relative(process.cwd(), target).split(sep).join("/") || target;
  const extras = [groups.has("supply-chain") ? "requires OIDC provenance (supply-chain)" : null, groups.has("verified-releases") ? "verifies the release first (verified-releases)" : null].filter(Boolean);
  console.log(formatSuccess(`Wrote ${shown}: publishes the release a release/** tag names${extras.length > 0 ? `, and ${extras.join(" and ")}` : ""}.`));
  if (forge === "gitlab") console.log(`Include it from .gitlab-ci.yml: include: [{ local: ${RELEASE_WORKFLOW_FILES.gitlab} }]`);
  return 0;
}
