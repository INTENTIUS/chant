/**
 * Generate mode — scheduled Op → GitHub Actions workflow YAML (#927).
 *
 * The Op counterpart to `./generate-pipeline.ts` (#891): that module
 * synthesizes a `workflow_dispatch`-triggered pipeline from a deploy-time
 * component graph, this one synthesizes a cron-triggered workflow per
 * stateless Op. An Op's cadence is an `OpSchedule` on the Op itself
 * (`packages/core/src/op/types.ts`), runtime-neutral data each reader
 * interprets; this module is the reader that turns it into a cron a GitHub
 * runner fires (`WorkflowAuditOp`, `PipelineAuditOp`, `ReconcileOp`, … all
 * accept an optional `schedule` precisely for this).
 *
 * GitHub Actions' `on.schedule` is workflow-scoped, not job-scoped, so unlike
 * the component generator (one combined pipeline for the whole graph) this
 * emits one workflow file per `ScheduledOpSpec`. Each workflow:
 *  - triggers on its `ScheduledOpSpec`'s trigger (#2084): `cron` (the Op's
 *    schedule, plus `workflow_dispatch` so manual runs stay available for
 *    testing/dry-runs), `pull_request` (optionally filtered to `branches`,
 *    no `workflow_dispatch` — a PR event needs no manual escape hatch), or
 *    `push` (filtered to `branches`, defaulting to the repository's default
 *    branch);
 *  - declares only the `permissions:` its `findingMode` (and, for a
 *    `pull_request` trigger, whether that mode posts a comment) needs —
 *    `report` stays read-only, `issue`/`comment`/`pull-request` add the write
 *    scope the Op's own activity uses (`gh issue create` / a comment on the
 *    triggering PR / `gh pr create`, see `@intentius/chant/op`'s
 *    `reconcilePr` activity) — never a blanket `write-all`. `comment` is the
 *    one mode that constrains the trigger rather than only the scope: it
 *    needs a pull request to post onto, so this generator refuses it by name
 *    on any other trigger (#2231);
 *  - runs exactly one invocation, `chant run <name>` by default — never
 *    inlined audit/reconcile logic. The finding-mode itself is already baked
 *    into the Op's own activity args at build time by the composite that
 *    created it; this workflow only supplies the token the mode needs to act;
 *  - on a `push` trigger only, runs that invocation with `--gated-exit 0`
 *    and adds a follow-up job that says where the approval is pending
 *    (#2243). See {@link GATED_EXIT_FLAG} and {@link gateNoticeJob}.
 *
 * Two per-Op options widen that shape without loosening it (#2242). A spec's
 * `setup` list emits steps between the checkout and the `beforeScript` lines,
 * `uses:` steps included, which is the only way a generated job can reach an
 * action like `aws-actions/configure-aws-credentials`; {@link
 * assertSetupSteps} refuses an unpinned or default-branch ref at build time.
 * A spec's `permissions` map is merged over {@link permissionsFor}, adding
 * scopes the finding-mode never grants (`id-token: write` is the whole
 * reason) and never touching one it does; {@link mergePermissions} refuses a
 * blanket grant, an overlap with the mode's own set, an unknown scope name,
 * and pull-request write on a trigger that has no pull request.
 *
 * A third widens it the other way (#2257): a spec's `environment` emits
 * `environment:` on the Op's own job, which is how a GitHub environment's
 * protection rules — required reviewers above all — come to hold a generated
 * apply. That is a second gate beside chant's own, not a replacement for it:
 * the reviewer stops the job before any step runs, chant's gate ledger
 * (#2119) stops the apply inside a run that already started, and the two
 * compose in either combination. It costs {@link permissionsFor} nothing —
 * environment protection is repository configuration, not a token scope — and
 * {@link assertEnvironment} refuses only what would emit as configured and
 * bind nothing.
 *
 * A fourth is per-Op credentials (#2290): a spec's `variables` emits the Op's
 * own job-level `env:`, beside (and layered over, on a key collision)
 * `options.variables`'s workflow-level `env:`. `options.variables` keeps
 * meaning what it always has — set once, landing on every generated file — so
 * a caller who declares nothing per-Op sees byte-identical output; a spec's
 * own `variables` is the way one Op's job can hold a credential no other Op's
 * job receives, which a workflow-level declaration can never express because
 * every generated file here has exactly the one Op job (plus, on a `push`
 * trigger, the gate-notice job beside it — job-level `env:` does not reach
 * that job either, same as `environment:` above does not).
 */

import { emitYAML } from "@intentius/chant/yaml";
import { resolveOpTrigger } from "@intentius/chant/lexicon";
import type {
  ComponentPipelineOptions as GenerateGithubOpOptions,
  OpEnvironment,
  OpFindingMode,
  OpPipelineJob,
  OpPipelineResult as GenerateGithubOpResult,
  OpSetupStep,
  OpTrigger,
  ScheduledOpSpec,
} from "@intentius/chant/lexicon";

