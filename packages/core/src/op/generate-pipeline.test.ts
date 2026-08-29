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
import { generateOpsPipeline } from "./generate-pipeline";
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
      jobs: ops.map((o) => ({ jobName: o.name, op: o.name, schedule: o.schedule, findingMode: o.findingMode ?? "report" })),
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
    expect(result.jobs).toEqual([{ jobName: "alb-deploy", op: "alb-deploy", schedule: "0 6 * * *", findingMode: "issue" }]);
  });
});
