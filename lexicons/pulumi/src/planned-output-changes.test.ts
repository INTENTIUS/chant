/**
 * Which stack outputs a preview changes (#4635), over the recorded previews
 * in `testdata/pulumi-outputs` (pulumi 3.272.0, the plunge corpus's aws-ts
 * program on floci, #4475) and copies of their steps edited in the test.
 * No engine runs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { pulumiPreviewPart, type PulumiStep } from "./change-set";
import { pulumiMemberPlannedOutputs } from "./member-outputs";
import { pulumiPlannedOutputChanges } from "./planned-output-changes";

const dir = join(import.meta.dirname, "testdata", "pulumi-outputs");
const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { steps: PulumiStep[] };
const exported = JSON.parse(readFileSync(join(dir, "stack-export.json"), "utf8")) as unknown;
const partOf = (preview: { steps: PulumiStep[] }, targeted = false) => pulumiPreviewPart({ member: "aws", preview, prior: exported, ...(targeted ? { targeted } : {}) });

describe("the recorded previews", () => {
  test("a replaced VPC moves its id, the security group's, the deleted parameter's name and the deleted queue's URL", () => {
    const r = pulumiPlannedOutputChanges({ part: partOf(read("preview-replaced.json")), exported });
    expect(r.unknown).toEqual(["securityGroupId", "vpcId", "vpcParameterName", "workerQueueUrls"]);
    expect(r.outputs.find((o) => o.output === "vpcId")).toEqual({ output: "vpcId", verdict: "changing", because: "aws:ec2/vpc:Vpc::main.id (replace)" });
    expect(r.outputs.find((o) => o.output === "workerQueueUrls")).toMatchObject({ verdict: "changing", because: "aws:sqs/queue:Queue::worker-2.id (delete)" });
    // The events queue updates in place: its id (its URL) stays.
    expect(r.outputs.find((o) => o.output === "eventsQueueUrl")).toMatchObject({ verdict: "unchanged", because: "aws:sqs/queue:Queue::events.id (update)" });
    expect(r.known.siteBucketName).toBe("rec-ts-site");
    expect(r.outputs.map((o) => o.output)).not.toContain("dbPasswordValue");
  });

  test("a settled preview changes nothing", () => {
    expect(pulumiPlannedOutputChanges({ part: partOf(read("preview-settled.json")), exported }).unknown).toEqual([]);
  });

  test("pulumiMemberPlannedOutputs takes the trace when the preview plans no stack outputs", () => {
    const preview = read("preview-replaced.json");
    const planned = pulumiMemberPlannedOutputs("aws", { part: partOf(preview), preview, exported });
    expect(planned.unknown).toEqual(["securityGroupId", "vpcId", "vpcParameterName", "workerQueueUrls"]);
    expect(planned.outputChanges?.length).toBe(12);
    // With no export there is nothing to trace and no output to name.
    expect(pulumiMemberPlannedOutputs("aws", { part: partOf(preview), preview })).toMatchObject({ known: {}, unknown: [] });
  });
});

describe("edited from the recording", () => {
  const settled = () => structuredClone(read("preview-settled.json"));
  const at = (p: { steps: PulumiStep[] }, tail: string) => p.steps.find((s) => s.urn?.endsWith(tail))!;

  test("an update whose diff names the input an output reads moves it", () => {
    const p = settled();
    const s = at(p, "aws:s3/bucket:Bucket::site-bucket");
    s.op = "update";
    s.newState = { ...s.newState!, inputs: { ...(s.newState!.inputs as object), bucket: "rec-ts-site-2" } };
    s.diffReasons = ["bucket"];
    const r = pulumiPlannedOutputChanges({ part: partOf(p), exported });
    // siteBucketName matches the bucket's id too, and an id stays through an in-place update; bucket is the input the diff names.
    expect(r.outputs.find((o) => o.output === "siteBucketName")).toMatchObject({ verdict: "changing", because: "aws:s3/bucket:Bucket::site-bucket.bucket (update)" });
  });

  test("an output only a provider-computed property holds may move on an update, so it is changing", () => {
    const exp = structuredClone(exported) as { deployment: { resources: Array<Record<string, unknown>> } };
    const stack = exp.deployment.resources.find((r) => r.type === "pulumi:pulumi:Stack")!;
    const queue = exp.deployment.resources.find((r) => String(r.urn).endsWith("Queue::events"))!;
    (queue.outputs as Record<string, unknown>).computedMark = "mark-0042";
    (stack.outputs as Record<string, unknown>).eventsMark = "mark-0042";
    const r = pulumiPlannedOutputChanges({ part: pulumiPreviewPart({ member: "aws", preview: read("preview-replaced.json"), prior: exp }), exported: exp });
    expect(r.outputs.find((o) => o.output === "eventsMark")).toEqual({ output: "eventsMark", verdict: "changing", because: "aws:sqs/queue:Queue::events.computedMark (update)" });
  });

  test("an output no property holds is untraced, so unknown", () => {
    const exp = structuredClone(exported) as { deployment: { resources: Array<Record<string, unknown>> } };
    const stack = exp.deployment.resources.find((r) => r.type === "pulumi:pulumi:Stack")!;
    (stack.outputs as Record<string, unknown>).sitePattern = "arn:aws:s3:::rec-ts-site/*";
    const r = pulumiPlannedOutputChanges({ part: pulumiPreviewPart({ member: "aws", preview: read("preview-replaced.json"), prior: exp }), exported: exp });
    expect(r.outputs.find((o) => o.output === "sitePattern")).toEqual({ output: "sitePattern", verdict: "untraced" });
    expect(r.unknown).toContain("sitePattern");
  });

  test("a resource a targeted preview does not list is left alone; an untargeted one that leaves it out may register it again", () => {
    const p = settled();
    p.steps = p.steps.filter((s) => !s.urn?.endsWith("aws:ec2/vpc:Vpc::main"));
    expect(pulumiPlannedOutputChanges({ part: partOf(p, true), exported }).outputs.find((o) => o.output === "vpcId")?.verdict).toBe("unchanged");
    expect(pulumiPlannedOutputChanges({ part: partOf(p), exported }).outputs.find((o) => o.output === "vpcId")?.verdict).toBe("changing");
  });
});
