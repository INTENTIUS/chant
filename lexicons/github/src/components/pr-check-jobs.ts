/**
 * The check job, the check evidence job and the ref gate's status job on
 * GitHub and Forgejo (#4935), from chant's descriptors
 * (`@intentius/chant/components/pr-checks`), for the pull request loop's
 * workflow and the product plan workflow alike.
 *
 * - `check` runs the change's code, so it follows the plan job's handover
 *   (#4295): the checkout script alone sees the job's token, every later
 *   step starts without the token variables, and `chant ci check` is the
 *   last step, handing `.chant/check` on as the job's outputs. It asks for
 *   no OIDC token and gets no runner key.
 * - `check-evidence`, with `evidence`, checks out the target branch's
 *   commit, takes the report back, signs each passed hook with `chant ci
 *   evidence sign --from-report`, pushes `refs/notes/chant/evidence`
 *   (`contents: write`, and `id-token: write` signing keyless), and keeps
 *   the report as the `chant-pr-check` artifact.
 * - `ref-gate` runs once the jobs it names settled, at the target branch's
 *   commit, fetches the pull request's commit and the evidence notes, and
 *   sets the ref gate's status (`statuses: write`).
 */

import { CHECKOUT_TOKEN_ENV, checkoutScript, dropForgeTokens, handoverOutputs, handoverTrap, takeOverScript } from "@intentius/chant/ci-handover";
import { githubRunsOn } from "@intentius/chant/ci-jobs";
import { PR_CHECK_ARTIFACT, type PrCheckJob, type PrRefGateJob } from "@intentius/chant/components/pr-checks";
import { CHECKOUT, runSteps, UPLOAD_ARTIFACT } from "./ci-jobs";

/** The check step's id, whose outputs carry the report to the check evidence job. */
const CHECK_STEP_ID = "check";

/** What {@link githubCheckJobs} renders the jobs with. */
export interface GithubCheckJobsInput {
  forge: "github" | "forgejo";
  image: string;
  /** The setup lines the check job runs after the checkout, without the tokens: the engine's and the caller's `beforeScript`. */
  setup: string[];
  /** The lines the jobs at the target branch's commit run after their checkout: the caller's `beforeScript`. */
  beforeScript: string[];
  /** The condition the check job runs on: the pull request event. It holds no credentials, so it runs for a fork's pull request too. */
  when: string;
  /** The condition the jobs that hold a key or a token run on: `when`, and with `forks: "skip"` this repository's own. Default `when`. */
  trustedWhen?: string;
  check?: PrCheckJob & { runner?: unknown; evidenceRunner?: unknown };
  refGate?: PrRefGateJob & { runner?: unknown };
  /** The jobs the ref gate waits for besides the check jobs: the plan note jobs, which sign `plan` and `policy`. */
  refGateNeeds: string[];
}

/** The jobs by name, in order: check, check-evidence, ref-gate, those asked for. */
export function githubCheckJobs(input: GithubCheckJobsInput): Record<string, unknown> {
  const { forge, image, check, refGate } = input;
  const trusted = input.trustedWhen ?? input.when;
  const out: Record<string, unknown> = {};
  const drop = dropForgeTokens("sh");
  const runsOn = (runner: unknown) => githubRunsOn(runner as Parameters<typeof githubRunsOn>[0]);
  if (check) {
    out[check.jobName] = {
      if: input.when,
      "runs-on": runsOn(check.runner),
      container: image,
      permissions: { contents: "read" },
      outputs: handoverOutputs(CHECK_STEP_ID, forge),
      steps: [
        // A script, not actions/checkout, whose post step runs at the job's end with the token as its input.
        { name: "Check out the change", env: { [CHECKOUT_TOKEN_ENV]: "${{ github.token }}" }, run: checkoutScript(true) },
        ...input.setup.map((line) => ({ run: `${drop}\n${line}` })),
        // The job's last step: the hooks run the change's code, and a step after them would start beside whatever it left running.
        {
          name: "Run the check hooks the base names",
          id: CHECK_STEP_ID,
          env: check.env,
          run: [drop, ...handoverTrap(check.dir, forge, { label: "chant", noteFiles: ["check-hooks.json"] }), check.command].join("\n"),
        },
      ],
    };
    if (check.evidence) {
      const ev = check.evidence;
      out[ev.jobName] = {
        needs: [check.jobName],
        if: `always() && ${trusted} && (needs.${check.jobName}.result == 'success' || needs.${check.jobName}.result == 'failure')`,
        "runs-on": runsOn(check.evidenceRunner),
        container: image,
        // #4870: `contents: write` pushes refs/notes/chant/evidence; #4869: keyless, the job's OIDC token.
        permissions: { contents: "write", ...(ev.idToken ? { "id-token": "write" } : {}) },
        steps: [
          // The target branch's commit: the bin this job runs is the target branch's, and none of the change's code is here.
          { name: "Check out the target branch's commit", uses: CHECKOUT, with: { ref: "${{ github.event.pull_request.base.sha }}" } },
          ...runSteps(input.beforeScript),
          { name: "Take the check report from the check job", run: takeOverScript(check.jobName, check.dir, forge) },
          // The runner key (or the keyless signing) is in this step alone.
          { name: "Sign the evidence of each check hook that passed", env: ev.env, run: ev.lines.join("\n") },
          { name: "Keep the check report", if: "always()", uses: UPLOAD_ARTIFACT, with: { name: PR_CHECK_ARTIFACT, path: check.dir, "if-no-files-found": "ignore", "include-hidden-files": true } },
        ],
      };
    }
  }
  if (refGate) {
    const needs = [...input.refGateNeeds, ...(check ? [check.evidence ? check.evidence.jobName : check.jobName] : [])];
    out[refGate.jobName] = {
      needs,
      if: `always() && ${trusted}`,
      "runs-on": runsOn(refGate.runner),
      container: image,
      permissions: { contents: "read", statuses: "write" },
      steps: [
        // The target branch's commit, whose .chant/trust.json the gate reads as the policy at base.
        { name: "Check out the target branch's commit", uses: CHECKOUT, with: { ref: "${{ github.event.pull_request.base.sha }}" } },
        ...runSteps(input.beforeScript),
        { name: "Set the ref gate's status on the pull request", env: refGate.env, run: [...refGate.setup, refGate.command].join("\n") },
      ],
    };
  }
  return out;
}