export type { GenerateGithubOpOptions, GenerateGithubOpResult };

/**
 * The structured pipeline document behind one generated file, before YAML
 * emission — exposed so a GitHub-Actions dialect (the forgejo lexicon, #969)
 * can reuse the exact trigger/concurrency/job structure and only apply its
 * dialect transform + emit, rather than re-deriving it. Mirrors
 * `./generate-pipeline.ts`'s `GithubPipelineDoc` split.
 */
export interface GithubOpPipelineDoc {
  /**
   * Comment lines emitted above the document, `#` prefix included, when a
   * dialect has something to say about what it could not carry across
   * (#2257). Empty on github, which drops nothing; the forgejo dialect uses
   * it to name the `environment:` its runner has no concept of, so the fact
   * that a reviewer gate did not survive is readable in the generated file
   * rather than only in a build warning.
   */
  header?: string[];
  /**
   * The `on:` trigger mapping, per {@link ScheduledOpSpec}'s trigger kind
   * (#2084): `{ schedule, workflow_dispatch }` for cron, `{ pull_request }`
   * for `pull_request`, `{ push }` for `push`.
   */
  on: Record<string, unknown>;
  /** The `env:` mapping, when `options.variables` is set. */
  env?: Record<string, unknown>;
  /** The `concurrency:` mapping — one run at a time per Op. */
  concurrency: Record<string, unknown>;
  /**
   * The `permissions:` mapping for this Op's finding-mode. GitHub-only:
   * Forgejo Actions ignores `permissions:` entirely, so the forgejo dialect
   * drops this section rather than translating it (see ../../forgejo/src/dialect.ts).
   */
  permissions: Record<string, unknown>;
  /** The `jobs:` mapping — one entry, this Op's trigger job. */
  jobsDoc: Record<string, unknown>;
  /**
   * The gated-apply notice job (#2243), when this Op's trigger is `push`.
   * Kept out of {@link jobsDoc} so a dialect that cannot run it drops it by
   * simply not copying it: the job shells to `gh` against the GitHub API and
   * needs `gh` on the runner, which is the same reason the `comment` finding
   * mode is refused on forgejo (#2231). {@link emitOpPipelineYAML} merges it
   * into `jobs:` for the forges that can. GitLab reaches the same outcome
   * without this job at all: its push job writes the pending block to an
   * artifact instead (#2256).
   */
  gatedNoticeDoc?: Record<string, unknown>;
}

/** One generated file: a suggested name plus its pipeline document, pre-emission. */
export interface GithubOpPipelineFile {
  /** Suggested file name (`<op-name>.yml`), relative to the provider's workflow directory. */
  name: string;
  doc: GithubOpPipelineDoc;
}

