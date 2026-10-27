/**
 * The pull-request note over a recorded preview (#4548): a resource a
 * component registers inside an `apply()` that preview could not run gets a
 * row of its own, naming the component.
 *
 * `testdata/pulumi-preview/preview-create.json` is recorded (#4475; see its
 * README): the first preview of the plunge corpus's aws-ts program on floci,
 * where the `corpus:index:Site` component `docs` creates children, so an
 * `apply()` inside it may be waiting on a value preview does not know.
 * Nothing here runs Pulumi.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { composeChangeSet } from "@intentius/chant/change-set";
import { memberCounts, prMayAppearRows, prMayAppearText, prOp, PR_REPORT_SCHEMA_ID, renderPrNote, type PrReport } from "@intentius/chant/pr-loop";
import { pulumiMayAppearAddress } from "@intentius/chant/pulumi-urn";
import { pulumiPreviewPart } from "./change-set";

const dir = join(import.meta.dirname, "testdata", "pulumi-preview");
const created = JSON.parse(readFileSync(join(dir, "preview-create.json"), "utf-8"));
const urn = (type: string, name: string) => `urn:pulumi:floci::corpus-aws-ts::${type}::${name}`;
const DOCS = urn("corpus:index:Site", "docs");

const doc = composeChangeSet([pulumiPreviewPart({ member: "site", preview: created, stack: "floci" })]);

const report: PrReport = {
  $schema: PR_REPORT_SCHEMA_ID,
  contract: 1,
  stage: "plan",
  pr: 7,
  env: "floci",
  base: "1".repeat(40),
  head: "2".repeat(40),
  op: prOp(7),
  gate: "pr-apply",
  digest: doc.digest,
  status: "planned",
  approval: { status: "pending" },
  selection: { changed: ["site"], dependents: [], unclaimed: [], indeterminate: [], waves: [["site"]] },
  members: [{ member: "site", component: "site", planDigest: doc.members[0].planDigest, status: "planned", counts: memberCounts(doc, "site") }],
  changeSet: doc,
};

describe("may-appear rows in the pull-request note (#4548)", () => {
  test("the recorded preview's stand-in entry is a row naming its component", () => {
    expect(prMayAppearRows(doc)).toEqual([{ member: "site", component: "corpus:index:Site docs", action: "create" }]);
    expect(doc.entries.find((e) => e.address === pulumiMayAppearAddress(DOCS))?.mayAppear).toBe(true);
  });

  test("the note shows the row, with the parent component's name, in chant's words and in a product's", () => {
    const note = renderPrNote(report);
    expect(note).toContain("Registered inside an `apply()` the preview could not run, so known only at apply:");
    expect(note).toContain("| `site` | `corpus:index:Site docs` | any resource it registers | may register at apply |");
    expect(renderPrNote(report, { applyWord: "up" })).toContain("| `site` | `corpus:index:Site docs` | any resource it registers | may register at up |");
  });

  test("the digest stays as it was: the rows read the document, never write it", () => {
    const before = doc.digest;
    renderPrNote(report);
    expect(doc.digest).toBe(before);
    expect(composeChangeSet([pulumiPreviewPart({ member: "site", preview: created, stack: "floci" })]).digest).toBe(before);
  });

  test("a delete or a missing resource under a flagged component names that component", () => {
    const child = urn("corpus:index:Site$aws:s3/bucketObject:BucketObject", "docs-index");
    const lone = urn("aws:ssm/parameter:Parameter", "vpc-id");
    const base = { member: "site", lexicon: "pulumi", planner: "pulumi" as const, mayAppear: true as const, attributes: [] };
    const rows = prMayAppearRows({
      entries: [
        { ...base, address: pulumiMayAppearAddress(DOCS), type: "unknown", action: "create" },
        { ...base, address: child, type: "aws:s3/bucketObject:BucketObject", action: "delete", disruption: "destroy" },
        { ...base, address: lone, type: "aws:ssm/parameter:Parameter", action: "update", disruption: "unknown" },
      ],
    });
    expect(rows).toEqual([
      { member: "site", component: "corpus:index:Site docs", action: "create" },
      { member: "site", component: "corpus:index:Site docs", resource: "aws:s3/bucketObject:BucketObject docs-index", action: "delete" },
      { member: "site", component: "the stack", resource: "aws:ssm/parameter:Parameter vpc-id", action: "update" },
    ]);
    expect(rows.map((r) => prMayAppearText(r, "up"))).toEqual([
      "may register at up",
      "planned to delete, and may register again at up",
      "missing from the preview, and may register at up",
    ]);
  });
});
