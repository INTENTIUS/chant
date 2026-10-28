/**
 * A narrowed plan in the note and the status (#4626): each narrowed
 * member's row lists its addresses, a line says the plan on merge is of
 * each member whole, and the status counts the narrowed members, in the
 * product's words. Written for the ci-products post-merge pass.
 */
import { describe, expect, test } from "vitest";
import { composeChangeSet } from "./change-set";
import { memberCounts, PR_REPORT_SCHEMA_ID, prStatusDescription, renderPrNote, type PrReport } from "./pr-loop";
import { assertProductWords } from "./ci-product-words";
import { PLYWOOD } from "./__fixtures__/product-words";

const hex = (n: number) => n.toString(16).padStart(64, "0");
const URN = "urn:pulumi:dev::shop::aws:s3/bucket:Bucket::site";
const doc = composeChangeSet([
  {
    member: { member: "shop-dev", lexicon: "pulumi", planner: "pulumi", status: "planned", planDigest: `jcs1-sha256:${hex(1)}`, holes: [] },
    entries: [{ member: "shop-dev", lexicon: "pulumi", planner: "pulumi", address: URN, type: "aws:s3/bucket:Bucket", action: "create", attributes: [] }],
  },
]);
const report: PrReport = {
  $schema: PR_REPORT_SCHEMA_ID,
  contract: 1,
  stage: "plan",
  pr: 12,
  env: "dev",
  base: "1".repeat(40),
  head: "2".repeat(40),
  op: "pulumi-up",
  gate: "up",
  digest: doc.digest,
  status: "planned",
  approval: { status: "pending" },
  selection: { changed: ["shop"], dependents: [], unclaimed: [], indeterminate: [], waves: [["shop"]] },
  members: [{ member: "shop-dev", component: "shop", planDigest: `jcs1-sha256:${hex(1)}`, status: "planned", counts: memberCounts(doc, "shop-dev") }],
  changeSet: doc,
};
const plywood = assertProductWords(PLYWOOD);

describe("a narrowed plan (#4626)", () => {
  const narrowed: PrReport = { ...report, narrowed: { shop: [URN] } };

  test("the member's row lists the addresses", () => {
    const note = renderPrNote(narrowed, { words: plywood });
    const row = note.split("\n").find((l) => l.startsWith("| `shop-dev`"))!;
    expect(row).toContain(`narrowed to \`${URN}\``);
  });

  test("a line says so in the product's words, and that the update on merge plans each stack whole", () => {
    const note = renderPrNote(narrowed, { words: plywood });
    expect(note).toContain(`This preview was narrowed with \`--target\`: \`shop\` to \`${URN}\`. The approval binds the narrowed plan. On merge each stack is previewed whole.`);
  });

  test("the status counts the narrowed members", () => {
    expect(prStatusDescription(narrowed, plywood)).toMatch(/^1 stack \(1 narrowed with --target\): /);
    expect(prStatusDescription(narrowed, plywood).length).toBeLessThanOrEqual(140);
  });

  test("a plan that was not narrowed says nothing of it", () => {
    expect(renderPrNote(report, { words: plywood })).not.toContain("narrowed");
    expect(prStatusDescription(report, plywood)).not.toContain("narrowed");
  });
});