/** GitHub Actions job ids must match `[a-zA-Z_][a-zA-Z0-9_-]*`; Op names are already kebab-case in every fixture, but normalize defensively (mirrors `./generate-pipeline.ts`'s `toJobName`). */
function toJobName(opName: string): string {
  return opName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

const DEFAULT_IMAGE = "node:22-slim";

/**
 * Default branch assumed for a `push` trigger with no `branches` override
 * (#2084). There is no generator constant for a downstream project's actual
 * default branch — this operates on a `ScheduledOpSpec`, not a git checkout
 * — so "main" is the documented default; set `trigger.branches` explicitly
 * for a project whose default branch is something else (e.g. "master").
 */
const DEFAULT_PUSH_BRANCH = "main";

/** This trigger's `on:` mapping (#2084): cron unchanged, `pull_request`/`push` new. */
function onFor(trigger: OpTrigger): Record<string, unknown> {
  switch (trigger.kind) {
    case "cron":
      return { schedule: [{ cron: trigger.schedule }], workflow_dispatch: {} };
    case "pull_request":
      // No `workflow_dispatch`: a PR trigger needs no manual-dispatch escape
      // hatch (revisit in review if that's wrong).
      return { pull_request: trigger.branches ? { branches: trigger.branches } : {} };
    case "push":
      return { push: { branches: trigger.branches ?? [DEFAULT_PUSH_BRANCH] } };
  }
}

/**
 * Least-privilege `permissions:` for a scheduled Op's finding-mode and
 * trigger. `report` needs no write access; `issue` needs only `issues:
 * write`; `pull-request` (and `merge-request`, generated the same way when a
 * GitLab-authored spec is targeted at github) needs `contents: write` to
 * push the reconcile branch plus `pull-requests: write` to open the PR. A
 * `pull_request` trigger reports its finding as a comment on the triggering
 * PR itself (#2084): any mode but `report` posts something to act on a
 * finding, so on that trigger every such mode also gets `pull-requests:
 * write` for the comment, whether or not its own scope already included it.
 * `comment` is the mode that actually spends that grant (#2231), and it
 * changes nothing in the repository, so its whole scope is `{ contents: read,
 * pull-requests: write }`.
 */
function permissionsForMode(mode: OpFindingMode): Record<string, "read" | "write"> {
  switch (mode) {
    case "issue":
      return { contents: "read", issues: "write" };
    case "comment":
      return { contents: "read", "pull-requests": "write" };
    case "pull-request":
    case "merge-request":
      return { contents: "write", "pull-requests": "write" };
    case "report":
      return { contents: "read" };
  }
}

function permissionsFor(mode: OpFindingMode, trigger: OpTrigger): Record<string, "read" | "write"> {
  const base = permissionsForMode(mode);
  if (trigger.kind === "pull_request" && mode !== "report") {
    return { ...base, "pull-requests": "write" };
  }
  return base;
}

// ── The gated apply (#2243) ─────────────────────────────────────────────────

/**
 * `chant run` returns 3 when a run stops at an unapproved gate. GitHub Actions
 * has no neutral conclusion for a `run:` step, so a push-to-main apply that
 * gates paints the branch red on every merge until someone approves. This maps
 * that one outcome to success, in chant rather than in a shell wrapper
 * (#2243); a failed run still returns 1 and is still red.
 *
 * `push` only. A cron watch and a `pull_request` plan are never gated in a way
 * that should be hidden: nobody is waiting on a merge for either, and a gated
 * one there is a signal, not noise.
 */
const GATED_EXIT_FLAG = ["--gated-exit", "0"];

/** The id of the `chant run` step on a `push` job, so the job can publish its outputs. */
const RUN_STEP_ID = "chant-run";

/**
 * Turn the run's `--json` record into step outputs, so the notice job below
 * has a condition to test and a gate to name. Runs in node, which is already
 * on any machine `chant` runs on — unlike `jq`, which the Op's own container
 * image need not carry.
 *
 * Nothing is written for a run that completed, so `gated` is either the string
 * `true` or absent, and the notice job's `if:` is a plain equality.
 */
const GATE_OUTPUT_SCRIPT =
  'const fs=require("fs");' +
  'const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));' +
  'if(r.status!=="gated"||!process.env.GITHUB_OUTPUT)process.exit(0);' +
  "fs.appendFileSync(process.env.GITHUB_OUTPUT," +
  '`gated=true\\nop=${r.op}\\ngate=${(r.gate&&r.gate.name)||""}\\napprove=${r.approve||""}\\n`)';

/**
 * The `push` job's run step: the invocation with {@link GATED_EXIT_FLAG} and
 * `--json`, tee'd so the record is both in the log and on disk, then read for
 * the job's outputs.
 *
 * The exit-code capture below is not decoration. Piping straight into `tee`
 * — `chant run ... | tee "$json"` — reports `tee`'s own zero as the step's
 * result no matter what `chant run` exited with, and turns a broken apply
 * green, which is the exact thing this step must not do. bash's fix for that
 * is `set -o pipefail`, but `pipefail` is a bash-ism, and this generator's
 * own Op job always sets `container:` (see {@link buildGithubOpPipelineDocs}'s
 * `container: image`) — GitHub's (and Forgejo's) default shell for a
 * `container:` job is plain `sh`, which rejects `set -o pipefail` outright
 * (`Illegal option -o pipefail`) and fails the step before `chant` ever runs
 * (#2299). #2307 first fixed that by pairing the `pipefail` line with an
 * unconditional `shell: "bash"` on the step — which then broke every
 * consumer whose `options.image` has no bash on it at all, e.g. an
 * `alpine:*` or distroless image (#2321): busybox `ash` ran the old
 * plain-pipe script fine, so pinning `shell: bash` regressed exactly the
 * images that never needed pipefail's workaround in the first place.
 *
 * So this step needs no shell declaration and runs under whatever `sh` the
 * consumer's image provides. It gets the same failure-cannot-hide guarantee
 * `pipefail` gave, without the bash-ism, by capturing the invocation's own
 * exit code into a file from *inside* the pipeline's first stage — where
 * `tee` can never see it — and checking that file once the pipe finishes:
 * `{ invocation; echo "$?" >status; } | tee "$json"` followed by `exit
 * "$(cat "$status")"` when that is non-zero. `set +e` up front makes this
 * work under any default shell a container job might get, `-e` included:
 * GitHub's documented `sh` template is `sh -e {0}`, and without `set +e`
 * `-e` would abort the brace group at the first failing command — before
 * `echo "$?"` ever runs — which was verified by running both this script and
 * that failure mode under bash and dash directly, `-e` on. Everything past
 * that point (`set +e`, `{ }`, `$(...)`, `[ ]`) is POSIX `sh`, so it needs no
 * `shell:` field to run correctly under `ash`, `dash`, or bash alike, and
 * #2299 does not reopen: nothing here is a bash-only construct.
 *
 * The `node -e` line and the job's own `outputs:` mapping exist for exactly
 * one reader: the gate-notice job beside it, which is `needs:`-only readable
 * through `steps.<id>.outputs`/`needs.<job>.outputs`. `emitOutputs: false`
 * (forgejo, #2294 — the notice job does not cross the dialect at all) drops
 * that line: nothing on Forgejo reads `$GITHUB_OUTPUT` for this job, and
 * keeping the line would be a wired-up mechanism with no reader, which is the
 * exact thing #2294 is about. The tee'd invocation survives either way — it's
 * what puts the run's own JSON record in the log, gate-notice job or not.
 */
function gatedRunStep(
  id: string,
  op: string,
  invocation: string,
  emitOutputs: boolean,
  env: Record<string, string>,
): Record<string, unknown> {
  const lines = [
    "set +e",
    'json="${RUNNER_TEMP:-/tmp}/chant-run-' + op + '.json"',
    'status="${RUNNER_TEMP:-/tmp}/chant-run-' + op + '.status"',
    `{ ${invocation}; echo "$?" >"$status"; } | tee "$json"`,
    'code=$(cat "$status")',
    '[ "$code" -eq 0 ] || exit "$code"',
  ];
  if (emitOutputs) lines.push(`node -e '${GATE_OUTPUT_SCRIPT}' "$json"`);
  return { id, run: lines.join("\n"), env };
}

/**
 * The notice body's `printf` format. Kept out of {@link gateNoticeScript} so
 * the shell quoting stays readable: it is single-quoted in the emitted script
 * because it carries markdown backticks, which a double-quoted shell string
 * would run as command substitution.
 */
const NOTICE_BODY_FORMAT =
  "%s\\n\\nThe `%s` apply for %s stopped at gate `%s` and is waiting for an approval. Nothing was applied." +
  "\\n\\n```\\n%s --approver <you>\\n```\\n\\nThe pending fact is on `_gates/%s.jsonl` on the " +
  "`chant/lifecycle` branch. Approving is a commit: push it and this workflow runs again and applies.\\n";

/**
 * What the notice job posts. The sticky-comment recipe `reconcilePr`'s
 * `comment` mode already uses (#2231), spelled in shell because this job runs
 * no Op: a hidden marker as the body's first line, found again with
 * `startswith` on the next run, PATCHed when it is there and POSTed when it is
 * not. So a branch that merges three times before anyone approves carries one
 * comment saying what is pending, not three.
 *
 * A GitHub `push` event carries no pull request, so the target is looked up:
 * `repos/{repo}/commits/{sha}/pulls` is the commit's own associated-pull-request
 * endpoint, exact rather than a search index, and on a merge commit it answers
 * with the pull request that just merged. When it answers with nothing — a
 * direct push to the branch, a merge whose commit the API does not associate —
 * the notice becomes an issue instead, which is the `issue` finding mode's own
 * recipe and the reason this job carries `issues: write`.
 *
 * `$api_base` (chant #2305), resolved the same way `stickyCommentScript`
 * (`lexicons/github/src/composites/pr-plan-report.ts`) and `reconcilePr`'s
 * `githubApiBaseFrom` (`packages/core/src/op/activities/reconcile.ts`)
 * resolve it: `$GITHUB_API_URL` with a trailing slash trimmed, falling back
 * to `https://api.github.com`. This job never crosses to Forgejo today — the
 * forgejo generator's `gatedNoticeDoc` is never carried across the dialect
 * (#2294) — so github.com and GitHub Enterprise Server are the only hosts
 * that run this script, and both already resolved correctly under `gh`'s own
 * bare-path guess. Built from `$api_base` instead, the URL is byte-identical
 * on those two hosts, and the same anti-pattern that broke Forgejo elsewhere
 * (#2291, #2305) does not get a second copy here in case a future notice job
 * does reach Forgejo.
 */
function gateNoticeScript(): string {
  return [
    'api_base="${GITHUB_API_URL%/}"',
    'api_base="${api_base:-https://api.github.com}"',
    'marker="<!-- chant-gate:$CHANT_OP -->"',
    "body=$(printf '" + NOTICE_BODY_FORMAT + "' " +
      '"$marker" "$CHANT_OP" "$GITHUB_SHA" "$CHANT_GATE" "$CHANT_APPROVE" "$CHANT_OP")',
    'pr=$(gh api "$api_base/repos/$GITHUB_REPOSITORY/commits/$GITHUB_SHA/pulls" --jq ".[0].number // empty")',
    'if [ -z "$pr" ]; then',
    '  gh issue create --title "$CHANT_OP is waiting on gate $CHANT_GATE" --body "$body"',
    "  exit 0",
    "fi",
    'id=$(gh api "$api_base/repos/$GITHUB_REPOSITORY/issues/$pr/comments" --paginate ' +
      '--jq "map(select(.body | startswith(\\"$marker\\"))) | .[0].id // empty" ' +
      '| grep -m1 -E "^[0-9]+$" || true)',
    'if [ -n "$id" ]; then',
    '  gh api --method PATCH "$api_base/repos/$GITHUB_REPOSITORY/issues/comments/$id" -f "body=$body" --jq .html_url',
    "else",
    '  gh api --method POST "$api_base/repos/$GITHUB_REPOSITORY/issues/$pr/comments" -f "body=$body" --jq .html_url',
    "fi",
  ].join("\n");
}

/**
 * The follow-up job: `needs:` the apply, runs only when the apply reported
 * gated, and puts the pending state somewhere other than the Actions log.
 *
 * No `container:`. It needs `gh`, which GitHub-hosted runner images carry and
 * an Op's own image (`node:22-slim` by default) does not; it reads nothing out
 * of the repository, so it also needs no checkout.
 *
 * Its `permissions:` are its own, replacing the workflow-level set for this
 * job alone: `contents: read` for the commit-to-pull-request lookup,
 * `pull-requests: write` for the sticky comment, `issues: write` for the
 * fallback when the push has no pull request. Nothing wider — it opens no
 * branch and merges nothing.
 */
function gateNoticeJob(applyJobName: string): Record<string, unknown> {
  const output = (name: string) => "${{ needs." + applyJobName + ".outputs." + name + ' }}';
  return {
    needs: applyJobName,
    if: `needs.${applyJobName}.outputs.gated == 'true'`,
    "runs-on": "ubuntu-latest",
    permissions: { contents: "read", issues: "write", "pull-requests": "write" },
    steps: [
      {
        name: "Report the pending gate",
        env: {
          GH_TOKEN: "${{ github.token }}",
          GH_REPO: "${{ github.repository }}",
          CHANT_OP: output("op"),
          CHANT_GATE: output("gate"),
          CHANT_APPROVE: output("approve"),
        },
        run: gateNoticeScript(),
      },
    ],
  };
}

/**
 * Refuse `findingMode: "comment"` on a trigger that has no pull request
 * (#2231). The mode's activity reads the triggering PR out of the event
 * payload at run time, so a cron- or push-triggered job carrying it would
 * generate fine and then fail on every run. Refusing here names the Op, the
 * mode and the trigger at build time instead.
 */
function assertTriggerSupportsMode(name: string, mode: OpFindingMode, trigger: OpTrigger): void {
  if (mode !== "comment" || trigger.kind === "pull_request") return;
  throw new Error(
    `Scheduled Op "${name}" has findingMode "comment", which posts its finding on the pull request that ` +
      `triggered the run, but its trigger is "${trigger.kind}". A ${trigger.kind} run has no pull request ` +
      `to comment on. Give it a { kind: "pull_request" } trigger, or use findingMode "issue".`,
  );
}

/**
 * Every scope `GITHUB_TOKEN` accepts in a workflow's `permissions:` mapping,
 * kebab-cased as GitHub spells them. An additive scope outside this set is
 * refused by name rather than emitted: GitHub ignores an unknown key, so
 * `id_token` or `idToken` would generate a workflow that looks like it grants
 * OIDC and hands the run no token at all.
 */
const GITHUB_TOKEN_SCOPES = new Set([
  "actions",
  "attestations",
  "checks",
  "contents",
  "deployments",
  "discussions",
  "id-token",
  "issues",
  "models",
  "packages",
  "pages",
  "pull-requests",
  "repository-projects",
  "security-events",
  "statuses",
]);

/**
 * Refs that name an action repository's own default branch. A generated
 * workflow is committed once and then re-run unattended, often over a cloud
 * role, so "whatever was pushed to that repo last" is not a version — the
 * code that assumes the role can change between the run somebody reviewed and
 * the next one. A release channel the action's author cuts deliberately (`v6`,
 * `v6.2.4`, `stable`) or a commit sha is a version, and both pass: this repo's
 * own workflows pin `actions/checkout@v6` and `dtolnay/rust-toolchain@stable`
 * and name no default branch anywhere.
 */
const DEFAULT_BRANCH_REFS = new Set(["main", "master", "head", "default"]);

/** `owner/repo` or `owner/repo/subpath`, then `@ref`. */
const USES_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)((?:\/[A-Za-z0-9_.-]+)*)@([^\s@]+)$/;

