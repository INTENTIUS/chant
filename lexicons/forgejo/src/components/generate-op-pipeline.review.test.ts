/**
 * The split review on Forgejo (#4326): the github shape under the Forgejo
 * dialect. Forgejo ignores `permissions:`, so the review job's safety is the
 * token variables the step drops and the note job that holds the token alone.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { CHECKOUT_TOKEN_ENV, checkoutScript, FORGE_TOKEN_VARS } from "@intentius/chant/ci-handover";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";
import { generateForgejoOpPipeline } from "./generate-op-pipeline";

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  needs?: string;
  if?: string;
  permissions?: unknown;
  outputs?: Record<string, string>;
  steps: Step[];
}

const SPEC: ScheduledOpSpec = { name: "pr-review", trigger: { kind: "pull_request" }, reviewAgent: true };

describe("generateForgejoOpPipeline: reviewAgent", () => {
  const out = generateForgejoOpPipeline([SPEC]);
  const doc = parseYAML(out.files[0]!.yaml) as { jobs: Record<string, Job> };

  test("a review job and a note job, with the handoff between them", () => {
    expect(Object.keys(doc.jobs)).toEqual(["pr-review", "pr-review-note"]);
    expect(doc.jobs["pr-review"]!.outputs).toEqual({ report_0: "${{ steps.chant-review.outputs.report_0 }}" });
    expect(doc.jobs["pr-review-note"]!.needs).toBe("pr-review");
    expect(doc.jobs["pr-review-note"]!.if).toBe("needs.pr-review.result == 'success'");
  });

  test("no step of the review job but the checkout's fetches names a forge token, and the Op's step drops them", () => {
    for (const step of doc.jobs["pr-review"]!.steps) {
      const named = Object.keys(step.env ?? {}).filter((n) => (FORGE_TOKEN_VARS as readonly string[]).includes(n));
      expect(named).toEqual(step.run?.trimEnd() === checkoutScript(true).trimEnd() ? [CHECKOUT_TOKEN_ENV] : []);
      expect(step.uses ?? "").not.toMatch(/^actions\/checkout/);
    }
    expect(doc.jobs["pr-review"]!.steps.at(-1)!.run).toContain("exec env -u CHANT_FORGE_TOKEN");
  });

  test("the note job checks nothing out and takes the token from the job", () => {
    const note = doc.jobs["pr-review-note"]!;
    expect(note.steps.some((s) => (s.uses ?? "").includes("checkout"))).toBe(false);
    expect(note.steps[1]!.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}", CHANT_OP: "pr-review" });
  });

  test("the dialect drops permissions: from both jobs, as it does for every Op", () => {
    expect(doc.jobs["pr-review"]!.permissions).toBeUndefined();
    expect(doc.jobs["pr-review-note"]!.permissions).toBeUndefined();
  });

  test("the same refusals as github's", () => {
    expect(() => generateForgejoOpPipeline([{ ...SPEC, trigger: { kind: "push" } }])).toThrow(/reviewAgent/);
  });
});
