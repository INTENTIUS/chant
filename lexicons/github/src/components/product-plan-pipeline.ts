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
 * Forgejo renders the same document through its dialect
 * (`generateForgejoProductPlanPipeline` in the forgejo lexicon).
 */

import { CI_IMAGE, GITHUB_JOB_TOKEN, githubRunsOn } from "@intentius/chant/ci-jobs";
import { CHECKOUT_TOKEN_ENV, checkoutScript, dropForgeTokens, handoverOutputs, handoverTrap, takeOverScript } from "@intentius/chant/ci-handover";
import { PR_LOOP_REPORT_DIR, prLoopSetup } from "@intentius/chant/components/pr-pipeline";
import { productPipelineJobs, type ProductPipelineJobs, type ProductPipelineOptions } from "@intentius/chant/components/product-pipeline";
import { SAME_REPOSITORY_IF, type ProductPlanOptions } from "@intentius/chant/components/product-plan";
import { productStatusContext } from "@intentius/chant/ci-product-words";
import { CHECKOUT, emitWorkflowYAML, runSteps, UPLOAD_ARTIFACT, type GithubWorkflowDoc } from "./ci-jobs";

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
  const branch = options.branch ?? "main";
  const fork = options.productPlan.forks === "skip" ? ` && ${SAME_REPOSITORY_IF}` : "";
  const drop = dropForgeTokens("sh");
  const headStep = (line: string): Record<string, unknown> => ({ run: `${drop}\n${line}` });
  const setup = [...prLoopSetup(image, options.engineSetup), ...beforeScript];
  const jobsDoc: Record<string, unknown> = {};
  for (const p of plans) {
    jobsDoc[p.jobName] = {
      if: `github.event_name == 'pull_request'${fork}`,
      "runs-on": githubRunsOn(p.runner),
      container: image,
      permissions: { contents: "read" },
      outputs: handoverOutputs(PLAN_STEP_ID, forge),
      steps: [
        // A script, not actions/checkout, whose post step runs at the job's end with the token as its input.
        { name: "Check out the change", env: { [CHECKOUT_TOKEN_ENV]: GITHUB_JOB_TOKEN }, run: checkoutScript(true, true) },
        ...setup.map(headStep),
        ...(p.writeProbe ? [{ name: "This job cannot write", env: p.env, run: `${drop}\n${p.writeProbe}` }] : []),
        // The job's last step: a step after it would start beside whatever the change's code left running.
        {
          name: p.target ? `Plan ${p.target}` : "Plan the change",
          id: PLAN_STEP_ID,
          env: p.env,
          run: [drop, ...handoverTrap(PR_LOOP_REPORT_DIR, forge), p.command, ...extraScript].join("\n"),
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
      permissions: { actions: "read", contents: p.evidence ? "write" : "read", "pull-requests": "write", statuses: "write" },
      steps: [
        // The target branch's commit: the bin this job runs is the target branch's, and none of the change's code is here.
        { name: "Check out the target branch's commit", uses: CHECKOUT, with: { ref: "${{ github.event.pull_request.base.sha }}" } },
        ...runSteps(beforeScript),
        { name: "Take the plan report from the plan job", run: takeOverScript(p.jobName, PR_LOOP_REPORT_DIR, forge) },
        // #4870: the runner key is in this step alone, in a job that runs none of the change's code.
        ...(p.evidence ? [{ name: "Sign the plan and policy evidence", if: "always()", env: p.evidence.env, run: p.evidence.lines.join("\n") }] : []),
        { name: "Keep the plan report", if: "always()", uses: UPLOAD_ARTIFACT, with: { name: p.artifact, path: PR_LOOP_REPORT_DIR, "if-no-files-found": "ignore", "include-hidden-files": true } },
        { name: `Post the plan note and ${productStatusContext(jobs.words, "plan", p.target)}`, if: "always()", env: p.post.env, run: p.post.command },
      ],
    };
  }
  const doc: GithubWorkflowDoc = {
    ...(header && header.length > 0 ? { header } : {}),
    name: options.productPlan.workflow ?? `chant-pr-${env}`,
    on: { pull_request: { branches: [branch] } },
    env: { CHANT_ENV: env },
    jobsDoc,
  };
  return { doc, jobs };
}

/**
 * The product plan workflow on GitHub Actions (#4799): a plan job and a
 * plan-note job per target, from `ProductPipelineOptions` with
 * `productPlan`, and no component graph.
 */
export function generateProductPlanPipeline(env: string, options: ProductPlanPipelineOptions): ProductPlanPipeline {
  const { doc, jobs } = buildProductPlanGithubDoc("github", env, options);
  return { yaml: emitWorkflowYAML(doc), doc, jobs };
}