/**
 * Validate a spec's `setup` list (#2242). A `run` entry needs a non-empty
 * line and nothing else. A `uses` entry has to be a pinned
 * `owner/repo[/subpath]@ref`: no bare `owner/repo`, since an unpinned action
 * resolves to its default branch, and no ref in {@link DEFAULT_BRANCH_REFS}
 * for the same reason spelled out loud. Local (`./path`) and container
 * (`docker://`) refs are refused too — they are legal GitHub Actions, but the
 * generator emits a workflow into a repository it has never seen, so it
 * cannot know a local path resolves there.
 */
export function assertSetupSteps(name: string, setup: OpSetupStep[]): void {
  setup.forEach((step, index) => {
    const where = `Scheduled Op "${name}" setup step ${index + 1}`;
    if ("uses" in step) {
      const ref = step.uses.trim();
      const match = USES_PATTERN.exec(ref);
      if (!match) {
        throw new Error(
          `${where} has \`uses: "${step.uses}"\`, which is not a pinned action reference. ` +
            `Write it as owner/repo@ref (optionally owner/repo/subpath@ref), e.g. ` +
            `"aws-actions/configure-aws-credentials@v6". A local "./path" or "docker://" ref is not ` +
            `accepted here: this generator emits a workflow into a repository it cannot inspect, so it ` +
            `has no way to tell whether such a ref resolves there.`,
        );
      }
      const gitRef = match[4];
      if (DEFAULT_BRANCH_REFS.has(gitRef.toLowerCase())) {
        throw new Error(
          `${where} pins \`uses: "${step.uses}"\` to "${gitRef}", the action repository's own default ` +
            `branch, which names whatever was pushed there last rather than a version. A generated ` +
            `workflow is committed once and re-run unattended, often over a cloud role, so pin a release ` +
            `tag or a commit sha instead (e.g. "${match[1]}/${match[2]}@v1" or "@<40-char sha>").`,
        );
      }
      return;
    }
    if (step.run.trim() === "") {
      throw new Error(`${where} has an empty \`run\` line. Give it a command, or drop the entry.`);
    }
  });
}

