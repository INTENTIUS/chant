/**
 * The root CI file that runs `chant ci tick` (#3573, ws-103; ws-042 for its
 * place at the repository root, #2524 D14 for its header and record).
 *
 * `chant ci workflow` writes `.github/workflows/chant-ci-green.yml`. It runs
 * the tick when a workflow that holds a required check run completes on the
 * branch, so a result or a re-run is acted on within seconds, and every 15
 * minutes as a backstop for a dropped or late event. One concurrency group
 * that never cancels keeps ticks one at a time.
 *
 * GitHub's `workflow_run` names workflows, and `ci.green` names check runs,
 * so the generator reads the repository's other workflow files and keeps
 * each workflow with a job whose check-run name meets one of a required
 * phase's patterns. A job's check run is its `name`, or its id, with
 * ` (<matrix values>)` after it for a matrix job and ` / <job>` after it for
 * a job that calls a reusable workflow; a `${{ }}` expression stands for
 * anything. `--workflow <name>` adds a workflow the scan can't see.
 *
 * The tick runs the published chant that wrote the file, through npx.
 * `--chant <command>` runs another one instead, and `--install <command>`
 * adds a step that installs it, with setup-node caching npm's downloads when
 * the workspace root has a `package-lock.json`. chant's own repository uses
 * both to run its source at the commit it checks out.
 *
 * The tick pushes its tags with the credentials actions/checkout leaves in
 * the clone, the Actions token by default. GitHub treats a new ref to a
 * commit whose workflow files differ from the default branch's as an update
 * to those workflows, and the Actions token can never hold the `workflows`
 * permission, so it is refused there. `--token-secret <NAME>` checks out
 * with `secrets.<NAME>` instead, and `--app-id-var <VAR> --app-key-secret
 * <NAME>` mints a GitHub App token first and checks out with that. The
 * tick's own `GITHUB_TOKEN`, which reads check runs, stays the Actions token:
 * a fine-grained personal access token can't call the Checks API.
 *
 * Like a member's pipelines (./member-pipeline.ts), the file starts with the
 * generated-file header naming the command, and the member whose directory
 * the command runs in records it in its generated-file record, so `WSP081`
 * allows one declarer.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { GENERATED_MARKER } from "../discovery/files";
import { parseYAMLDocument } from "../yaml";
import type { CiGreen } from "./declaration";
import { matchesCheckRun } from "./ci-green";

/** Where the workflow goes, relative to the repository root. */
export const CI_GREEN_WORKFLOW_FILE = ".github/workflows/chant-ci-green.yml";
export const CI_GREEN_WORKFLOW_NAME = "chant-ci-green";

/** One workflow file as the scan reads it. */
export interface WorkflowSource {
  /** Relative to the repository root, such as `.github/workflows/ci.yml`. */
  path: string;
  text: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const EXPRESSION = /\$\{\{[^}]*\}\}/g;

/** The check-run names a workflow's jobs report, as patterns: `*` stands for what an expression or a matrix fills in. */
export function jobCheckRuns(doc: unknown): string[] {
  if (!isObject(doc) || !isObject(doc.jobs)) return [];
  const out: string[] = [];
  for (const [id, job] of Object.entries(doc.jobs)) {
    if (!isObject(job)) continue;
    const named = typeof job.name === "string" ? job.name : id;
    const base = named.replace(EXPRESSION, "*");
    out.push(base);
    if (isObject(job.strategy) && job.strategy.matrix !== undefined && base === named) out.push(`${base} (*)`);
    if (typeof job.uses === "string") out.push(`${base} / *`);
  }
  return out;
}

/** Whether two patterns can name the same check run: either matches the other with its `*` filled in. */
function meet(a: string, b: string): boolean {
  return matchesCheckRun(a, b.replace(/\*/g, "x")) || matchesCheckRun(b, a.replace(/\*/g, "x"));
}

/** The name `workflow_run` knows a workflow by: its `name`, or its path when it has none or the name is an expression. */
function workflowName(doc: unknown, path: string): string {
  return isObject(doc) && typeof doc.name === "string" && !doc.name.includes("${{") ? doc.name : path;
}

export interface WorkflowScan {
  /** The workflows holding a required check run, sorted. */
  workflows: string[];
  /** Required patterns no job of any workflow meets. */
  unmatched: { phase: string; pattern: string }[];
  /** Workflow files that could not be parsed. */
  unreadable: string[];
}

/** Find the workflows that hold the required phases' check runs. */
export function workflowsHolding(green: CiGreen, sources: readonly WorkflowSource[]): WorkflowScan {
  const patterns = green.require.flatMap((name) => green.phases.find((p) => p.name === name)!.runs.map((pattern) => ({ phase: name, pattern })));
  const workflows = new Set<string>();
  const met = new Set<string>();
  const unreadable: string[] = [];
  for (const s of sources) {
    let doc: unknown;
    try {
      doc = parseYAMLDocument(s.text);
    } catch {
      unreadable.push(s.path);
      continue;
    }
    const runs = jobCheckRuns(doc);
    for (const p of patterns) {
      if (!runs.some((r) => meet(p.pattern, r))) continue;
      workflows.add(workflowName(doc, s.path));
      met.add(`${p.phase}\0${p.pattern}`);
    }
  }
  return {
    workflows: [...workflows].sort(),
    unmatched: patterns.filter((p) => !met.has(`${p.phase}\0${p.pattern}`)),
    unreadable,
  };
}

