/**
 * chant #4328: no job that runs a pull request's code holds a forge token or
 * the runner key, on any of the three forges, in any shape of the generated
 * pull-request pipeline.
 *
 * The test is generic: it finds the jobs that run the change's code from the
 * generated YAML, not from a list of job names, so a job added later is held
 * to the same rule.
 *
 * - GitHub and Forgejo: a job that runs on the `pull_request` event and
 *   checks out no commit of the base. Its workflow, job and step
 *   environments name neither secret and read no `secrets.` or
 *   `github.token` expression. The one step allowed the job's token is the
 *   handover's checkout script (`checkoutScript`, ci-handover.ts), which
 *   runs before any of the change's code. No such job uses
 *   actions/checkout, whose token input defaults to the job's token.
 * - GitLab: a job a merge request pipeline runs. GitLab builds that pipeline
 *   from the merge request's own files and hands every job the project's
 *   unprotected CI/CD variables, so the YAML must set neither secret, and
 *   the secrets themselves are protected variables (docs). No job that posts
 *   the plan note runs in a merge request pipeline.
 *
 * The apply before merge (#4301) is the one job outside the rule: it applies
 * the pull request's head with the apply identity, the runner key and the
 * job token, after `pr-apply --before-merge` has checked the approval, so it
 * runs reviewed code. It starts on a comment (GitHub, Forgejo) or a pipeline
 * of the target branch (GitLab), never on the pull request's own event.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { checkoutScript, CHECKOUT_TOKEN_ENV, FORGE_TOKEN_VARS } from "@intentius/chant/ci-handover";
import { resolveCloudIdentity } from "@intentius/chant/ci-identity";
import type { ComponentPipelineOptions } from "@intentius/chant/lexicon";
import { generateGithubPipeline } from "@intentius/chant-lexicon-github/components/generate-pipeline";
import { generateGithubOpPipeline } from "@intentius/chant-lexicon-github/components/generate-op-pipeline";
import { generateForgejoOpPipeline } from "@intentius/chant-lexicon-forgejo/components/generate-op-pipeline";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";
import { generateForgejoPipeline } from "@intentius/chant-lexicon-forgejo/components/generate-pipeline";
import { generateGitlabPipeline } from "@intentius/chant-lexicon-gitlab/components/generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
  { name: "app", dependsOn: ["net"], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "app" }] }] },
];

/** The names a forge token or the runner key travels under. */
const SECRET_NAMES = new Set<string>([...FORGE_TOKEN_VARS, "CHANT_RUNNER_KEY"]);
/** A value that reads a secret on GitHub and Forgejo. */
const SECRET_VALUE = /\$\{\{[^}]*\b(secrets\.|github\.token\b)/;

const IDENTITY = resolveCloudIdentity(
  { aws: { rules: [{ environments: ["prod"], plan: "arn:aws:iam::111111111111:role/prod-plan", apply: "arn:aws:iam::111111111111:role/prod-apply" }] } },
  "prod",
)!;
const MEMBER = { name: "network", dir: "infra/network", file: "network.yml" };

/** The shapes of the pull-request pipeline the generators write: every option that adds or changes a job. */
const SHAPES: Array<[string, Partial<ComponentPipelineOptions>]> = [
  ["record on merge", { prLoop: {} }],
  ["apply on merge", { prLoop: { applyOnMerge: true } }],
  ["a gate per wave", { prLoop: { applyOnMerge: true }, gatedWaves: { gate: "release" } }],
  ["build, events and a report URL", { prLoop: { build: true, events: true, reportUrl: "$CHANT_REPORT_URL" }, beforeScript: ["npm ci"], extraScript: ["echo after"] }],
  ["cloud identities", { prLoop: { applyOnMerge: true, identity: IDENTITY } }],
  ["a pull request environment", { prLoop: { prEnvironment: true, prEnvIdentity: IDENTITY.apply } }],
  ["apply before merge", { prLoop: { applyBeforeMerge: true } }],
  ["locks on plan", { prLoop: { locks: "plan" } }],
  ["a workspace member", { prLoop: { applyOnMerge: true, events: true }, member: MEMBER }],
];

/** The secret names an environment block sets, and the names whose value reads a secret. */
function secretsIn(env: Record<string, unknown> | undefined): string[] {
  return Object.entries(env ?? {})
    .filter(([name, value]) => SECRET_NAMES.has(name) || (typeof value === "string" && SECRET_VALUE.test(value)))
    .map(([name]) => name);
}

interface GithubStep {
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
}
interface GithubJob {
  if?: string;
  env?: Record<string, unknown>;
  steps: GithubStep[];
}

/** Whether a GitHub or Forgejo job checks out a commit of the base: the target branch's, never the change's. */
const checksOutBase = (job: GithubJob): boolean =>
  job.steps.some((s) => typeof s.with?.ref === "string" && /github\.event\.pull_request\.base\./.test(s.with.ref));

/** The jobs of a GitHub-shaped workflow that run the pull request's code. */
function githubHeadJobs(doc: { jobs: Record<string, GithubJob> }): Array<[string, GithubJob]> {
  return Object.entries(doc.jobs).filter(([, job]) => /github\.event_name == 'pull_request'(?! && github\.event\.action == 'closed')/.test(job.if ?? "") && !checksOutBase(job));
}

const generators = {
  github: (o: Partial<ComponentPipelineOptions>) => generateGithubPipeline(ESTATE, { env: "prod", ...o }).yaml,
  forgejo: (o: Partial<ComponentPipelineOptions>) => generateForgejoPipeline(ESTATE, { env: "prod", ...o }).yaml,
};

for (const [forge, generate] of Object.entries(generators)) {
  describe(`${forge}: no job that runs the pull request's code holds a forge token or the runner key (#4328)`, () => {
    for (const [shape, options] of SHAPES) {
      test(shape, () => {
        const doc = parseYAML(generate(options)) as { env?: Record<string, unknown>; jobs: Record<string, GithubJob> };
        const heads = githubHeadJobs(doc);
        // The plan always runs the change's code; finding it shows the rule finds what it is for.
        expect(heads.map(([name]) => name)).toContain("plan");
        if (options.prLoop?.prEnvironment) expect(heads.map(([name]) => name)).toContain("env-up");
        expect(secretsIn(doc.env)).toEqual([]);
        for (const [name, job] of heads) {
          expect(secretsIn(job.env), `${name}: job env`).toEqual([]);
          for (const [i, step] of job.steps.entries()) {
            const where = `${name}: step ${i} (${step.run?.split("\n")[0] ?? step.uses})`;
            const named = secretsIn(step.env);
            // The handover's checkout gives the job's token to its fetches alone, before any of the change's code runs.
            if (step.run?.trimEnd() === checkoutScript(true, true).trimEnd()) expect(named, where).toEqual([CHECKOUT_TOKEN_ENV]);
            else expect(named, where).toEqual([]);
            expect(secretsIn(step.with), where).toEqual([]);
            expect(step.uses ?? "", where).not.toMatch(/^actions\/checkout@/);
          }
        }
      });
    }

    test("the apply before merge, the one job outside the rule, starts on a comment, not on the pull request's event", () => {
      const doc = parseYAML(generate({ prLoop: { applyBeforeMerge: true } })) as { jobs: Record<string, GithubJob> };
      expect(doc.jobs.apply!.if).toMatch(/^github\.event_name == 'issue_comment'/);
      expect(githubHeadJobs(doc).map(([name]) => name)).not.toContain("apply");
    });
  });
}

/**
 * #4326: the split review is a generated job shape of its own, the Op
 * pipeline's `reviewAgent`. Its review job runs the pull request's code
 * (`chant run` loads the change's Op files) beside a model, so it follows the
 * rule above. Its note job is the one job that holds the token, and runs none
 * of the change's code: it checks out nothing and runs no `chant run`.
 */
describe("the split review's jobs (#4326)", () => {
  const SPEC: ScheduledOpSpec = { name: "pr-review", trigger: { kind: "pull_request" }, reviewAgent: true };
  const reviewGenerators = {
    github: () => generateGithubOpPipeline([SPEC]).files[0]!.yaml,
    forgejo: () => generateForgejoOpPipeline([SPEC]).files[0]!.yaml,
  };
  for (const [forge, generate] of Object.entries(reviewGenerators)) {
    test(`${forge}: the review job holds no forge token or runner key, and the note job runs no code of the change`, () => {
      const doc = parseYAML(generate()) as { env?: Record<string, unknown>; jobs: Record<string, GithubJob> };
      expect(secretsIn(doc.env)).toEqual([]);
      const review = doc.jobs["pr-review"]!;
      expect(secretsIn(review.env)).toEqual([]);
      for (const [i, step] of review.steps.entries()) {
        const where = `review: step ${i} (${step.run?.split("\n")[0] ?? step.uses})`;
        const named = secretsIn(step.env);
        if (step.run?.trimEnd() === checkoutScript(true).trimEnd()) expect(named, where).toEqual([CHECKOUT_TOKEN_ENV]);
        else expect(named, where).toEqual([]);
        expect(secretsIn(step.with), where).toEqual([]);
        expect(step.uses ?? "", where).not.toMatch(/^actions\/checkout@/);
      }
      // The note job is the other side: no checkout, no run of the Op.
      const note = doc.jobs["pr-review-note"]!;
      expect(note.steps.some((s) => (s.uses ?? "").startsWith("actions/checkout"))).toBe(false);
      expect(note.steps.map((s) => s.run ?? "").join("\n")).not.toMatch(/chant run|git (fetch|checkout|clone)/);
    });
  }
});

interface GitlabJob {
  rules?: Array<{ if?: string }>;
  variables?: Record<string, unknown>;
  secrets?: unknown;
  script?: string[];
}

describe("gitlab: no job of a merge request pipeline holds a forge token or the runner key (#4328)", () => {
  for (const [shape, options] of SHAPES) {
    test(shape, () => {
      const doc = parseYAML(generateGitlabPipeline(ESTATE, { env: "prod", ...options }).yaml) as Record<string, unknown> & { variables?: Record<string, unknown> };
      expect(secretsIn(doc.variables)).toEqual([]);
      const jobs = Object.entries(doc).filter((e): e is [string, GitlabJob] => typeof e[1] === "object" && e[1] !== null && Array.isArray((e[1] as GitlabJob).script));
      const inMergeRequest = jobs.filter(([, job]) => (job.rules ?? []).some((r) => (r.if ?? "").includes('$CI_PIPELINE_SOURCE == "merge_request_event"')));
      const planJob = options.member ? `${options.member.name}-plan` : "plan";
      expect(inMergeRequest.map(([name]) => name)).toContain(planJob);
      for (const [name, job] of inMergeRequest) {
        expect(secretsIn(job.variables), name).toEqual([]);
        expect(job.secrets, name).toBeUndefined();
        // #4328: the plan note is posted from a pipeline of the target branch.
        expect(job.script!.join("\n"), name).not.toContain("chant components pr-post");
      }
      // The note job exists, outside the merge request pipeline.
      const notes = jobs.filter(([, job]) => job.script!.some((l) => l.includes("chant components pr-post --open")));
      expect(notes).toHaveLength(1);
    });
  }
});