/**
 * Validate a spec's `environment` (#2257). GitHub creates an environment it
 * has never seen on first use rather than failing the run, and an environment
 * created that way carries no protection rules at all — so a job can name one
 * and read as gated while being gated by nothing. Neither this generator nor
 * GitHub can tell those apart at build time (the environment and its
 * reviewers are repository configuration, not workflow content), which is why
 * what is refused here is only the shape that could never bind: a name that
 * is blank, and a `url` that is neither absolute nor an expression the forge
 * resolves. The rest is the README's job to say out loud.
 */
export function assertEnvironment(name: string, environment: OpEnvironment): void {
  const where = `Scheduled Op "${name}" environment`;
  if (environment.name.trim() === "") {
    throw new Error(
      `${where} has an empty \`name\`. An environment is named repository configuration — the ` +
        `protection rules and reviewers live on the environment, not in this workflow — so there is ` +
        `nothing for a blank name to resolve to. Give it the environment's name, or drop the option.`,
    );
  }
  if (environment.url === undefined) return;
  const url = environment.url.trim();
  if (url === "") {
    throw new Error(
      `${where} "${environment.name}" has an empty \`url\`. Omit the field rather than setting it to "".`,
    );
  }
  if (!/^https?:\/\//.test(url) && !url.includes("${{")) {
    throw new Error(
      `${where} "${environment.name}" has \`url: "${environment.url}"\`, which is neither an absolute ` +
        `http(s) URL nor a \${{ }} expression. GitHub renders this value as the deployment's own link, ` +
        `so a relative path becomes a dead link on the environment page rather than an error anywhere. ` +
        `Write the full URL, or an expression the run resolves to one.`,
    );
  }
}

