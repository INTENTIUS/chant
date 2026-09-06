/**
 * Tests for `generateOpsPipeline` (#927) — generate mode's Op counterpart to
 * `../components/cli-support.ts`'s `generateComponentsPipeline`. Mirrors that
 * module's own test style (`cli-support.test.ts`): a minimal mocked lexicon
 * plugin satisfying `isLexiconPlugin`, real `discoverOps()` resolution
 * against this repo's actual `*.op.ts` fixtures (`examples/alb-deploy.op.ts`
 * — see `./discover.test.ts`) so Op-name validation exercises the real
 * discovery path rather than a stub.
 */

import { describe, test, expect, vi } from "vitest";
import { generateOpsPipeline, withOpSchedules } from "./generate-pipeline";
import type { DiscoveredOp } from "./discover";
import type { OpConfig } from "./types";
import type { ScheduledOpSpec, OpPipelineResult } from "../lexicon";

vi.mock("@intentius/chant-lexicon-gitlab", () => ({
  gitlab: {
    name: "gitlab",
    serializer: { name: "gitlab", rulePrefix: "GL", serialize: () => "" },
    generate: () => {},
    validate: () => [],
    coverage: () => ({ total: 0, covered: 0 }),
    package: () => "gitlab",
    generateOpPipeline: (ops: ScheduledOpSpec[]): OpPipelineResult => ({
      files: ops.map((o) => ({ name: `${o.name}.yml`, yaml: `# ${o.name} @ ${o.schedule}` })),
      jobs: ops.map((o) => ({
        jobName: o.name,
        op: o.name,
        trigger: o.trigger ?? { kind: "cron" as const, schedule: o.schedule! },
        findingMode: o.findingMode ?? "report",
      })),
    }),
  },
}));

describe("generateOpsPipeline", () => {
  test("errors when the target lexicon has no generateOpPipeline", async () => {
    const result = await generateOpsPipeline([{ name: "alb-deploy", schedule: "0 6 * * *" }], "aws");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not support Op generate mode/);
  });

  test("errors on an Op name that isn't discovered", async () => {
    const result = await generateOpsPipeline(
      [{ name: "definitely-not-a-real-op", schedule: "0 6 * * *" }],
      "gitlab",
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown Op\(s\): definitely-not-a-real-op/);
  });

  test("validates every named Op and delegates to the lexicon plugin", async () => {
    const specs: ScheduledOpSpec[] = [{ name: "alb-deploy", schedule: "0 6 * * *", findingMode: "issue" }];
    const result = await generateOpsPipeline(specs, "gitlab");
    expect(result.success).toBe(true);
    expect(result.files).toEqual([{ name: "alb-deploy.yml", yaml: "# alb-deploy @ 0 6 * * *" }]);
    expect(result.jobs).toEqual([
      { jobName: "alb-deploy", op: "alb-deploy", trigger: { kind: "cron", schedule: "0 6 * * *" }, findingMode: "issue" },
    ]);
  });

  // #2084: `trigger` is new and optional — a spec built the old way (`schedule`
  // only, no `trigger`) must still round-trip through `generateOpsPipeline`
  // unchanged, since every pre-#2084 caller (`WorkflowAuditOp`,
  // `PipelineAuditOp`, `ReconcileOp`) only ever sets `schedule`.
  test("a legacy `{ schedule }` spec with no `trigger` round-trips unchanged", async () => {
    const specs: ScheduledOpSpec[] = [{ name: "alb-deploy", schedule: "0 6 * * *" }];
    const result = await generateOpsPipeline(specs, "gitlab");
    expect(result.success).toBe(true);
    expect(result.files).toEqual([{ name: "alb-deploy.yml", yaml: "# alb-deploy @ 0 6 * * *" }]);
    expect(result.jobs).toEqual([
      { jobName: "alb-deploy", op: "alb-deploy", trigger: { kind: "cron", schedule: "0 6 * * *" }, findingMode: "report" },
    ]);
  });
});

describe("withOpSchedules — the Op's own cadence reaches the CI generator (#2120)", () => {
  function discovered(entries: Array<[string, OpConfig]>): Map<string, DiscoveredOp> {
    return new Map(entries.map(([name, config]) => [name, { config, filePath: `${name}.op.ts` }]));
  }

  const scheduled: OpConfig = {
    name: "prod-watch",
    overview: "watch prod",
    phases: [],
    schedule: { cron: "*/10 * * * *", overlap: "skip" },
  };
  const unscheduled: OpConfig = { name: "one-shot", overview: "no cadence", phases: [] };

  test("a scheduled Op's cadence lands on its spec as opSchedule", () => {
    const [spec] = withOpSchedules([{ name: "prod-watch" }], discovered([["prod-watch", scheduled]]));
    expect(spec.opSchedule).toEqual({ cron: "*/10 * * * *", overlap: "skip" });
  });

  test("an Op with no cadence leaves its spec untouched", () => {
    const input: ScheduledOpSpec[] = [{ name: "one-shot", schedule: "0 6 * * *" }];
    expect(withOpSchedules(input, discovered([["one-shot", unscheduled]]))).toEqual(input);
  });

  test("an explicit trigger or schedule on the spec is preserved alongside it — resolveOpTrigger picks", () => {
    const [spec] = withOpSchedules(
      [{ name: "prod-watch", trigger: { kind: "push", branches: ["main"] } }],
      discovered([["prod-watch", scheduled]]),
    );
    expect(spec.trigger).toEqual({ kind: "push", branches: ["main"] });
    expect(spec.opSchedule).toEqual({ cron: "*/10 * * * *", overlap: "skip" });
  });

  test("the input specs are not mutated", () => {
    const input: ScheduledOpSpec[] = [{ name: "prod-watch" }];
    withOpSchedules(input, discovered([["prod-watch", scheduled]]));
    expect(input[0].opSchedule).toBeUndefined();
  });
});
