/**
 * The product plan workflow on GitHub Actions (#4799): the pull request plan
 * jobs of a product whose plan step runs its own plan verb, written from
 * `ProductPipelineOptions` with no component graph. A product calls it in
 * process and writes the YAML, or adds its own jobs to the document first.
 *
 * Each plan job (`plan`, or `plan-<target>`) holds no forge token while the
 * change's code runs (#4295): the checkout script alone sees the job's
 * token, every later step starts without the token variables, and the plan
 * verb is the job's last step, handing `.chant/pr` on as the job's outputs.
 * A target's variables and secrets are on its write probe and its plan step
 * only. The note job (`plan-note`, or `plan-note-<target>`) checks out the
 * target branch's commit, takes the directory back, keeps it as the run's
 * artifact, and posts the note and the plan status with `pr-post`, which
 * renders a `PrReport` or a product's plan note hand-off.
 *
 * With `forks: "skip"` neither job runs for a pull request from a fork.
 *
 * With `evidence` (#4870) the note job signs the plan job's `plan` and
 * `policy` checks from the report it took back, before it posts, so the
 * note says which were signed; the job then pushes `refs/notes/chant/evidence`, so it
 * asks for `contents: write`.
 *
 * With `productPlan.record` (#4899) the plan step writes the plan job's
 * run record into `.chant/pr`, and the note job keeps it on
 * `chant/lifecycle` with `pr-post --record-run`, so it asks for `contents:
 * write`. With `checkJob` and `refGateStatus` (#4935) the check, check
 * evidence and ref gate jobs come after the note jobs (`./pr-check-jobs.ts`).
 *
 * Forgejo renders the same document through its dialect
 * (`generateForgejoProductPlanPipeline` in the forgejo lexicon).
 */

import { CI_IMAGE, GITHUB_JOB_TOKEN, githubRunsOn } from "@intentius/chant/ci-jobs";
import { CHECKOUT_TOKEN_ENV, checkoutScript, dropForgeTokens, handoverOutputs, handoverTrap, takeOverScript } from "@intentius/chant/ci-handover";
import { PR_LOOP_REPORT_DIR, prLoopSetup } from "@intentius/chant/components/pr-pipeline";
import { productPipelineJobs, type ProductPipelineJobs, type ProductPipelineOptions } from "@intentius/chant/components/product-pipeline";
import { PENDING_JS, PLAN_ARGUMENT_ENV, PLAN_NOTE_NOTICES_ENV, planVerbLines, REPLAN_DECIDE_JS, SAME_REPOSITORY_IF, type ProductPlanJob, type ProductPlanOptions } from "@intentius/chant/components/product-plan";
import { productStatusContext } from "@intentius/chant/ci-product-words";
import { CHECKOUT, emitWorkflowYAML, runSteps, UPLOAD_ARTIFACT, type GithubWorkflowDoc } from "./ci-jobs";
import { githubCheckJobs } from "./pr-check-jobs";

/** What {@link generateProductPlanPipeline} takes: the product pipeline's options with `productPlan`, and how the jobs are set up. */
export interface ProductPlanPipelineOptions extends ProductPipelineOptions {
  productPlan: ProductPlanOptions;
  /** The image every job runs in. Default chant's CI image, which gets the engine setup lines. */
  image?: string;
  /** Lines after the setup in every job, such as the product's install. In the plan job they run without the forge tokens. */
  beforeScript?: string[];
  /** Lines after the plan verb, in the plan step. */
  extraScript?: string[];
  /** Comment lines above the document, `#` included. */
  header?: string[];
}

/** The product plan workflow: its YAML, the document it was emitted from, and the product pipeline's jobs. */
export interface ProductPlanPipeline {
  yaml: string;
  doc: GithubWorkflowDoc;
  jobs: ProductPipelineJobs;
}

/** The plan step's id, whose outputs carry the hand-off directory to the note job. */
const PLAN_STEP_ID = "plan";

