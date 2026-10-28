/**
 * A plunge `up` that fails outright keeps its per-resource timings (#4579):
 * `pulumi-up` throws `PulumiUpFailedError` with the stream's summary, which
 * `./trace-facts.ts` reads off the error for the run record and the trace.
 * The fixture `testdata/pulumi-stream/up-failed-plunge.ndjson` is written by
 * hand (see its README). No engine runs.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { DeployContext } from "@intentius/chant/components/capability";
import { createPulumiUpCapability, failedUpSummary, PulumiUpFailedError, type PulumiUpArtifact } from "./pulumi-up";
import { pulumiTraceFacts } from "./trace-facts";
import type { PulumiRunner } from "./run";

const testdata = join(import.meta.dirname, "testdata");
const dir = join(testdata, "pulumi-preview");
const stream = readFileSync(join(testdata, "pulumi-stream", "preview-stream.ndjson"), "utf-8");
const failedUp = readFileSync(join(testdata, "pulumi-stream", "up-failed-plunge.ndjson"), "utf-8");
const ctx: DeployContext = { env: "prod", component: "site" };
const member = "corpus-aws-ts/floci";
const queue = "urn:pulumi:floci::corpus-aws-ts::aws:sqs/queue:Queue::events";
const bucket = "urn:pulumi:floci::corpus-aws-ts::aws:s3/bucketV2:BucketV2::docs";

const plunge: PulumiRunner = async (args) => {
  const save = args.indexOf("--save-plan");
  if (save >= 0) writeFileSync(args[save + 1]!, "{}\n");
  if (args[0] === "up") throw Object.assign(new Error("exit 1"), { code: 1, stdout: failedUp });
  return { stdout: stream };
};

describe("a failed plunge up (#4579)", () => {
  test("the summary holds the timings of what ran when the stream has no summaryEvent", () => {
    const summary = failedUpSummary(failedUp);
    expect(summary).toMatchObject({ result: "failed", resourceChanges: {} });
    expect(Object.keys(summary!.timings!).sort()).toEqual([bucket, queue]);
    expect(summary!.timings![queue]).toEqual([{ kind: "provider", call: "update", startedAt: "2026-10-27T12:00:00.800000000Z", durationMs: 41, failed: true }]);
    expect(failedUpSummary("")).toBeUndefined();
  });

  test("run throws PulumiUpFailedError carrying the summary, and the trace facts read it", async () => {
    const cap = createPulumiUpCapability({ plunge, env: {}, tmp: mkdtempSync(join(tmpdir(), "up-failed-")), snapshots: null });
    const step = { dir, stack: "floci", engine: "plunge" as const };
    const artifact = (await cap.plan!(ctx, step)).artifact as PulumiUpArtifact;
    const err = await cap.run({ ...ctx, plans: { [member]: artifact } }, step).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PulumiUpFailedError);
    expect((err as PulumiUpFailedError).message).toMatch(/plunge up failed \(exit 1\).*InvalidAttributeValue/);
    expect((err as PulumiUpFailedError).summary?.timings?.[queue]?.[0]?.failed).toBe(true);
    const facts = pulumiTraceFacts(step, { error: err });
    expect(facts.attributes).toMatchObject({ member, "up.result": "failed" });
    expect(facts.spans?.length ?? 0).toBeGreaterThan(0);
  });
});
