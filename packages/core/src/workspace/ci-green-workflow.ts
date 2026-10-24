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
 * with `secrets.<NAME>` instead, falling back to the Actions token where the
 * secret is unset (#3624), so a fork or a fresh clone still tags the commits
 * that change no workflow file; and `--app-id-var <VAR> --app-key-secret
 * <NAME>` mints a GitHub App token first and checks out with that. The
 * tick's own `GITHUB_TOKEN`, which reads check runs, stays the Actions token:
 * a fine-grained personal access token can't call the Checks API.
 *
 * `--runner-key-secret <NAME>` (#4031) hands the tick the runner key it
 * signs its tags with, from `secrets.<NAME>` as `CHANT_RUNNER_KEY`. A
 * declaration that sets `ci.green.signedSince` needs it: a tag outside that
 * commit's strict first-parent ancestry without a statement is ignored.
 *
 * Like a member's pipelines (./member-pipeline.ts), the file starts with the
 * generated-file header naming the command, and the member whose directory
 * the command runs in records it in its generated-file record, so `WSP081`
 * allows one declarer.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { GENERATED_MARKER } from "../discovery/files";
import { ACTION_PINS, tagComments, usesRef } from "../action-pins";
import { emitYAMLEntry, parseYAMLDocument } from "../yaml";
import type { CiBuild, CiGreen } from "./declaration";
import { matchesCheckRun } from "./ci-green";
import { githubSecretOrJobToken } from "../ci-jobs";
import { COMPOSE_BRANCH_PREFIX } from "../lifecycle/compose-refs";

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

/**
 * The workflow files that hold a check run of one of `phases` and can be
 * started by hand (`workflow_dispatch`), by file name, for a build the tick
 * asks for (#4169). Files that can't be parsed are left out.
 */
export function dispatchableWorkflows(green: CiGreen, phases: readonly string[], sources: readonly WorkflowSource[]): { dispatchable: string[]; without: string[] } {
  const patterns = phases.flatMap((name) => green.phases.find((p) => p.name === name)?.runs ?? []);
  const dispatchable: string[] = [];
  const without: string[] = [];
  for (const s of sources) {
    let doc: unknown;
    try {
      doc = parseYAMLDocument(s.text);
    } catch {
      continue;
    }
    const runs = jobCheckRuns(doc);
    if (!patterns.some((p) => runs.some((r) => meet(p, r)))) continue;
    const on = isObject(doc) ? doc.on : undefined;
    const file = s.path.slice(s.path.lastIndexOf("/") + 1);
    (isObject(on) && "workflow_dispatch" in on ? dispatchable : without).push(file);
  }
  return { dispatchable: dispatchable.sort(), without: without.sort() };
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
  /**
   * The repository secret holding the runner key the tick signs its tags
   * with, as PEM (#4031). The tick step reads it from `CHANT_RUNNER_KEY`.
   * The key's principal needs the `runner` role in `.chant/trust.json`.
   */
  runnerKeySecret?: string;
  /**
   * The workspace declares a `ci.workflow` (#4220), so composed releases
   * live on `chant/compose/<name>` branches (#4168 4.3): the tick also runs
   * when a phase workflow completes on one of them.
   */
  compose?: boolean;
}

/** The branch filter for composed releases' branches (#4220). */
export const COMPOSE_BRANCHES = `${COMPOSE_BRANCH_PREFIX}**`;

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
          `        uses: ${usesRef(ACTION_PINS.createGithubAppToken2)}`,
          "        with:",
          `          app-id: \${{ vars.${push.appIdVar} }}`,
          `          private-key: \${{ secrets.${push.appKeySecret} }}`,
        ]
      : [];
  const token = !push ? [] : ["secret" in push ? `          token: ${githubSecretOrJobToken(push.secret)}` : "          token: ${{ steps.app-token.outputs.token }}"];
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
    // #4169: a build the tick asked for runs at a ci/build/<sha> tag, and its completion ticks too.
    ...(newestPhases(green) ? [`      - ${q("ci/build/**")}`] : []),
    // #4220: a composed commit's phases run on its chant/compose/<name> branch, and their completion ticks too.
    ...(input.compose ? [`      - ${q(COMPOSE_BRANCHES)}`] : []),
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
    // #4169: re-running a failed job and starting a workflow at a ci/build/<sha> tag.
    ...(declaresBuild(green) ? ["  actions: write"] : []),
    "",
    "jobs:",
    "  tick:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 15",
    "    steps:",
    ...mint,
    `      - uses: ${usesRef(ACTION_PINS.checkout6)}`,
    "        with:",
    `          ref: ${q(green.branch)}`,
    "          fetch-depth: 0",
    ...token,
    `      - uses: ${usesRef(ACTION_PINS.setupNode6)}`,
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
    ...(input.runnerKeySecret ? [`          CHANT_RUNNER_KEY: \${{ secrets.${input.runnerKeySecret} }}`] : []),
    `        run: ${tick}`,
  ];
  return tagComments(lines.join("\n") + "\n");
}

