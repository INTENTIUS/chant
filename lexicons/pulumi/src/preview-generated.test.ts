/**
 * Values the engine makes up while planning stay out of the digest (plywood#56).
 * `testdata/pulumi-preview/preview-create.json` is a recorded first preview:
 * its queues carry autonames (`events-3f45941`, `worker-0-84f29f5`) the
 * provider filled in, listed in each step's `__defaults`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PULUMI_GENERATED, pulumiPlannedInputs, pulumiPreviewDigest, pulumiResourceDigests, type PulumiStep } from "./change-set";

const created = JSON.parse(readFileSync(join(import.meta.dirname, "testdata", "pulumi-preview", "preview-create.json"), "utf-8")) as { steps: PulumiStep[] };
const copy = () => JSON.parse(JSON.stringify(created)) as typeof created;
const stepOf = (doc: typeof created, name: string) => doc.steps.find((s) => s.urn?.endsWith(`::${name}`))!;
const inputsOf = (doc: typeof created, name: string) => stepOf(doc, name).newState!.inputs as Record<string, unknown>;

/** The same preview drawn again: every autoname gets another suffix. */
function replanned(): typeof created {
  const doc = copy();
  for (const s of doc.steps) {
    const inputs = s.newState?.inputs as Record<string, unknown> | undefined;
    if (!inputs || !Array.isArray(inputs.__defaults)) continue;
    for (const key of inputs.__defaults as string[]) {
      const v = inputs[key];
      if (typeof v === "string" && /-[0-9a-f]{7}$/.test(v)) inputs[key] = v.replace(/[0-9a-f]{7}$/, "0123abc");
    }
  }
  return doc;
}

describe("a create's digest leaves out what the engine drew while planning", () => {
  test("the recorded preview holds autonames, and a second draw gives the same digest", () => {
    expect(inputsOf(created, "events").name).toBe("events-3f45941");
    expect(inputsOf(replanned(), "events").name).toBe("events-0123abc");
    expect(pulumiPreviewDigest(replanned())).toBe(pulumiPreviewDigest(created));
    expect(pulumiPreviewDigest(replanned(), { changedOnly: true })).toBe(pulumiPreviewDigest(created, { changedOnly: true }));
  });

  test("the name is replaced by one marker, and the rest of the inputs are kept", () => {
    const planned = pulumiPlannedInputs(stepOf(created, "events")) as Record<string, unknown>;
    expect(planned.name).toBe(PULUMI_GENERATED);
    expect(planned.messageRetentionSeconds).toBe(3600);
    expect(planned.maxMessageSize).toBe(262144);
    expect(planned.tags).toEqual({ "corpus-owner": "plunge", "corpus-program": "aws-ts" });
  });

  test("two creates that differ in an input a reviewer saw still differ", () => {
    for (const change of [
      (d: typeof created) => { inputsOf(d, "events").messageRetentionSeconds = 7200; },
      (d: typeof created) => { (inputsOf(d, "worker-0").tags as Record<string, string>)["corpus-index"] = "9"; },
      // a default that is a plain value counts: it decides what gets applied
      (d: typeof created) => { inputsOf(d, "events").maxMessageSize = 1024; },
      // a name the program set is not a draw, and a changed one is a change
      (d: typeof created) => { inputsOf(d, "app-role").name = "rec-ts-other"; },
    ]) {
      const other = replanned();
      change(other);
      expect(pulumiPreviewDigest(other)).not.toBe(pulumiPreviewDigest(created));
    }
  });

  test("a different logical name or a new resource changes the digest", () => {
    const renamed = replanned();
    stepOf(renamed, "events").urn = stepOf(renamed, "events").urn!.replace("::events", "::journal");
    expect(pulumiPreviewDigest(renamed)).not.toBe(pulumiPreviewDigest(created));
    const extra = replanned();
    extra.steps.push({ ...stepOf(extra, "docs-notify"), urn: stepOf(extra, "docs-notify").urn!.replace("::docs-notify", "::more-notify") });
    expect(pulumiPreviewDigest(extra)).not.toBe(pulumiPreviewDigest(created));
  });

  test("a string that only looks like a suffix is kept unless the engine filled it in", () => {
    const doc = copy();
    const step = stepOf(doc, "events");
    (step.newState!.inputs as Record<string, unknown>).description = "events-3f45941";
    expect((pulumiPlannedInputs(step) as Record<string, unknown>).description).toBe("events-3f45941");
    // a name the program wrote is not listed in __defaults
    (step.newState!.inputs as Record<string, unknown>).__defaults = [];
    expect((pulumiPlannedInputs(step) as Record<string, unknown>).name).toBe("events-3f45941");
  });

  test("an engine that prints no __defaults is held to the exact logical name", () => {
    const step: PulumiStep = { op: "create", urn: "urn:pulumi:dev::p::aws:sqs/queue:Queue::events", newState: { inputs: { name: "events-3f45941", other: "worker-3f45941" } } };
    expect(pulumiPlannedInputs(step)).toEqual({ name: PULUMI_GENERATED, other: "worker-3f45941" });
  });

  test("an update keeps its inputs, since it draws no name", () => {
    const update: PulumiStep = {
      op: "update",
      urn: "urn:pulumi:dev::p::aws:sqs/queue:Queue::events",
      oldState: { inputs: { name: "events-3f45941", messageRetentionSeconds: 60 } },
      newState: { inputs: { __defaults: ["name"], name: "events-3f45941", messageRetentionSeconds: 7200 } },
    };
    expect(pulumiPlannedInputs(update)).toBe(update.newState!.inputs);
    const other = JSON.parse(JSON.stringify(update)) as PulumiStep;
    (other.oldState!.inputs as Record<string, unknown>).name = "events-aaaaaaa";
    (other.newState!.inputs as Record<string, unknown>).name = "events-aaaaaaa";
    expect(pulumiPreviewDigest({ steps: [other] })).not.toBe(pulumiPreviewDigest({ steps: [update] }));
  });

  test("a replacement draws a new name too", () => {
    const replace = (suffix: string): PulumiStep => ({
      op: "replace",
      urn: "urn:pulumi:dev::p::aws:sqs/queue:Queue::events",
      oldState: { inputs: { name: "events-1111111", fifoQueue: false } },
      newState: { inputs: { __defaults: ["name"], name: `events-${suffix}`, fifoQueue: true } },
      replaceReasons: ["fifoQueue"],
    });
    expect(pulumiPreviewDigest({ steps: [replace("2222222")] })).toBe(pulumiPreviewDigest({ steps: [replace("3333333")] }));
    const flipped = replace("2222222");
    (flipped.newState!.inputs as Record<string, unknown>).fifoQueue = false;
    expect(pulumiPreviewDigest({ steps: [flipped] })).not.toBe(pulumiPreviewDigest({ steps: [replace("2222222")] }));
  });
});