/** The repository's GitHub workflow files, other than `skip`. */
export function readWorkflowSources(repoRoot: string, skip: string): WorkflowSource[] {
  const dir = join(repoRoot, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => `.github/workflows/${f}`)
    .filter((p) => p !== skip)
    .map((path) => ({ path, text: readFileSync(join(repoRoot, path), "utf-8") }));
}

const q = (s: string) => JSON.stringify(s);

export interface WorkflowInput {
  green: CiGreen;
  /** The workflows whose completion triggers a tick. */
  workflows: readonly string[];
  /** The chant the tick runs, `@intentius/chant` at this version. */
  chantVersion: string;
  /**
   * The command that runs chant, with `ci tick` after it, in place of
   * `npx --yes @intentius/chant@<chantVersion>`. chant's own repository runs
   * its source this way, so the tick tests the commit it checks out.
   */
  chant?: string;
  /** A step before the tick that installs what `chant` needs, run where the tick runs. */
  install?: string;
  /** With `install`, the `package-lock.json` setup-node caches npm's downloads by, from the repository root. */
  npmLock?: string;
  /** The workspace root relative to the repository root, `.` for the root itself. */
  workspaceRoot: string;
  /** How the tag push authenticates, when not with the Actions token. */
  push?: PushToken;
}

/**
 * A token the checkout persists for the tick's `git push`: a repository
 * secret, or a GitHub App's installation token minted from its id (an
 * Actions variable) and private key (a secret).
 */
export type PushToken = { secret: string } | { appIdVar: string; appKeySecret: string };

/** A secret or variable name GitHub accepts: letters, digits and underscores, not starting with a digit. */
export const ACTIONS_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The workflow's YAML, without the generated-file header. Deterministic: the same input writes the same bytes. */
export function renderCiGreenWorkflow(input: WorkflowInput): string {
  const { green } = input;
  const where = input.workspaceRoot === "." ? [] : [`        working-directory: ${q(input.workspaceRoot)}`];
  const cache = input.install && input.npmLock ? ["          cache: npm", ...(input.npmLock === "package-lock.json" ? [] : [`          cache-dependency-path: ${q(input.npmLock)}`])] : [];
  const tick = input.chant ? q(`${input.chant} ci tick`) : `npx --yes @intentius/chant@${input.chantVersion} ci tick`;
  const push = input.push;
  const mint =
    push && "appIdVar" in push
      ? [
          "      - name: Mint a GitHub App token that may push tags to commits that change workflows",
          "        id: app-token",
          "        uses: actions/create-github-app-token@v2",
          "        with:",
          `          app-id: \${{ vars.${push.appIdVar} }}`,
          `          private-key: \${{ secrets.${push.appKeySecret} }}`,
        ]
      : [];
  const token = !push ? [] : ["secret" in push ? `          token: \${{ secrets.${push.secret} }}` : "          token: ${{ steps.app-token.outputs.token }}"];
  const lines = [
    `name: ${CI_GREEN_WORKFLOW_NAME}`,
    "",
    "# Tags each commit on the branch that passed its required phases ci/green/<sha>,",
    "# and a green commit that later fails one ci/revoked/<sha>.",
    "on:",
    "  workflow_run:",
    "    workflows:",
    ...input.workflows.map((w) => `      - ${q(w)}`),
    "    types:",
    "      - completed",
    "    branches:",
    `      - ${q(green.branch)}`,
    "  schedule:",
    "    - cron: \"*/15 * * * *\"",
    "  workflow_dispatch: {}",
    "",
    "# One tick at a time, and a tick in progress is never cancelled.",
    "concurrency:",
    `  group: ${CI_GREEN_WORKFLOW_NAME}`,
    "  cancel-in-progress: false",
    "",
    "permissions:",
    "  contents: write",
    "  checks: read",
    "",
    "jobs:",
    "  tick:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 15",
    "    steps:",
    ...mint,
    "      - uses: actions/checkout@v6",
    "        with:",
    `          ref: ${q(green.branch)}`,
    "          fetch-depth: 0",
    ...token,
    "      - uses: actions/setup-node@v6",
    "        with:",
    "          node-version: \"24\"",
    ...cache,
    ...(input.install ? ["      - name: Install what the tick runs", ...where, `        run: ${q(input.install)}`] : []),
    "      - name: Tag the commits that turned green, revoke the ones that turned red",
    ...where,
    "        env:",
    "          GITHUB_TOKEN: ${{ github.token }}",
    "          GIT_COMMITTER_NAME: github-actions[bot]",
    "          GIT_COMMITTER_EMAIL: 41898282+github-actions[bot]@users.noreply.github.com",
    `        run: ${tick}`,
  ];
  return lines.join("\n") + "\n";
}

/** The header line naming the command that regenerates the file, and where to run it. */
export function ciGreenHeader(command: string, where: "member" | "root"): string {
  return `# ${GENERATED_MARKER}. Regenerate with: ${command} (in the ${where === "member" ? "member's directory" : "workspace root"})\n`;
}

/** Write the file, creating its directory. Returns the path relative to the current directory. */
export function writeWorkflowFile(target: string, text: string): string {
  mkdirSync(dirname(resolve(target)), { recursive: true });
  writeFileSync(target, text);
  return relative(process.cwd(), target).split(sep).join("/") || target;
}