/** Whether any phase sets `build` (#4169): then the tick may re-run jobs and start workflows. */
export const declaresBuild = (green: CiGreen) => green.phases.some((p) => p.build !== undefined);
/** Whether a required phase builds only the newest commit (#4169). */
export const newestPhases = (green: CiGreen) => green.phases.some((p) => p.build === "newest" && green.require.includes(p.name));

// ── A phase's triggers (#4169) ───────────────────────────────────────────────

/** The comment line above each top-level block `ci workflow` writes into a phase's workflow. */
export const BUILD_BLOCK_MARKER = "# Written by chant ci workflow from ci.green's build (#4169); edit ci.green and run it again.";

/** What `ci workflow` writes into one workflow holding a phase that sets `build`. */
export interface BuildTriggerEdit {
  /** Relative to the repository root. */
  path: string;
  build: CiBuild;
  phases: string[];
  /** The file with its triggers and concurrency written. */
  text: string;
  changed: boolean;
}

/**
 * The workflows holding the check runs of phases that set `build`, each with
 * its triggers and concurrency written for that build (#4169):
 *
 * - `newest`: on pushes to the branch, and by hand (`workflow_dispatch`),
 *   which is how the tick starts a bisect step or a requested build at a
 *   `ci/build/<sha>` tag. A `schedule` goes: a runner freeing up, not a
 *   clock, picks the commit. Other triggers stay. One concurrency group per
 *   ref that never cancels a run in progress, so GitHub keeps the newest
 *   push waiting and drops the ones between, and each tag's build runs in a
 *   group of its own.
 * - `every`: the triggers stay, with `workflow_dispatch` added so the tick
 *   can start a run the forge never started on a commit (#4216), and the
 *   group is the commit itself on the branch, so no push cancels or replaces
 *   another's run; elsewhere, such as a pull request or a `ci/build/<sha>`
 *   tag, a new push cancels the run it supersedes.
 *
 * With `compose` (#4220, a workspace declaring `ci.workflow`), both builds
 * also run on pushes to `chant/compose/**`: `newest` adds the filter to the
 * branches it writes, `every` adds it to an existing `push.branches` list,
 * and `every`'s group keys a compose branch's runs by commit, as the trunk
 * branch's.
 *
 * Only the top-level `on:` and `concurrency:` blocks change,
 * each under {@link BUILD_BLOCK_MARKER}; the rest of the file is kept as it
 * is. Throws when one workflow holds a phase of each build, which no one
 * concurrency group can serve.
 */