/**
 * Merge a spec's additive `permissions` over the finding-mode's own set
 * (#2242), refusing by name anything that is not strictly additive:
 *
 *  - a blanket `write-all`/`read-all`, in either the key or the value
 *    position, which is the exact thing {@link permissionsForMode} exists to
 *    avoid;
 *  - a scope GitHub does not define ({@link GITHUB_TOKEN_SCOPES}), because
 *    GitHub ignores the key and the run silently gets nothing;
 *  - a scope the mode already grants, at any value — additive means additive,
 *    so this can neither downgrade `contents: write` to read nor restate it.
 *    A mode whose set is wrong is fixed by changing the mode, where the
 *    scope and the behavior that spends it stay together;
 *  - `pull-requests: write` on a trigger with no pull request. Pull-request
 *    access is what the finding-modes own: `pull-request` grants it together
 *    with the `contents: write` needed to push the branch first, and
 *    `comment` grants it on the one trigger that carries a pull request to
 *    comment on. Adding it beside a mode that posts nothing, on a cron or
 *    push run, grants write access no step in the generated job can spend.
 */
export function mergePermissions(
  name: string,
  base: Record<string, "read" | "write">,
  additive: Record<string, "read" | "write">,
  trigger: OpTrigger,
): Record<string, "read" | "write"> {
  const merged: Record<string, "read" | "write"> = { ...base };
  for (const [rawScope, value] of Object.entries(additive)) {
    const scope = rawScope.trim();
    const where = `Scheduled Op "${name}" adds permission "${scope}: ${value}"`;
    if (scope === "write-all" || scope === "read-all" || String(value).endsWith("-all")) {
      throw new Error(
        `${where}, a blanket grant. \`permissions\` on a scheduled Op is additive over the ` +
          `least-privilege set its finding-mode needs, one named scope at a time. Name the scopes the ` +
          `job actually spends (e.g. { "id-token": "write" }).`,
      );
    }
    if (!GITHUB_TOKEN_SCOPES.has(scope)) {
      throw new Error(
        `${where}, which is not a GITHUB_TOKEN permission scope. GitHub ignores an unrecognized key, so ` +
          `this would emit a workflow that reads as granted and hands the run nothing. Known scopes: ` +
          `${[...GITHUB_TOKEN_SCOPES].sort().join(", ")}.`,
      );
    }
    if (scope in base) {
      throw new Error(
        `${where}, but its finding-mode already grants "${scope}: ${base[scope]}". These permissions are ` +
          `additive only — they never replace, widen or downgrade a scope the mode computed. Change the ` +
          `Op's findingMode if that set is wrong, and add only scopes no mode grants (e.g. "id-token").`,
      );
    }
    if (scope === "pull-requests" && trigger.kind !== "pull_request") {
      throw new Error(
        `${where}, but this Op's trigger is "${trigger.kind}", which carries no pull request. Pull-request ` +
          `write access belongs to a finding-mode: "pull-request" grants it with the contents: write its ` +
          `branch push needs, and "comment" grants it on the pull_request trigger. Set findingMode instead ` +
          `of adding the scope here.`,
      );
    }
    merged[scope] = value;
  }
  return merged;
}

