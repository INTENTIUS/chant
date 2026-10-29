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

import { readFileSync } from "node:fs";
import {
  assertEnvironment,
  assertSetupSteps,
  CI_IMAGE,
  ciJobName,
  environmentDoc,
  fillCommand,
  GITHUB_JOB_TOKEN,
  githubRunsOn,
  mergePermissions,
  nonEmpty,
  permissionsFor,
  setupStepDoc,
} from "@intentius/chant/ci-jobs";
import { memberPathFilter, resolveOpTrigger } from "@intentius/chant/lexicon";
import type {
  ComponentPipelineOptions as GenerateGithubOpOptions,
  OpFindingMode,
  OpPipelineJob,
  OpPipelineResult as GenerateGithubOpResult,
  OpTrigger,
  PipelineMember,
  ScheduledOpSpec,
} from "@intentius/chant/lexicon";
import { checkoutStep, concurrency, emitWorkflowYAML, jobTokenEnv, onTrigger, opConcurrencyGroup, runSteps } from "./ci-jobs";
import { assertReviewSplit, reviewJobs, reviewNoteJobName } from "./review-jobs";
import { resolveAgentSpec } from "@intentius/chant/ci-agent";
import { activeProductWords } from "@intentius/chant/ci-product-words";
import { agentJobName, agentPushJobName, driftRunOutputs, driftRunStep, githubAgentJobs } from "./agent-jobs";
import { assertScheduledOpCloud, scheduledOpUpdateJobName, withoutTokenRequestLine } from "@intentius/chant/scheduled-op-cloud";
import { TRADE_SPEC_ENV, tradeLine, type CloudTradeSpec } from "@intentius/chant/ci-identity";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";

export type { GenerateGithubOpOptions, GenerateGithubOpResult };