export function buildTriggerEdits(green: CiGreen, sources: readonly WorkflowSource[], options: { compose?: boolean } = {}): BuildTriggerEdit[] {
  const compose = options.compose === true;
  const out: BuildTriggerEdit[] = [];
  for (const s of sources) {
    let doc: unknown;
    try {
      doc = parseYAMLDocument(s.text);
    } catch {
      continue;
    }
    const runs = jobCheckRuns(doc);
    const held = green.phases.filter((p) => p.build !== undefined && p.runs.some((pattern) => runs.some((r) => meet(pattern, r))));
    if (held.length === 0) continue;
    const builds = [...new Set(held.map((p) => p.build!))];
    if (builds.length > 1) {
      throw new Error(`${s.path} holds runs of ${held.map((p) => `${p.name} (build: ${p.build})`).join(" and ")}, and one workflow can't run on every commit and only the newest; move the jobs into a workflow per build`);
    }
    const build = builds[0];
    const phases = held.map((p) => p.name);
    const tag = phases.map((p) => p.replace(/[^A-Za-z0-9_-]/g, "-")).join("-");
    let text = s.text;
    if (build === "newest") {
      const on = isObject(doc) && isObject(doc.on) ? { ...doc.on } : {};
      delete on.schedule;
      const push = isObject(on.push) ? { ...on.push } : {};
      const branches = Array.isArray(push.branches) ? push.branches.filter((b): b is string => typeof b === "string") : [];
      const withBranch = branches.includes(green.branch) ? branches : [...branches, green.branch];
      push.branches = compose && !withBranch.includes(COMPOSE_BRANCHES) ? [...withBranch, COMPOSE_BRANCHES] : withBranch;
      const { push: _push, workflow_dispatch: dispatch, ...rest } = on;
      text = writeTopLevel(text, "on", { push, workflow_dispatch: dispatch ?? {}, ...rest });
      text = writeTopLevel(text, "concurrency", { group: `chant-build-${tag}-\${{ github.ref }}`, "cancel-in-progress": false });
    } else {
      const main = `refs/heads/${green.branch}`;
      const on = triggersOf(isObject(doc) ? doc.on : undefined);
      let next = on;
      // A push filter that lists branches gains the compose branches; one with no list already runs on every branch.
      const pushOn = isObject(on.push) ? on.push : undefined;
      if (compose && pushOn && Array.isArray(pushOn.branches) && !pushOn.branches.includes(COMPOSE_BRANCHES)) {
        next = { ...next, push: { ...pushOn, branches: [...pushOn.branches, COMPOSE_BRANCHES] } };
      }
      // #4216: the tick starts the workflow by hand at a ci/build/<sha> tag when the forge ran nothing on a commit.
      if (!("workflow_dispatch" in next)) next = { ...next, workflow_dispatch: {} };
      if (next !== on) text = writeTopLevel(text, "on", next);
      // #4220: a compose branch's commits each get a verdict, so its runs are keyed by commit, as the trunk branch's are.
      const keyed = compose ? `(github.ref == '${main}' || startsWith(github.ref, 'refs/heads/${COMPOSE_BRANCH_PREFIX}'))` : `github.ref == '${main}'`;
      const unkeyed = compose ? `!${keyed}` : `github.ref != '${main}'`;
      // Written as lines: the emitter would quote the expression, and GitHub reads it the same either way.
      text = writeTopLevel(text, "concurrency", [
        "concurrency:",
        `  group: chant-build-${tag}-\${{ ${keyed} && github.sha || github.ref }}`,
        `  cancel-in-progress: \${{ ${unkeyed} }}`,
      ]);
    }
    out.push({ path: s.path, build, phases, text, changed: text !== s.text });
  }
  return out;
}

/** A workflow's `on:` as a map: `on: push` and `on: [push, pull_request]` name triggers with no settings. */
function triggersOf(on: unknown): Record<string, unknown> {
  if (isObject(on)) return on;
  if (typeof on === "string") return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.filter((t): t is string => typeof t === "string").map((t) => [t, null]));
  return {};
}

/**
 * Replace the top-level `key:` block of a YAML file with `value` (or with
 * `value`'s lines, the key's own line first), under
 * {@link BUILD_BLOCK_MARKER}, or add it before `permissions:` or `jobs:`
 * when the file has none. The block runs from its key's line to the next
 * line at column 0 that is not blank; comments above the key stay.
 */
export function writeTopLevel(text: string, key: string, value: Record<string, unknown> | string[]): string {
  const lines = text.split("\n");
  const block = [BUILD_BLOCK_MARKER, ...(Array.isArray(value) ? value : emitYAMLEntry(key, value).split("\n"))];
  const at = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}: `) || l.startsWith(`${key}:#`));
  if (at < 0) {
    const before = lines.findIndex((l) => /^(permissions|jobs):/.test(l));
    const where = before < 0 ? lines.length : before;
    return [...lines.slice(0, where), ...block, "", ...lines.slice(where)].join("\n");
  }
  let end = at + 1;
  while (end < lines.length && (lines[end] === "" || /^\s/.test(lines[end]))) end++;
  // A blank line ending the block belongs to what follows it.
  while (end > at + 1 && lines[end - 1] === "") end--;
  const start = at > 0 && lines[at - 1] === BUILD_BLOCK_MARKER ? at - 1 : at;
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
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