/**
 * Emit a spec's environment as the job's `environment:` mapping. Always the
 * mapping form, never the `environment: name` string shorthand, so adding a
 * `url` later is a new key rather than a reshaped value.
 */
function environmentDoc(environment: OpEnvironment): Record<string, unknown> {
  return {
    name: environment.name,
    ...(environment.url === undefined ? {} : { url: environment.url }),
  };
}

/** Emit one setup entry as a GitHub Actions step. */
function setupStepDoc(step: OpSetupStep): Record<string, unknown> {
  if ("uses" in step) {
    return {
      uses: step.uses,
      ...(step.with && Object.keys(step.with).length > 0 ? { with: step.with } : {}),
      ...(step.env && Object.keys(step.env).length > 0 ? { env: step.env } : {}),
    };
  }
  return {
    run: step.run,
    ...(step.env && Object.keys(step.env).length > 0 ? { env: step.env } : {}),
  };
}

/**
 * Internal knobs beside the public {@link GenerateGithubOpOptions} — not part
 * of that type because they are not something a project author sets, only
 * something a dialect on top of this builder (forgejo, #2294) needs to
 * change about the shape this function emits for every spec alike.
 */
export interface BuildGithubOpPipelineDocsInternalOptions {
  /**
   * Whether a `push` job's outputs (`gated`/`op`/`gate`/`approve`) and the
   * `node -e` step that writes them to `$GITHUB_OUTPUT` are emitted (#2294).
   * Default true (github's own behavior, unchanged): the gate-notice job
   * beside it reads them. The forgejo generator passes `false` — it never
   * carries a gate-notice job (`gatedNoticeDoc` never crosses the dialect),
   * so nothing would ever read them there.
   */
  emitGatedOutputs?: boolean;
}

/**
 * Build one `GithubOpPipelineDoc` per scheduled Op: its trigger, its `setup`
 * steps, least-privilege `permissions:` for its finding-mode plus whatever
 * the spec adds, one job that runs `chant run <name>`. Every
 * `ScheduledOpSpec` is independent — unlike the component generator there is
 * no shared graph to resolve — so the only thing this refuses is a spec that
 * contradicts itself: no trigger at all (`resolveOpTrigger`), `findingMode:
 * "comment"` on a trigger that has no pull request ({@link
 * assertTriggerSupportsMode}), an unpinned `setup` action ({@link
 * assertSetupSteps}), or a `permissions` entry that is not additive ({@link
 * mergePermissions}).
 */