/** The product plan workflow's document for GitHub or Forgejo (#4799). */
export function buildProductPlanGithubDoc(forge: "github" | "forgejo", env: string, options: ProductPlanPipelineOptions): { doc: GithubWorkflowDoc; jobs: ProductPipelineJobs } {
  const { image: given, beforeScript = [], extraScript = [], header, ...pipeline } = options;
  const image = given ?? CI_IMAGE;
  const jobs = productPipelineJobs(forge, env, pipeline);
  const plans = jobs.productPlan!;
  const plan = options.productPlan;
  const branch = options.branch ?? "main";
  const fork = plan.forks === "skip" ? ` && ${SAME_REPOSITORY_IF}` : "";
  const drop = dropForgeTokens("sh");
  const headStep = (line: string, cond?: string): Record<string, unknown> => ({ ...(cond ? { if: cond } : {}), run: `${drop}\n${line}` });
  const setup = [...prLoopSetup(image, options.engineSetup), ...beforeScript];
  const targets = plans.flatMap((p) => (p.target ? [p.target] : []));
  // The steps between the checkout and the plan step (#4899, #4931): the control read, the product's steps, the setup lines, the login and the probe.
  const middle = (p: ProductPlanJob, env: Record<string, string>, cond?: string): Record<string, unknown>[] => [
    ...(p.control ? [{ ...(cond ? { if: cond } : {}), name: p.control.stepName, env: p.control.env, run: p.control.script }] : []),
    ...(p.setup ?? []).map((s) =>
      s.uses !== undefined
        ? { ...(cond ? { if: cond } : {}), ...(s.name ? { name: s.name } : {}), uses: s.uses, ...(s.with ? { with: s.with } : {}), ...(s.env ? { env: s.env } : {}) }
        : { ...(cond ? { if: cond } : {}), ...(s.name ? { name: s.name } : {}), ...(s.env ? { env: s.env } : {}), run: `${drop}\n${s.run}` },
    ),
    ...setup.map((line) => headStep(line, cond)),
    ...(p.login ?? []).map((st) => ({ ...(cond ? { if: cond } : {}), name: st.name, run: `${drop}\n${st.run.join("\n")}` })),
    ...(p.writeProbe ? [{ ...(cond ? { if: cond } : {}), name: "This job cannot write", env, run: `${drop}\n${p.writeProbe}` }] : []),
  ];
  const planRun = (p: ProductPlanJob, before: string[] = []): string => [drop, ...handoverTrap(PR_LOOP_REPORT_DIR, forge), ...before, ...planVerbLines(p), ...extraScript].join("\n");
  const permissions = (p: ProductPlanJob): Record<string, string> => ({ contents: "read", ...(p.pending ? { statuses: "write" } : {}), ...(p.idTokens ? { "id-token": "write" } : {}) });
  const pendingStep = (p: ProductPlanJob, sha: string, cond?: string): Record<string, unknown>[] =>
    p.pending
      ? [{
          ...(cond ? { if: cond } : {}),
          name: "Say on the head that the plan started",
          env: { CHANT_PENDING_TOKEN: GITHUB_JOB_TOKEN, CHANT_PENDING_SHA: sha, CHANT_PENDING_CONTEXT: p.pending.context, CHANT_PENDING_DESCRIPTION: p.pending.description },
          run: `(cd / && node -e '${PENDING_JS}')`,
        }]
      : [];
  // #4931: the note job's own lines, before pr-post (writing notices to a file outside the report) and after it.
  // The file is named in the step's shell: RUNNER_TEMP is the container's, which `runner.temp` is not in a container job.
  const notices = `export ${PLAN_NOTE_NOTICES_ENV}="\${RUNNER_TEMP:-/tmp}/chant-plan-note-notices"`;
  const noteBefore = (p: ProductPlanJob): Record<string, unknown>[] => (p.noteSteps?.before.length ? [{ name: "The product's lines before the note", if: "always()", env: { GITHUB_TOKEN: GITHUB_JOB_TOKEN }, run: [notices, ...p.noteSteps.before].join("\n") }] : []);
  const noteAfter = (p: ProductPlanJob): Record<string, unknown>[] => (p.noteSteps?.after.length ? [{ name: "The product's lines after the note", if: "always()", env: { GITHUB_TOKEN: GITHUB_JOB_TOKEN }, run: p.noteSteps.after.join("\n") }] : []);
  const postRun = (p: ProductPlanJob, command: string): string => (p.noteSteps?.before.length ? `${notices}\n${command}` : command);
  const jobsDoc: Record<string, unknown> = {};
  for (const p of plans) {
    jobsDoc[p.jobName] = {
      if: `github.event_name == 'pull_request'${fork}`,
      "runs-on": githubRunsOn(p.runner),
      container: image,
      permissions: permissions(p),
      ...(p.jobEnv ? { env: p.jobEnv } : {}),
      outputs: handoverOutputs(PLAN_STEP_ID, forge),
      steps: [
        // #4899: before the checkout, the one step that holds the token for the status.
        ...pendingStep(p, "${{ github.sha }}"),
        // A script, not actions/checkout, whose post step runs at the job's end with the token as its input.
        { name: "Check out the change", env: { [CHECKOUT_TOKEN_ENV]: GITHUB_JOB_TOKEN }, run: checkoutScript(true, true) },
        ...middle(p, p.env),
        // The job's last step: a step after it would start beside whatever the change's code left running.
        {
          name: p.target ? `Plan ${p.target}` : "Plan the change",
          id: PLAN_STEP_ID,
          // #4899: with record, the record line reads its op, environment and labels.
          env: p.record ? { ...p.env, ...p.record.env } : p.env,
          run: planRun(p),
        },
      ],
    };
    jobsDoc[p.noteJobName] = {
      needs: [p.jobName],
      if: `always() && github.event_name == 'pull_request'${fork} && (needs.${p.jobName}.result == 'success' || needs.${p.jobName}.result == 'failure')`,
      "runs-on": githubRunsOn(p.noteRunner),
      container: image,
      // #4289: `actions: read` lets pr-post ask when each scheduled watch last ran.
      // #4870: with evidence, `contents: write` pushes the signed checks to refs/notes/chant/evidence, where the ref gate (#4867) reads them.
      // #4869: signing keyless, the job asks for its OIDC token; Forgejo's dialect turns it into enable-openid-connect.
      // #4899: with record, `contents: write` pushes chant/lifecycle with the plan job's run record.
      permissions: { actions: "read", contents: p.evidence || p.record ? "write" : "read", "pull-requests": "write", statuses: "write", ...(p.evidence?.idToken ? { "id-token": "write" } : {}) },
      steps: [
        // The target branch's commit: the bin this job runs is the target branch's, and none of the change's code is here.
        { name: "Check out the target branch's commit", uses: CHECKOUT, with: { ref: "${{ github.event.pull_request.base.sha }}" } },
        ...runSteps(beforeScript),
        { name: "Take the plan report from the plan job", run: takeOverScript(p.jobName, PR_LOOP_REPORT_DIR, forge) },
        // #4870: the runner key (or #4869 the keyless signing) is in this step alone, in a job that runs none of the change's code.
        ...(p.evidence ? [{ name: "Sign the plan and policy evidence", if: "always()", env: p.evidence.env, run: p.evidence.lines.join("\n") }] : []),
        { name: "Keep the plan report", if: "always()", uses: UPLOAD_ARTIFACT, with: { name: p.artifact, path: PR_LOOP_REPORT_DIR, "if-no-files-found": "ignore", "include-hidden-files": true } },
        ...noteBefore(p),
        { name: `Post the plan note and ${productStatusContext(jobs.words, "plan", p.target)}`, if: "always()", env: p.post.env, run: postRun(p, p.post.command) },
        ...noteAfter(p),
      ],
    };
  }
  // #4899: `/<product> <plan word> [<target>]` plans an open pull request again, in jobs of its own.
  const replans = plans.filter((p) => p.replan);
  for (const p of replans) {
    const r = p.replan!;
    const go = "steps.decide.outputs.go == '1'";
    const says = r.comments.map((c) => `startsWith(github.event.comment.body, '${c}')`);
    const gated = r.gated.map((g) => `startsWith(github.event.comment.body, '${g.comment}')`);
    const github = forge === "github";
    // The plan step reads the pull request, its base and the comment's argument from the decision, never the event.
    const replanEnv = { ...p.env, ...(p.record?.env ?? {}), BASE_SHA: "${{ steps.decide.outputs.base }}", PR_NUMBER: "${{ steps.decide.outputs.pr }}", [PLAN_ARGUMENT_ENV]: "${{ steps.decide.outputs.argument }}" };
    jobsDoc[r.jobName] = {
      if: [
        "github.event_name == 'issue_comment'",
        github ? "github.event.issue.pull_request" : "(github.event.issue.pull_request || github.event.is_pull)",
        `(${[...says, ...gated].join(" || ")})`,
        ...(github ? ["contains(fromJSON('[\"OWNER\",\"MEMBER\",\"COLLABORATOR\"]'), github.event.comment.author_association)"] : []),
      ].join(" && "),
      "runs-on": githubRunsOn(p.runner),
      container: image,
      permissions: { ...permissions(p), "pull-requests": "read" },
      ...(p.jobEnv ? { env: p.jobEnv } : {}),
      outputs: { go: "${{ steps.decide.outputs.go }}", pr: "${{ steps.decide.outputs.pr }}", [REPLAN_HEAD_OUTPUT]: `\${{ steps.${REPLAN_HEAD_STEP_ID}.outputs.${REPLAN_HEAD_OUTPUT} }}`, ...handoverOutputs(PLAN_STEP_ID, forge) },
      steps: [
        // Before anything is checked out: the comment from the event file, the pull request and the commenter from the forge.
        {
          name: "Read the comment and decide whether it plans again",
          id: "decide",
          env: {
            CHANT_REPLAN_TOKEN: GITHUB_JOB_TOKEN,
            CHANT_REPLAN_COMMANDS: JSON.stringify(r.comments),
            ...(r.gated.length > 0 ? { CHANT_REPLAN_GATED: JSON.stringify(r.gated) } : {}),
            ...(p.target ? { CHANT_REPLAN_TARGET: p.target, CHANT_REPLAN_TARGETS: JSON.stringify(targets) } : {}),
            ...(plan.forks === "skip" ? { CHANT_REPLAN_FORKS: "skip" } : {}),
            ...(github ? {} : { CHANT_REPLAN_PERMISSION: "1" }),
          },
          run: `(cd / && node -e '${REPLAN_DECIDE_JS}')`,
        },
        ...pendingStep(p, "${{ steps.decide.outputs.head }}", go),
        {
          if: go,
          name: "Check out the pull request's head",
          id: REPLAN_HEAD_STEP_ID,
          env: { [CHECKOUT_TOKEN_ENV]: GITHUB_JOB_TOKEN, [REPLAN_REF_ENV]: "refs/pull/${{ steps.decide.outputs.pr }}/head" },
          run: [checkoutScript(true, true, { refEnv: REPLAN_REF_ENV }), `echo "${REPLAN_HEAD_OUTPUT}=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"`].join("\n"),
        },
        ...middle(p, replanEnv, go),
        { if: go, name: p.target ? `Plan ${p.target} again` : "Plan the pull request again", id: PLAN_STEP_ID, env: replanEnv, run: planRun(p) },
      ],
    };
    jobsDoc[r.noteJobName] = {
      needs: [r.jobName],
      if: `always() && github.event_name == 'issue_comment' && needs.${r.jobName}.outputs.go == '1' && (needs.${r.jobName}.result == 'success' || needs.${r.jobName}.result == 'failure')`,
      "runs-on": githubRunsOn(p.noteRunner),
      container: image,
      permissions: { actions: "read", contents: p.record ? "write" : "read", "pull-requests": "write", statuses: "write" },
      steps: [
        // The target branch's commit, which an issue_comment run checks out: none of the change's code is here.
        { name: "Check out the target branch's commit", uses: CHECKOUT },
        ...runSteps(beforeScript),
        { name: "Take the plan report from the re-plan job", run: takeOverScript(r.jobName, PR_LOOP_REPORT_DIR, forge) },
        { name: "Keep the plan report", if: "always()", uses: UPLOAD_ARTIFACT, with: { name: r.artifact, path: PR_LOOP_REPORT_DIR, "if-no-files-found": "ignore", "include-hidden-files": true } },
        ...noteBefore(p),
        { name: `Post the plan note and ${productStatusContext(jobs.words, "plan", p.target)}`, if: "always()", env: r.post.env, run: postRun(p, r.post.command) },
        ...noteAfter(p),
      ],
    };
  }
  // #4935: the check job, its evidence job and the ref gate's status job, after the plan note jobs.
  Object.assign(
    jobsDoc,
    githubCheckJobs({
      forge,
      image,
      setup,
      beforeScript,
      // The check job holds no credentials, so a fork's pull request runs it too.
      when: "github.event_name == 'pull_request'",
      trustedWhen: `github.event_name == 'pull_request'${fork}`,
      ...(jobs.check ? { check: jobs.check } : {}),
      ...(jobs.refGate ? { refGate: jobs.refGate } : {}),
      refGateNeeds: plans.map((p) => p.noteJobName),
    }),
  );
  const name = plan.workflow ?? `chant-pr-${env}`;
  // #4899: one run per pull request; a comment's run is in a group of its own comment, so it never cancels a plan.
  const concurrency = plan.concurrency
    ? {
        group: `${plan.concurrency.group ?? name}-\${{ ${replans.length > 0 ? "github.event.pull_request.number || format('comment-{0}', github.event.comment.id)" : "github.event.pull_request.number"} }}`,
        "cancel-in-progress": plan.concurrency.cancelInProgress === true,
      }
    : undefined;
  const doc: GithubWorkflowDoc = {
    ...(header && header.length > 0 ? { header } : {}),
    name,
    on: { pull_request: { branches: [branch] }, ...(replans.length > 0 ? { issue_comment: { types: ["created"] } } : {}) },
    env: { CHANT_ENV: env },
    ...(concurrency ? { concurrency } : {}),
    jobsDoc,
  };
  return { doc, jobs };
}

/** The re-plan's checkout step and its output, the commit it checked out (#4899). */
const REPLAN_HEAD_STEP_ID = "head";
const REPLAN_HEAD_OUTPUT = "head";
/** The variable the re-plan's checkout script reads the pull request's head ref from (#4899). */
const REPLAN_REF_ENV = "CHANT_REPLAN_REF";

/**
 * The product plan workflow on GitHub Actions (#4799): a plan job and a
 * plan-note job per target, from `ProductPipelineOptions` with
 * `productPlan`, and no component graph.
 */
export function generateProductPlanPipeline(env: string, options: ProductPlanPipelineOptions): ProductPlanPipeline {
  const { doc, jobs } = buildProductPlanGithubDoc("github", env, options);
  return { yaml: emitWorkflowYAML(doc), doc, jobs };
}
