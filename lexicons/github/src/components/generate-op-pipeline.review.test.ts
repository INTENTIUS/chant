/**
 * The split review (#4326): `ScheduledOpSpec.reviewAgent` makes two jobs, a
 * review job that runs the change's code with no forge write token and a note
 * job that checks nothing out and posts.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { CHECKOUT_TOKEN_ENV, checkoutScript, FORGE_TOKEN_VARS } from "@intentius/chant/ci-handover";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";
import { generateGithubOpPipeline } from "./generate-op-pipeline";

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "working-directory"?: string;
}
interface Job {
  needs?: string;
  if?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
}
interface Doc {
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

const SPEC: ScheduledOpSpec = { name: "pr-review", trigger: { kind: "pull_request" }, reviewAgent: true };
const gen = (spec: Partial<ScheduledOpSpec> = {}, options = {}) => {
  const out = generateGithubOpPipeline([{ ...SPEC, ...spec }], options);
  return { doc: parseYAML(out.files[0]!.yaml) as unknown as Doc, yaml: out.files[0]!.yaml, name: out.files[0]!.name };
};

describe("the review job", () => {
  const { doc } = gen();
  const job = doc.jobs["pr-review"]!;

  test("holds contents: read and nothing that writes to the forge", () => {
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
  });

  test("no step but the checkout's fetches holds a forge token, and none uses actions/checkout", () => {
    for (const step of job.steps) {
      const named = Object.keys(step.env ?? {}).filter((n) => (FORGE_TOKEN_VARS as readonly string[]).includes(n));
      expect(step.uses ?? "").not.toMatch(/^actions\/checkout@/);
      if (step.run?.trimEnd() === checkoutScript(true).trimEnd()) {
        expect(named).toEqual([CHECKOUT_TOKEN_ENV]);
        continue;
      }
      expect(named).toEqual([]);
      expect(JSON.stringify(step.env ?? {}) + JSON.stringify(step.with ?? {})).not.toMatch(/secrets\.|github\.token/);
    }
    expect(job.env ?? {}).toEqual({});
    expect(doc.env ?? {}).toEqual({});
  });

  test("the checkout carries the base branch's history for the diff", () => {
    expect(job.steps[0]!.run!.trimEnd()).toBe(checkoutScript(true).trimEnd());
    expect(job.steps[0]!.run).toContain("+refs/heads/*:refs/remotes/origin/*");
  });

  test("the Op's step starts without the token variables, names the handoff directory, and hands the review on as the job's outputs", () => {
    const run = job.steps.at(-1)!;
    expect(run.id).toBe("chant-review");
    expect(run.run).toContain("chant run pr-review");
    expect(run.run).toMatch(/^if .*exec env -u CHANT_FORGE_TOKEN/);
    expect(run.run).toContain("trap chant_handover EXIT");
    expect(run.env).toEqual({ CHANT_REVIEW_DIR: ".chant/review" });
    expect(job.outputs).toEqual({ report_0: "${{ steps.chant-review.outputs.report_0 }}" });
  });

  test("the Op's step is the last one, so nothing starts beside what the change's code left running", () => {
    expect(job.steps.at(-1)!.id).toBe("chant-review");
  });
});

describe("the note job", () => {
  const { doc } = gen();
  const note = doc.jobs["pr-review-note"]!;

  test("needs the review job and runs when it succeeded", () => {
    expect(note.needs).toBe("pr-review");
    expect(note.if).toBe("needs.pr-review.result == 'success'");
  });

  test("checks nothing out and holds the pull-request write scope alone", () => {
    expect(note.permissions).toEqual({ "pull-requests": "write" });
    expect(note.steps.some((s) => (s.uses ?? "").startsWith("actions/checkout"))).toBe(false);
    expect(note.steps.some((s) => (s.run ?? "").includes("git "))).toBe(false);
  });

  test("takes the review as data and posts it with the job's token, naming the Op itself", () => {
    expect(note.steps[0]!.run).toContain("toJSON(needs.pr-review.outputs.report_0)");
    const post = note.steps[1]!;
    expect(post.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}", CHANT_OP: "pr-review" });
    expect(post.run).toContain('import { postReviewNote } from "@intentius/chant/op/activities/review-agent";');
    expect(post.run).toMatch(/npm install .* @intentius\/chant@\d+\.\d+\.\d+/);
    expect(post.run).not.toContain("${{");
  });

  test("the job that runs the change's code has no pull-requests scope the note job lacks, and the note job runs none of the change's code", () => {
    const review = doc.jobs["pr-review"]!;
    expect(JSON.stringify(review)).not.toContain("pull-requests");
    expect(note.steps.map((s) => s.run ?? "").join("\n")).not.toContain("chant run");
  });
});

describe("what the shape refuses and carries", () => {
  test("a trigger with no pull request, a finding-mode that writes and a write scope are refused by name", () => {
    expect(() => gen({ trigger: { kind: "push" } })).toThrow(/pr-review.*"push"/);
    expect(() => gen({ findingMode: "comment" })).toThrow(/findingMode "comment".*must be "report"/);
    expect(() => gen({ permissions: { "pull-requests": "write" } })).toThrow(/pull-requests: write/);
    expect(() => gen({ permissions: { "id-token": "write" } })).not.toThrow();
  });

  test("setup steps, per-Op variables, beforeScript and extraScript land in the review job", () => {
    const { doc } = gen(
      { setup: [{ uses: "aws-actions/configure-aws-credentials@" + "a".repeat(40), with: { "role-to-assume": "arn:aws:iam::1:role/plan" } }], variables: { AWS_REGION: "eu-west-1" }, permissions: { "id-token": "write" } },
      { beforeScript: ["npm ci"], extraScript: ["echo done"] },
    );
    const job = doc.jobs["pr-review"]!;
    expect(job.env).toEqual({ AWS_REGION: "eu-west-1" });
    expect(job.steps.some((s) => (s.uses ?? "").startsWith("aws-actions/configure-aws-credentials"))).toBe(true);
    expect(job.steps.some((s) => (s.run ?? "").includes("\nnpm ci"))).toBe(true);
    expect(job.steps.at(-1)!.run).toContain("echo done");
    expect(doc.permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  test("a member's directory scopes the review job, and the checkout still runs at the repository root", () => {
    const { doc, name } = gen({}, { member: { name: "network", dir: "infra/network", file: "network.yml" } });
    expect(name).toBe("network-pr-review.yml");
    const job = doc.jobs["pr-review"] as Job & { defaults?: { run?: { "working-directory"?: string } } };
    expect(job.defaults?.run?.["working-directory"]).toBe("infra/network");
    expect(job.steps[0]!["working-directory"]).toBe(".");
    expect((doc.jobs["pr-review-note"] as { defaults?: unknown }).defaults).toBeUndefined();
  });

  test("an Op without reviewAgent keeps its one job and its token", () => {
    const out = generateGithubOpPipeline([{ name: "plain", trigger: { kind: "pull_request" } }]);
    const doc = parseYAML(out.files[0]!.yaml) as unknown as Doc;
    expect(Object.keys(doc.jobs)).toEqual(["plain"]);
    expect(out.files[0]!.yaml).toContain("GITHUB_TOKEN");
  });
});