export function buildGithubOpPipelineDocs(
  ops: ScheduledOpSpec[],
  options: GenerateGithubOpOptions = {},
  internalOptions: BuildGithubOpPipelineDocsInternalOptions = {},
): { files: GithubOpPipelineFile[]; jobs: OpPipelineJob[] } {
  const emitGatedOutputs = internalOptions.emitGatedOutputs ?? true;
  const image = options.image ?? DEFAULT_IMAGE;
  const runCommand = options.runCommand ?? ["chant", "run", "{name}"];
  const beforeScript = options.beforeScript ?? [];
  const extraScript = options.extraScript ?? [];

  const files: GithubOpPipelineFile[] = [];
  const jobs: OpPipelineJob[] = [];

  for (const spec of ops) {
    const findingMode = spec.findingMode ?? "report";
    const trigger = resolveOpTrigger(spec);
    assertTriggerSupportsMode(spec.name, findingMode, trigger);
    const jobName = toJobName(spec.name);
    jobs.push({ jobName, op: spec.name, trigger, findingMode });

    const runParts = runCommand.map((part) => part.replace("{name}", spec.name));

    // A live-resolution read (rate limits) always benefits from a token;
    // creating an issue/PR additionally needs `gh` CLI's own token variable.
    const stepEnv: Record<string, string> = { GITHUB_TOKEN: "${{ github.token }}" };
    if (findingMode !== "report") stepEnv.GH_TOKEN = "${{ github.token }}";

    const setup = spec.setup ?? [];
    assertSetupSteps(spec.name, setup);
    if (spec.environment) assertEnvironment(spec.name, spec.environment);

    // A `push` job is the one that has to survive a gate (#2243): the apply
    // runs with `--gated-exit 0` so a pending approval is a green run, and
    // publishes what it stopped on as job outputs for the notice job below.
    // Every other trigger keeps the plain one-line invocation it always had.
    const gated = trigger.kind === "push";
    const invocation = gated
      ? [...runParts, ...GATED_EXIT_FLAG, "--json"].join(" ")
      : runParts.join(" ");

    const steps: Array<Record<string, unknown>> = [{ uses: "actions/checkout@v4" }];
    for (const step of setup) steps.push(setupStepDoc(step));
    for (const line of beforeScript) steps.push({ run: line });
    steps.push(
      gated
        ? gatedRunStep(RUN_STEP_ID, spec.name, invocation, emitGatedOutputs, stepEnv)
        : { run: invocation, env: stepEnv },
    );
    for (const line of extraScript) steps.push({ run: line });

    const doc: GithubOpPipelineDoc = {
      on: onFor(trigger),
      ...(options.variables && Object.keys(options.variables).length > 0 ? { env: options.variables } : {}),
      // One run at a time per Op — a slow audit must not overlap its own next
      // scheduled trigger.
      concurrency: { group: jobName, "cancel-in-progress": false },
      permissions: mergePermissions(
        spec.name,
        permissionsFor(findingMode, trigger),
        spec.permissions ?? {},
        trigger,
      ),
      jobsDoc: {
        [jobName]: {
          "runs-on": "ubuntu-latest",
          container: image,
          // Per-Op credentials (#2290): job-level `env:`, one level more
          // specific than `options.variables`'s workflow-level `env:` above,
          // and never on the notice job beside it — same reason `environment:`
          // isn't either, it's this Op's own job alone.
          ...(spec.variables && Object.keys(spec.variables).length > 0 ? { env: spec.variables } : {}),
          // On this Op's own job and never on the notice job beside it: the
          // notice exists to say a chant gate is pending, and putting it
          // behind the same reviewer would hold the message back until
          // somebody had already acted.
          ...(spec.environment ? { environment: environmentDoc(spec.environment) } : {}),
          ...(gated && emitGatedOutputs
            ? {
                outputs: Object.fromEntries(
                  ["gated", "op", "gate", "approve"].map((name) => [
                    name,
                    `\${{ steps.${RUN_STEP_ID}.outputs.${name} }}`,
                  ]),
                ),
              }
            : {}),
          steps,
        },
      },
      ...(gated ? { gatedNoticeDoc: { [`${jobName}-gate-notice`]: gateNoticeJob(jobName) } } : {}),
    };

    files.push({ name: `${spec.name}.yml`, doc });
  }

  return { files, jobs };
}

/**
 * Emit a `GithubOpPipelineDoc`'s `on`/`env`/`concurrency`/`permissions`/`jobs`
 * mappings as workflow YAML. Shared with the forgejo dialect (#969), which
 * transforms the doc first (and drops `permissions`, which it ignores).
 */
export function emitOpPipelineYAML(doc: GithubOpPipelineDoc): string {
  const sections: string[] = [];
  // A dialect's note about what it could not carry (#2257), when there is
  // one. Absent on github, so an unannotated document is emitted exactly as
  // it was before the field existed.
  if (doc.header && doc.header.length > 0) sections.push(doc.header.join("\n"));
  sections.push("on:" + emitYAML(doc.on, 1));
  if (doc.env && Object.keys(doc.env).length > 0) sections.push("env:" + emitYAML(doc.env, 1));
  sections.push("concurrency:" + emitYAML(doc.concurrency, 1));
  if (Object.keys(doc.permissions).length > 0) sections.push("permissions:" + emitYAML(doc.permissions, 1));
  // The gated-apply notice job rides in `jobs:` beside the Op's own job, but
  // is carried separately on the doc so a dialect that cannot run it (forgejo,
  // whose runner has no `gh` pointed at its own instance) drops it by omission.
  sections.push("jobs:" + emitYAML({ ...doc.jobsDoc, ...(doc.gatedNoticeDoc ?? {}) }, 1));
  return sections.join("\n\n") + "\n";
}

/**
 * Synthesize one `.github/workflows/*.yml` per scheduled Op. Thin wrapper
 * over {@link buildGithubOpPipelineDocs} + {@link emitOpPipelineYAML}. Wired
 * into core's Op generate mode via the github lexicon plugin's
 * `generateOpPipeline` (../plugin.ts).
 */
export function generateGithubOpPipeline(
  ops: ScheduledOpSpec[],
  options: GenerateGithubOpOptions = {},
): GenerateGithubOpResult {
  const { files, jobs } = buildGithubOpPipelineDocs(ops, options);
  return {
    files: files.map((f) => ({ name: f.name, yaml: emitOpPipelineYAML(f.doc) })),
    jobs,
  };
}