// The setup, environment and permission checks are shared with the Op waves
// generator and the forgejo lexicon (#3765); they stay importable from here.
export { assertEnvironment, assertSetupSteps, mergePermissions };

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
   * The workflow's `name:` (#2580): the Op's name, so the Actions UI lists
   * the workflow by its Op instead of its file name. The forgejo generator
   * copies it too (#2601), since Forgejo Actions reads the key the same way.
   */
  name?: string;
  /**
   * The `on:` trigger mapping, per {@link ScheduledOpSpec}'s trigger kind
   * (#2084): `{ schedule, workflow_dispatch }` for cron, `{ pull_request }`
   * for `pull_request`, `{ push }` for `push`.
   */
  on: Record<string, unknown>;
  /** The `env:` mapping, when `options.variables` is set. */
  env?: Record<string, unknown>;
  /** The `concurrency:` mapping — one run at a time per Op. Absent on a waves file (ruling for ci-products 2026-10-28). */
  concurrency?: Record<string, unknown>;
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
   * Kept out of {@link jobsDoc} so a dialect transforms it on its own terms;
   * the forgejo generator carries it across since #3773, when the job moved
   * off `gh` onto `@intentius/chant/pr-forge`. {@link emitOpPipelineYAML}
   * merges it into `jobs:`. GitLab reaches the same outcome
   * without this job at all: its push job writes the pending block to an
   * artifact instead (#2256).
   */
  gatedNoticeDoc?: Record<string, unknown>;
  /**
   * The review note job (#4326), when the spec sets `reviewAgent`. Kept out
   * of {@link jobsDoc} for the reason the gate notice is: a member's
   * `working-directory` default belongs to the job that runs the Op, and a
   * dialect transforms this job on its own terms.
   */
  reviewNoteDoc?: Record<string, unknown>;
  /**
   * The agent jobs (#4616), when the spec sets `agent`: the agent job and
   * the push job. Kept out of {@link jobsDoc} so a member's
   * `working-directory` default stays on the Op's own job: these check out
   * at the repository root.
   */
  agentDoc?: Record<string, unknown>;
}

/** One generated file: a suggested name plus its pipeline document, pre-emission. */
export interface GithubOpPipelineFile {
  /** Suggested file name (`<op-name>.yml`), relative to the provider's workflow directory. */
  name: string;
  doc: GithubOpPipelineDoc;
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
 * through `steps.<id>.outputs`/`needs.<job>.outputs`. Forgejo dropped both
 * while it had no notice job (#2294) and carries them again since #3773. The
 * tee'd invocation is what puts the run's own JSON record in the log.
 */
function gatedRunStep(
  id: string,
  op: string,
  invocation: string,
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
  lines.push(`node -e '${GATE_OUTPUT_SCRIPT}' "$json"`);
  return { id, run: lines.join("\n"), env };
}

/**
 * The chant release the notice job installs: this lexicon's own version.
 * The github lexicon and `@intentius/chant` release in lockstep, so the pr-forge
 * a generated workflow runs is the one this generator was built against, and
 * it changes only when the workflow is regenerated, the same as a pinned
 * action ref.
 */
function chantVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version === "") {
    throw new Error("the github lexicon's package.json has no version to pin the gate-notice job's chant to");
  }
  return pkg.version;
}

/**
 * What the notice job runs under node (#3773): the sticky-comment recipe
 * `reconcilePr`'s `comment` mode uses, through the same
 * `@intentius/chant/pr-forge` clients, so it posts on GitHub, GitHub
 * Enterprise Server and Forgejo alike. `forgeTargetFromEnv` reads the forge,
 * the REST base, the repository, the commit and the token off the job's
 * environment (`FORGE_TOKEN_ORDER`: `CHANT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` on
 * GitHub; `CHANT_FORGEJO_TOKEN` first on Forgejo), the order `reconcilePr` reads too (#3807),
 * and `pullRequestFor` is the commit-to-pull-request lookup each forge spells
 * its own way (`commits/{sha}/pulls` on GitHub, `commits/{sha}/pull` on
 * Forgejo). A commit with no pull request, a direct push, gets a tracking
 * issue keyed on the same marker, so a second gated push edits it rather
 * than opening another.
 *
 * Plain JavaScript in double-quoted strings, so the markdown backticks need
 * no escaping and nothing in it reads as a `${{ }}` expression.
 */
const NOTICE_SCRIPT = [
  'import { forgeClient, forgeTargetFromEnv } from "@intentius/chant/pr-forge";',
  "const { CHANT_OP: op, CHANT_GATE: gate, CHANT_APPROVE: approve } = process.env;",
  "const target = forgeTargetFromEnv(process.env);",
  "const forge = forgeClient(target);",
  'const marker = "<!-- chant-gate:" + op + " -->";',
  'const fence = "```";',
  "const body = [",
  "  marker,",
  '  "",',
  '  "The `" + op + "` apply for " + target.sha + " stopped at gate `" + gate + "` and is waiting for an approval. Nothing was applied.",',
  '  "",',
  "  fence,",
  '  approve + " --approver <you>",',
  "  fence,",
  '  "",',
  '  "The pending fact is on `_gates/" + op + ".jsonl` on the `chant/lifecycle` branch. Approving is a commit: push it and this workflow runs again and applies.",',
  '].join("\\n") + "\\n";',
  "const pr = target.sha ? await forge.pullRequestFor(target.sha) : null;",
  "const url = pr",
  "  ? await forge.upsertNote(pr, marker, body)",
  '  : await forge.upsertIssue(marker, op + " is waiting on gate " + gate, body);',
  'console.log(url ?? (pr ? "commented on #" + pr : "kept the tracking issue"));',
].join("\n");

/**
 * The notice step's shell (#3773). It installs the pinned chant into the
 * runner's temp directory and runs {@link NOTICE_SCRIPT} with tsx, which
 * chant depends on and which is how `chant` itself runs its TypeScript.
 * `--omit=peer` keeps chant's optional vitest peer out: about 17 packages,
 * a few seconds. The `package.json` written first stops npm from walking up
 * to some other project root. No checkout and no `beforeScript`: the job
 * reads nothing out of the repository.
 */
function gateNoticeScript(version: string): string {
  return [
    'dir="${RUNNER_TEMP:-/tmp}/chant-gate-notice"',
    'mkdir -p "$dir"',
    'cd "$dir"',
    "echo '{\"private\":true}' > package.json",
    `npm install --omit=peer --no-audit --no-fund --loglevel=error @intentius/chant@${version}`,
    "cat > notice.mjs <<'NOTICE'",
    NOTICE_SCRIPT,
    "NOTICE",
    "node --import tsx notice.mjs",
  ].join("\n");
}

/**
 * The follow-up job: `needs:` the apply, runs only when the apply reported
 * gated, and puts the pending state somewhere other than the Actions log.
 *
 * It runs in the Op's own image, which carries node and npm by construction
 * (the apply's `node -e` output step needs them too), so it runs the same on
 * GitHub's hosted runners and on a Forgejo runner. It checks nothing out.
 *
 * Its `permissions:` are its own, replacing the workflow-level set for this
 * job alone: `contents: read` for the commit-to-pull-request lookup,
 * `pull-requests: write` for the sticky comment, `issues: write` for the
 * tracking issue when the push has no pull request. Nothing wider: it opens
 * no branch and merges nothing. The Forgejo dialect drops them, as it drops
 * every scope but `id-token`.
 */
function gateNoticeJob(applyJobName: string, image: string, runner?: ScheduledOpSpec["runner"]): Record<string, unknown> {
  const output = (name: string) => "${{ needs." + applyJobName + ".outputs." + name + ' }}';
  return {
    needs: applyJobName,
    if: `needs.${applyJobName}.outputs.gated == 'true'`,
    "runs-on": githubRunsOn(runner),
    container: image,
    permissions: { contents: "read", issues: "write", "pull-requests": "write" },
    steps: [
      {
        name: "Report the pending gate",
        env: {
          GITHUB_TOKEN: GITHUB_JOB_TOKEN,
          CHANT_OP: output("op"),
          CHANT_GATE: output("gate"),
          CHANT_APPROVE: output("approve"),
        },
        run: gateNoticeScript(chantVersion()),
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
  forge: "github" | "forgejo" = "github",
): { files: GithubOpPipelineFile[]; jobs: OpPipelineJob[] } {
  const image = options.image ?? CI_IMAGE;
  const runCommand = options.runCommand ?? ["chant", "run", "{name}"];
  const beforeScript = options.beforeScript ?? [];
  const extraScript = options.extraScript ?? [];

  const files: GithubOpPipelineFile[] = [];
  const jobs: OpPipelineJob[] = [];

  const words = activeProductWords();
  for (const spec of ops) {
    // #4631: the job's cloud identities and the update on drift, checked before anything renders.
    assertScheduledOpCloud(spec);
    // #4616: the comment agent is a workflow of its own, on pull request comments; the spec's trigger is not read.
    if (spec.agent?.on === "comment") {
      const settings = resolveAgentSpec(spec.name, spec.agent, words.product);
      const jobName = ciJobName(spec.name);
      const setup = spec.setup ?? [];
      assertSetupSteps(spec.name, setup);
      jobs.push({ jobName, op: spec.name, trigger: { kind: "pull_request" }, findingMode: "report" });
      const { agent, push } = githubAgentJobs({
        forge,
        jobName,
        image,
        settings,
        ...(spec.runner !== undefined ? { runner: spec.runner } : {}),
        setup: setup.map(setupStepDoc),
        beforeScript,
        ...(spec.agent.tokenEnv ? { tokenEnv: spec.agent.tokenEnv } : {}),
        ...(words.bin ? { bin: words.bin } : {}),
      });
      files.push({
        name: `${spec.name}.yml`,
        doc: {
          name: spec.name,
          on: { issue_comment: { types: ["created"] } },
          ...nonEmpty("env", options.variables),
          // One agent run at a time, so two asks never count the limit at once.
          concurrency: concurrency(jobName),
          permissions: { contents: "read" },
          jobsDoc: {},
          agentDoc: { [jobName]: agent, [agentPushJobName(jobName)]: push },
        },
      });
      continue;
    }
    const findingMode = spec.findingMode ?? "report";
    const trigger = resolveOpTrigger(spec);
    assertTriggerSupportsMode(spec.name, findingMode, trigger);
    const jobName = ciJobName(spec.name);
    jobs.push({ jobName, op: spec.name, trigger, findingMode });

    const runParts = fillCommand(runCommand, spec.name);

    // A live-resolution read (rate limits) always benefits from a token;
    // creating an issue/PR additionally needs `gh` CLI's own token variable.
    // A split review (#4326) runs the change's code beside a model: no step of that job holds a forge token.
    const split = spec.reviewAgent === true;
    if (split) assertReviewSplit(spec.name, trigger, findingMode, spec.permissions);
    // #4616: a drift agent follows the Op's job, which hands its output on and says whether it found drift.
    const driftAgent = spec.agent?.on === "drift" ? resolveAgentSpec(spec.name, spec.agent, words.product) : undefined;
    if (driftAgent && (split || trigger.kind === "push")) {
      throw new Error(`Scheduled Op "${spec.name}" sets a drift agent, which follows a drift check's run; give it a cron or pull_request trigger and no reviewAgent.`);
    }
    const stepEnv = split ? {} : jobTokenEnv(findingMode !== "report");
    const cloud = spec.cloud;
    const update = spec.update;

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

    const later: Array<Record<string, unknown>> = [...setup.map(setupStepDoc), ...runSteps(beforeScript)];
    later.push(
      gated
        ? gatedRunStep(RUN_STEP_ID, spec.name, invocation, stepEnv)
        : driftAgent
          ? driftRunStep(invocation, stepEnv, forge)
          : update
            ? driftFlagStep(invocation, stepEnv)
            : { run: invocation, env: stepEnv },
    );
    later.push(...runSteps(extraScript));
    // #4631: the trade before the checkout, and every step after it without the token request variables.
    const steps: Array<Record<string, unknown>> = cloud ? [tradeStep(cloud), checkoutStep(), ...later.map(withoutTokenRequest)] : [checkoutStep(), ...later];

    const review = split
      ? reviewJobs({
          name: spec.name,
          jobName,
          image,
          invocation,
          setup: setup.map(setupStepDoc),
          beforeScript,
          extraScript,
          ...(spec.variables ? { variables: spec.variables } : {}),
          ...(options.member ? { member: options.member } : {}),
        })
      : undefined;

    const workflowPermissions = mergePermissions(
      spec.name,
      permissionsFor(findingMode, trigger),
      spec.permissions ?? {},
      trigger,
    );
    const doc: GithubOpPipelineDoc = {
      name: spec.name,
      on: onTrigger(trigger),
      ...nonEmpty("env", options.variables),
      // One run at a time per Op — a slow audit must not overlap its own next
      // scheduled trigger. A push Op's `build` (#4169) widens the group.
      concurrency: concurrency(opConcurrencyGroup(jobName, trigger)),
      permissions: workflowPermissions,
      jobsDoc: {
        [jobName]: {
          "runs-on": githubRunsOn(spec.runner),
          container: image,
          // Per-Op credentials (#2290): job-level `env:`, one level more
          // specific than `options.variables`'s workflow-level `env:` above,
          // and never on the notice job beside it — same reason `environment:`
          // isn't either, it's this Op's own job alone.
          ...nonEmpty("env", spec.variables),
          // On this Op's own job and never on the notice job beside it: the
          // notice exists to say a chant gate is pending, and putting it
          // behind the same reviewer would hold the message back until
          // somebody had already acted.
          ...(spec.environment ? { environment: environmentDoc(spec.environment) } : {}),
          // #4631: the trade needs id-token: write, on this job alone; the finding-mode's scopes stay as they are.
          ...(cloud ? { permissions: { ...workflowPermissions, "id-token": "write" } } : {}),
          ...(gated
            ? {
                outputs: Object.fromEntries(
                  ["gated", "op", "gate", "approve"].map((name) => [
                    name,
                    `\${{ steps.${RUN_STEP_ID}.outputs.${name} }}`,
                  ]),
                ),
              }
            : driftAgent
              ? { outputs: driftRunOutputs(forge) }
              : update
                ? { outputs: { drift: `\${{ steps.${DRIFT_FLAG_STEP_ID}.outputs.drift }}` } }
                : {}),
          steps,
        },
        ...(update
          ? {
              [scheduledOpUpdateJobName(jobName)]: updateJob(jobName, update, {
                image,
                ...(spec.runner !== undefined ? { runner: spec.runner } : {}),
                setup: setup.map(setupStepDoc),
                beforeScript,
              }),
            }
          : {}),
      },
      ...(gated ? { gatedNoticeDoc: { [`${jobName}-gate-notice`]: gateNoticeJob(jobName, image, spec.runner) } } : {}),
    };
    if (driftAgent) {
      const name = agentJobName(jobName, "drift");
      const { agent, push } = githubAgentJobs({
        forge,
        jobName: name,
        image,
        settings: driftAgent,
        ...(spec.runner !== undefined ? { runner: spec.runner } : {}),
        setup: setup.map(setupStepDoc),
        beforeScript,
        ...(spec.agent?.tokenEnv ? { tokenEnv: spec.agent.tokenEnv } : {}),
        ...(words.bin ? { bin: words.bin } : {}),
        after: jobName,
      });
      doc.agentDoc = { [name]: agent, [agentPushJobName(name)]: push };
    }
    // A split review (#4326): the Op's job is the review job, and the note job rides beside it.
    if (review) {
      const runsOn = spec.runner !== undefined ? { "runs-on": githubRunsOn(spec.runner) } : {};
      doc.jobsDoc = { [jobName]: { ...review.review, ...runsOn, ...(spec.environment ? { environment: environmentDoc(spec.environment) } : {}) } };
      doc.reviewNoteDoc = { [reviewNoteJobName(jobName)]: { ...review.note, ...runsOn } };
    }

    files.push({ name: `${spec.name}.yml`, doc });
  }

  if (options.member) {
    const member = options.member;
    return { files: files.map((f) => scopeOpFileToMember(f, member)), jobs };
  }
  return { files, jobs };
}

/**
 * Scope one Op's workflow to a workspace member (#2542, #2524 D19). The file
 * and the workflow take the member's name (`<member>-<op>.yml`, `<member>/<op>`)
 * and so does the concurrency group, which GitHub keys across the whole
 * repository. A `push` or `pull_request` trigger is filtered to the member's
 * paths and this file; a cron trigger has no paths to filter. The Op's own
 * job starts its `run:` steps in the member's directory. The gate-notice job
 * checks nothing out and keeps the default.
 */
function scopeOpFileToMember(file: GithubOpPipelineFile, member: PipelineMember): GithubOpPipelineFile {
  const name = `${member.name}-${file.name}`;
  const paths = memberPathFilter(member, member.fileDir ? `${member.fileDir}/${name}` : undefined);
  const on: Record<string, unknown> = { ...file.doc.on };
  for (const event of ["push", "pull_request"]) {
    if (event in on) on[event] = { ...(on[event] as Record<string, unknown>), paths };
  }
  const rooted = member.dir === "." || member.dir === "";
  const jobsDoc = rooted
    ? file.doc.jobsDoc
    : Object.fromEntries(
        Object.entries(file.doc.jobsDoc).map(([job, props]) => {
          const { steps, ...rest } = props as Record<string, unknown>;
          return [job, { ...rest, defaults: { run: { "working-directory": member.dir } }, steps }];
        }),
      );
  const group = (file.doc.concurrency as { group?: unknown } | undefined)?.group;
  return {
    name,
    doc: {
      ...file.doc,
      ...(file.doc.name ? { name: `${member.name}/${file.doc.name}` } : {}),
      on,
      ...(file.doc.concurrency ? { concurrency: { ...file.doc.concurrency, ...(typeof group === "string" ? { group: `${member.name}-${group}` } : {}) } } : {}),
      jobsDoc,
    },
  };
}

/**
 * Emit a `GithubOpPipelineDoc`'s `on`/`env`/`concurrency`/`permissions`/`jobs`
 * mappings as workflow YAML. Shared with the forgejo dialect (#969), which
 * transforms the doc first (and drops `permissions`, which it ignores).
 */
export function emitOpPipelineYAML(doc: GithubOpPipelineDoc): string {
  // The gated-apply notice job rides in `jobs:` beside the Op's own job; it
  // is carried separately on the doc so a dialect transforms it on its own.
  // A dialect's `header` note (#2257) is absent on github.
  const { gatedNoticeDoc, reviewNoteDoc, agentDoc, ...workflow } = doc;
  return emitWorkflowYAML({ ...workflow, jobsDoc: { ...doc.jobsDoc, ...(gatedNoticeDoc ?? {}), ...(reviewNoteDoc ?? {}), ...(agentDoc ?? {}) } });
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

/** The id of the run step that says whether an update's drift check found drift (#4631). */
const DRIFT_FLAG_STEP_ID = "drift-check";

/** The Op's run step when an update follows it (#4631): `drift=true` as an output on chant's drift code, and the run's own exit code. */
function driftFlagStep(invocation: string, env: Record<string, string>): Record<string, unknown> {
  return {
    id: DRIFT_FLAG_STEP_ID,
    env,
    run: ["set +e", invocation, "code=$?", `if [ "$code" -eq ${CHANT_EXIT.drift} ]; then echo "drift=true" >>"$GITHUB_OUTPUT"; fi`, 'exit "$code"'].join("\n"),
  };
}

/** The trade step (#4631), as an op wave job's (#4332): the job's OIDC token for `cloud`, written to GITHUB_ENV. */
function tradeStep(cloud: CloudTradeSpec): Record<string, unknown> {
  return { name: "Trade the job's OIDC token for its cloud identities", env: { [TRADE_SPEC_ENV]: JSON.stringify(cloud) }, run: tradeLine("$GITHUB_ENV", "github-env") };
}

/** A run step after the trade, with the token request variables unset first. A `uses:` step is left as it is. */
function withoutTokenRequest(step: Record<string, unknown>): Record<string, unknown> {
  return typeof step.run === "string" ? { ...step, run: withoutTokenRequestLine(step.run) } : step;
}

/**
 * The update job (#4631): after the Op's job, only when its run found
 * drift; its own trade for `update.cloud` before its checkout, then the
 * update's command. Its permissions are `contents: read`, `id-token: write`
 * with a cloud, and the update's own scopes, which may raise `contents` to
 * `write` so the update records on `chant/lifecycle` (2026-10-28 ruling).
 * The Op's own job keeps its scopes.
 */
function updateJob(
  after: string,
  update: NonNullable<ScheduledOpSpec["update"]>,
  i: { image: string; runner?: ScheduledOpSpec["runner"]; setup: Array<Record<string, unknown>>; beforeScript: readonly string[] },
): Record<string, unknown> {
  const later: Array<Record<string, unknown>> = [...i.setup, ...runSteps(i.beforeScript), { name: "Update what drifted", run: update.command }];
  return {
    needs: after,
    if: `always() && needs.${after}.outputs.drift == 'true'`,
    "runs-on": githubRunsOn(i.runner),
    container: i.image,
    permissions: { contents: "read", ...(update.cloud ? { "id-token": "write" } : {}), ...(update.permissions ?? {}) },
    ...nonEmpty("env", update.variables),
    ...(update.environment ? { environment: environmentDoc(update.environment) } : {}),
    steps: update.cloud ? [tradeStep(update.cloud), checkoutStep(), ...later.map(withoutTokenRequest)] : [checkoutStep(), ...later],
  };
}
