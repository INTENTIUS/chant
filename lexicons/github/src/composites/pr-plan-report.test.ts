import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { PrPlanReport } from "./pr-plan-report";
import { githubPlugin } from "../plugin";
import { githubSerializer } from "../serializer";
import { Workflow } from "../generated/index";
import type { SerializerResult } from "@intentius/chant/serializer";

/**
 * `Job`/`Step` (`../generated/index`) come from core's `createResource`/
 * `createProperty` (`packages/core/src/runtime.ts`), whose constructor type
 * is `new (...) => Declarable & Record<string, string>` — every property,
 * `.props` included, reads back as `string` regardless of what was actually
 * passed in. That is a known, tracked gap (chant #1388's shrinking
 * typecheck baseline; `composites.test.ts` in this same directory is
 * grandfathered into it for exactly this reason). This file is new, so
 * rather than add to that backlog, these two interfaces describe the real
 * runtime shape for the fields this file asserts on, and `asJob` narrows the
 * composite's output into it once instead of reading `.props` off the
 * loosely-typed instance directly.
 */
interface StepLike {
  props: { name?: string; run?: string };
}
interface JobLike {
  props: {
    "runs-on": string;
    if?: string;
    permissions?: unknown;
    env?: Record<string, string>;
    steps?: StepLike[];
  };
}

function asJob(job: unknown): JobLike {
  return job as JobLike;
}

function steps(job: unknown): StepLike[] {
  return asJob(job).props.steps ?? [];
}

describe("PrPlanReport composite (#1983)", () => {
  test("defaults: guarded on pull_request, posts by default, marker keyed on environment", () => {
    const { job } = PrPlanReport({ environment: "prod" });
    expect(asJob(job).props["runs-on"]).toBe("ubuntu-latest");
    expect(asJob(job).props.if).toBe("github.event_name == 'pull_request'");
    expect(asJob(job).props.permissions).toMatchObject({ props: { contents: "read", "pull-requests": "write" } });
    expect(asJob(job).props.env?.MARKER).toBe("<!-- chant-pr-plan-report:prod -->");
    const names = steps(job).map((s) => s.props.name);
    expect(names).toContain("Post or update PR comment");
  });

  test("two environments get two distinct markers", () => {
    const prod = PrPlanReport({ environment: "prod" }).job;
    const staging = PrPlanReport({ environment: "staging" }).job;
    expect(asJob(prod).props.env?.MARKER).not.toBe(asJob(staging).props.env?.MARKER);
  });

  test("postComment: false is the explicit opt-out — no comment step, plan still runs", () => {
    const { job } = PrPlanReport({ environment: "prod", postComment: false });
    const names = steps(job).map((s) => s.props.name);
    expect(names).not.toContain("Post or update PR comment");
    expect(names.some((n) => n?.startsWith("Plan "))).toBe(true);
  });

  test("lexicon and --owned reach the plan command", () => {
    const { job } = PrPlanReport({ environment: "prod", lexicon: "aws", ownedOnly: true });
    const planStep = steps(job).find((s) => s.props.name === "Plan prod")!;
    expect(planStep.props.run).toContain("lifecycle plan prod aws --owned --report markdown");
  });

  test("before commands become their own credential-setup steps, in order, ahead of the plan", () => {
    const { job } = PrPlanReport({ environment: "prod", before: ["aws sts get-caller-identity", "echo ready"] });
    const names = steps(job).map((s) => s.props.name);
    const planIndex = names.indexOf("Plan prod");
    const credIndexes = names.reduce<number[]>((acc, n, i) => (n === "Live credentials" ? [...acc, i] : acc), []);
    expect(credIndexes).toHaveLength(2);
    expect(Math.max(...credIndexes)).toBeLessThan(planIndex);
  });

  test("the emitted workflow passes the github lexicon's own lint — no errors, pinned actions included", () => {
    const { job } = PrPlanReport({ environment: "prod", before: ["aws sts get-caller-identity"] });
    const workflow = new Workflow({
      name: "pr-plan",
      on: { pull_request: { types: ["opened", "synchronize", "reopened"] } },
    });
    const result = githubSerializer.serialize(
      new Map<string, unknown>([["workflow", workflow], ["plan", job]]) as never,
    ) as SerializerResult;
    const yaml = typeof result === "string" ? result : result.primary!;
    expect(yaml).toContain("Post or update PR comment");

    const ctx: PostSynthContext = {
      outputs: new Map([["github", yaml]]),
      entities: new Map(),
      buildResult: {
        outputs: new Map([["github", yaml]]),
        entities: new Map(),
        warnings: [],
        errors: [],
        sourceFileCount: 1,
      },
    };
    const diagnostics = githubPlugin.postSynthChecks!().flatMap((check) => check.check(ctx));
    const errors = diagnostics.filter((d) => d.severity === "error");
    expect(errors).toEqual([]);
  });
});
