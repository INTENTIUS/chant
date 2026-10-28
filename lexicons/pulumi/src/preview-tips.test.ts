/**
 * Preview tips (#4634) over the recorded preview stream
 * (`testdata/pulumi-stream`, converted from the #4475 recording) and over
 * copies of its steps edited in the test to show each pattern. No engine
 * runs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { withProductWords } from "@intentius/chant/ci-product-words";
import { pulumiPreviewPart, type PulumiStep } from "./change-set";
import { pulumiStreamPreview } from "./engine-events";
import { pulumiPlugin } from "./plugin";
import { nameStem, pulumiPreviewTips, pulumiTipsDetail } from "./preview-tips";

const TESTDATA = join(import.meta.dirname, "testdata");
const stream = readFileSync(join(TESTDATA, "pulumi-stream", "preview-stream.ndjson"), "utf8");
const prior = JSON.parse(readFileSync(join(TESTDATA, "pulumi-preview", "stack-export.json"), "utf8")) as unknown;
const recorded = (): PulumiStep[] => structuredClone(pulumiStreamPreview(stream).steps);

const part = (steps: PulumiStep[]) => pulumiPreviewPart({ member: "app", preview: { steps }, prior });
const doc = (steps: PulumiStep[]) => ({ entries: part(steps).entries });

const BUCKET = "urn:pulumi:floci::corpus-aws-ts::aws:s3/bucket:Bucket::site-bucket";
const ROLE = "urn:pulumi:floci::corpus-aws-ts::aws:iam/role:Role::app-role";

/** The recorded steps with site-bucket deleted and site-bucket-v2 created in its place, as a rename with no alias previews. */
function renamed(): PulumiStep[] {
  const steps = recorded();
  const at = steps.findIndex((s) => s.urn === BUCKET);
  const bucket = steps[at]!;
  const created: PulumiStep = { op: "create", urn: BUCKET.replace(/site-bucket$/, "site-bucket-v2"), newState: { ...bucket.newState!, urn: BUCKET.replace(/site-bucket$/, "site-bucket-v2") } };
  steps[at] = { op: "delete", urn: BUCKET, oldState: bucket.oldState! };
  steps.push(created);
  return steps;
}

describe("the recorded preview", () => {
  test("shows no tip: worker-2's delete has no create of its type and stem, and neither replace is forced by a name", () => {
    const entries = part(recorded()).entries;
    expect(entries.some((e) => e.action === "delete" && e.name === "worker-2")).toBe(true);
    expect(pulumiPreviewTips(entries)).toEqual([]);
    expect(pulumiTipsDetail({ member: "app", changeSet: { entries } })).toBeUndefined();
  });
});

describe("rename-without-aliases", () => {
  test("a delete and a create of one type and stem", () => {
    expect(pulumiPreviewTips(doc(renamed()).entries)).toEqual([
      { id: "rename-without-aliases", member: "app", address: BUCKET, type: "aws:s3/bucket:Bucket", name: "site-bucket", created: { address: BUCKET.replace(/site-bucket$/, "site-bucket-v2"), name: "site-bucket-v2" } },
    ]);
  });

  test("the same name under a new parent", () => {
    const steps = recorded();
    const at = steps.findIndex((s) => s.urn === BUCKET);
    const bucket = steps[at]!;
    const moved = "urn:pulumi:floci::corpus-aws-ts::corpus:index:Site$aws:s3/bucket:Bucket::site-bucket";
    steps[at] = { op: "delete", urn: BUCKET, oldState: bucket.oldState! };
    steps.push({ op: "create", urn: moved, newState: { ...bucket.newState!, urn: moved } });
    expect(pulumiPreviewTips(doc(steps).entries).map((t) => [t.id, t.created?.address])).toEqual([["rename-without-aliases", moved]]);
  });

  test("a different type, or a different stem, is no rename", () => {
    const steps = recorded();
    const bucket = steps.find((s) => s.urn === BUCKET)!;
    const other = "urn:pulumi:floci::corpus-aws-ts::aws:s3/bucket:Bucket::logs";
    steps.push({ op: "create", urn: other, newState: { ...bucket.newState!, urn: other } });
    expect(pulumiPreviewTips(doc(steps).entries)).toEqual([]);
    expect(nameStem("Site-Bucket_v2")).toBe("site");
  });
});

describe("replace-on-name", () => {
  test("a create-before-delete replace forced by name", () => {
    const steps = recorded();
    const at = steps.findIndex((s) => s.urn === ROLE);
    const role = steps[at]!;
    steps[at] = {
      ...role,
      op: "replace",
      newState: { ...role.newState!, inputs: { ...(role.newState!.inputs as object), name: "app-role-2" } },
      replaceReasons: ["name"],
      diffReasons: ["name"],
      detailedDiff: { name: { kind: "update-replace", inputDiff: true } },
    };
    const tips = pulumiPreviewTips(doc(steps).entries);
    expect(tips).toEqual([expect.objectContaining({ id: "replace-on-name", name: "app-role", inputs: ["name"] })]);
  });

  test("a delete-before-replace already deletes first", () => {
    const steps = recorded();
    const at = steps.findIndex((s) => s.urn === ROLE);
    const role = steps[at]!;
    steps.splice(at, 1, { ...role, op: "delete-replaced", replaceReasons: ["name"] }, { ...role, op: "create-replacement", replaceReasons: ["name"] });
    expect(pulumiPreviewTips(doc(steps).entries)).toEqual([]);
  });
});

describe("unknown-in-apply", () => {
  test("a component whose child waits on an unknown may register more at up", () => {
    // The JSON recording: the stream omits a component's custom: false, which signal 1 of the change set reads.
    const steps = structuredClone((JSON.parse(readFileSync(join(TESTDATA, "pulumi-preview", "preview.json"), "utf8")) as { steps: PulumiStep[] }).steps);
    const child = steps.find((s) => s.urn?.endsWith("Site$aws:s3/bucket:Bucket::docs-assets"))!;
    child.op = "update";
    child.newState = { ...child.newState!, inputs: { ...(child.newState!.inputs as object), tags: "04da6b54-80e4-46f7-96ec-b56ff0331ba9" } };
    child.diffReasons = ["tags"];
    const tips = pulumiPreviewTips(doc(steps).entries);
    expect(tips.map((t) => t.id)).toEqual(["unknown-in-apply"]);
    expect(tips[0]!.address).toContain("corpus:index:Site$*::docs");
  });
});

describe("the note", () => {
  test("one row per tip with its id, and the product's tips command", () => {
    const detail = pulumiTipsDetail({ member: "app", changeSet: doc(renamed()), words: { product: "plywood", noun: ["stack", "stacks"] } });
    expect(detail).toEqual({
      title: "Tips for stack `app` (1)",
      lines: [
        "| Tip | Resource | Preview |",
        "|---|---|---|",
        "| `rename-without-aliases` | `aws:s3/bucket:Bucket` `site-bucket` | deleted, and `site-bucket-v2` of the same type created, with no alias between them |",
        "",
        "`plywood tips rename-without-aliases` prints the fix.",
      ],
    });
  });

  test("the plugin renders it at plan, in the active product's words", async () => {
    const changeSet = doc(renamed()) as never;
    const detail = await withProductWords({ product: "plywood", noun: ["stack", "stacks"] }, async () => pulumiPlugin.prNoteDetail!({ member: "app", changeSet, stage: "plan" }));
    expect(detail?.lines.at(-1)).toBe("`plywood tips rename-without-aliases` prints the fix.");
    expect(await pulumiPlugin.prNoteDetail!({ member: "app", changeSet, stage: "apply" })).toBeUndefined();
  });
});
