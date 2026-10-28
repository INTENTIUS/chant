/** #4631: the Forgejo scheduled Op job trades for its cloud identities first, and an update on drift runs in its own job. */
import { describe, expect, test } from "vitest";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";
import { generateForgejoOpPipeline } from "./generate-op-pipeline";

const PREVIEW = { aws: { role: "arn:aws:iam::1:role/preview", region: "us-east-1", audience: "sts.amazonaws.com" } };
const UPDATE = { aws: { role: "arn:aws:iam::1:role/update", region: "us-east-1", audience: "sts.amazonaws.com" } };

describe("cloud identities on a Forgejo scheduled Op (#4631)", () => {
  test("the trade, id-token: write on the job, and the update job", () => {
    const spec: ScheduledOpSpec = { name: "drift-dev", trigger: { kind: "cron", schedule: "0 6 * * *" }, findingMode: "issue", cloud: PREVIEW, update: { command: "plywood up", cloud: UPDATE } };
    const yaml = generateForgejoOpPipeline([spec]).files[0]!.yaml;
    expect(yaml).toContain("Trade the job's OIDC token for its cloud identities");
    expect(yaml).toContain("id-token: write");
    expect(yaml).toContain("drift-dev-update:");
    expect(yaml).toContain("needs.drift-dev.outputs.drift == 'true'");
    expect(yaml).toContain("role/update");
  });

  test("an update with contents: write renders, and the refusal of contents: read holds (2026-10-28 ruling)", () => {
    const spec: ScheduledOpSpec = { name: "drift-dev", trigger: { kind: "cron", schedule: "0 6 * * *" }, findingMode: "issue", cloud: PREVIEW, update: { command: "plywood up", cloud: UPDATE, permissions: { contents: "write" } } };
    expect(generateForgejoOpPipeline([spec]).files[0]!.yaml).toContain("drift-dev-update:");
    expect(() => generateForgejoOpPipeline([{ ...spec, update: { command: "plywood up", permissions: { contents: "read" } } }])).toThrow(/contents may only be raised to write/);
  });
});
