/**
 * The engine event stream (#4541, ruling C): a preview streamed with
 * `PULUMI_ENABLE_STREAMING_JSON_PREVIEW=true` reads as the printed document,
 * with the same digest, and its policy events become gate findings.
 *
 * `testdata/pulumi-stream/preview-stream.ndjson` is the recorded
 * `testdata/pulumi-preview/preview.json` (pulumi 3.272.0, the plunge corpus
 * on floci, #4475) converted to the stream form; see its README. Nothing
 * here runs Pulumi.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { pulumiPreviewDigest, pulumiPreviewPart } from "./change-set";
import {
  crossGuardRule,
  pulumiAppliedSteps,
  pulumiEngineEvents,
  pulumiFailedUrns,
  pulumiLandedUrns,
  pulumiPolicyEvents,
  pulumiPolicyFindings,
  pulumiStreamError,
  pulumiStreamPreview,
  pulumiStreamSummary,
} from "./engine-events";

const testdata = join(import.meta.dirname, "testdata");
const printed = JSON.parse(readFileSync(join(testdata, "pulumi-preview", "preview.json"), "utf-8")) as { steps: Array<{ op: string; urn: string }> };
const stream = readFileSync(join(testdata, "pulumi-stream", "preview-stream.ndjson"), "utf-8");
const urn = (type: string, name: string) => `urn:pulumi:floci::corpus-aws-ts::${type}::${name}`;

describe("a streamed preview reads as the printed document", () => {
  test("its digest equals the printed document's", () => {
    expect(pulumiPreviewDigest(pulumiStreamPreview(stream))).toBe(pulumiPreviewDigest(printed));
    expect(pulumiPreviewDigest(pulumiStreamPreview(stream), { changedOnly: true })).toBe(pulumiPreviewDigest(printed, { changedOnly: true }));
  });

  test("the steps are the printed ones, in order: non-logical replacement steps are left out", () => {
    const steps = pulumiStreamPreview(stream).steps;
    expect(steps.map((s) => [s.op, s.urn])).toEqual(printed.steps.map((s) => [s.op, s.urn]));
    expect(steps.some((s) => s.op === "create-replacement" || s.op === "delete-replaced")).toBe(false);
  });

  test("a blinded secret envelope reads as [secret], and empty maps and ids are left out", () => {
    const steps = pulumiStreamPreview(stream).steps;
    const stack = steps.find((s) => s.urn?.includes("pulumi:pulumi:Stack"))!;
    expect(stack.oldState?.inputs).toBeUndefined();
    expect(stack.oldState?.id).toBeUndefined();
    expect(stack.oldState?.outputs?.dbPasswordValue).toBe("[secret]");
  });

  test("the part has the printed document's entries and digest", () => {
    const fromStream = pulumiPreviewPart({ member: "site/floci", preview: pulumiStreamPreview(stream), stack: "floci" });
    const fromPrinted = pulumiPreviewPart({ member: "site/floci", preview: printed, stack: "floci" });
    expect(fromStream).toEqual(fromPrinted);
  });

  test("an ephemeral diagnostic is left out, and the summary gives changeSummary", () => {
    const doc = pulumiStreamPreview(stream);
    expect(doc.diagnostics.some((d) => d.message === "progress\n")).toBe(false);
    expect(doc.changeSummary).toEqual({ delete: 2, replace: 2, same: 11, update: 2 });
  });

  test("a line that is not an event is skipped", () => {
    expect(pulumiEngineEvents(`Previewing update (floci)\n${stream}\nnot json {`).length).toBe(pulumiEngineEvents(stream).length);
  });
});

describe("CrossGuard's policy events (ruling 7)", () => {
  test("the advisory violation is a warning, named crossguard.<pack>.<policy>", () => {
    const violations = pulumiPolicyEvents(stream);
    expect(violations).toEqual([
      {
        pack: "corpus-checks",
        packVersion: "0.1.0",
        policy: "sqs-dead-letter",
        enforcementLevel: "advisory",
        message: "Queues should set a dead-letter queue.",
        urn: urn("aws:sqs/queue:Queue", "events"),
      },
    ]);
    expect(pulumiPolicyFindings(violations)).toEqual({
      denials: [],
      holds: [],
      warnings: [`crossguard.corpus-checks.sqs-dead-letter: Queues should set a dead-letter queue. (${urn("aws:sqs/queue:Queue", "events")})`],
    });
  });

  test("a mandatory violation denies, and a disabled one is dropped", () => {
    const line = (level: string) =>
      JSON.stringify({ policyEvent: { message: "no public buckets", policyName: "s3-private", policyPackName: "org", policyPackVersion: "1", enforcementLevel: level, resourceUrn: urn("aws:s3/bucket:Bucket", "site-bucket") } });
    const findings = pulumiPolicyFindings(pulumiPolicyEvents(`${line("mandatory")}\n${line("disabled")}\n`));
    expect(findings.denials).toEqual([{ rule: "crossguard.org.s3-private", message: `no public buckets (${urn("aws:s3/bucket:Bucket", "site-bucket")})` }]);
    expect(findings.warnings).toEqual([]);
    expect(crossGuardRule({ pack: "org", policy: "s3-private" })).toBe("crossguard.org.s3-private");
  });
});

describe("an up's stream", () => {
  // The same events with no preview phase: what `up --json` streams for the steps it runs.
  const up = stream.replaceAll(',"planning":true', "");

  test("pulumiAppliedSteps keeps only steps outside a preview phase", () => {
    expect(pulumiAppliedSteps(stream)).toEqual([]);
    expect(pulumiAppliedSteps(up).map((s) => s.op)).toEqual(printed.steps.map((s) => s.op));
  });

  test("the URNs that landed leave out same steps, and a failed operation is named", () => {
    const failed = JSON.stringify({ resOpFailedEvent: { metadata: { op: "update", urn: urn("aws:sqs/queue:Queue", "events") }, status: 1, steps: 0 } });
    expect(pulumiLandedUrns(up)).toContain(urn("aws:ec2/vpc:Vpc", "main"));
    expect(pulumiLandedUrns(up)).not.toContain(urn("aws:iam/role:Role", "app-role"));
    expect(pulumiFailedUrns(`${up}${failed}\n`)).toEqual([urn("aws:sqs/queue:Queue", "events")]);
  });

  test("the summary carries the counts, and plunge's timings when a step has them (plunge#55)", () => {
    const timed = JSON.stringify({ resOutputsEvent: { metadata: { op: "update", urn: urn("aws:sqs/queue:Queue", "events"), plungeTimings: [{ phase: "update", ms: 812 }] } } });
    expect(pulumiStreamSummary(`${up}${timed}\n`)).toEqual({
      resourceChanges: { delete: 2, replace: 2, same: 11, update: 2 },
      durationSeconds: 4,
      result: "succeeded",
      timings: { [urn("aws:sqs/queue:Queue", "events")]: [{ phase: "update", ms: 812 }] },
    });
    expect(pulumiStreamSummary("")).toBeUndefined();
  });

  test("the first error is an errorEvent or an error diagnostic", () => {
    expect(pulumiStreamError(stream)).toBeUndefined();
    expect(pulumiStreamError(`${JSON.stringify({ diagnosticEvent: { message: "error: update failed", severity: "error" } })}\n`)).toBe("error: update failed");
    expect(pulumiStreamError(`${JSON.stringify({ errorEvent: { error: "plan moved" } })}\n`)).toBe("plan moved");
  });
});
