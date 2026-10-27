/**
 * The pull request note and statuses in a product's words (#4550, ruling D:
 * fixed slots filled into chant's sentences), and the member detail sections
 * a lexicon renders (#4573).
 */
import { describe, expect, test } from "vitest";
import { composeChangeSet } from "./change-set";
import { memberCounts, PR_REPORT_SCHEMA_ID, prApproveCommand, prStatusContext, prStatusDescription, renderPrNote, type PrReport } from "./pr-loop";
import { assertProductWords, CHANT_WORDS } from "./ci-product-words";
import { PLYWOOD } from "./__fixtures__/product-words";

const hex = (n: number) => n.toString(16).padStart(64, "0");
const doc = composeChangeSet([
  {
    member: { member: "shop-dev", lexicon: "pulumi", planner: "pulumi", status: "planned", planDigest: `jcs1-sha256:${hex(1)}`, holes: [] },
    entries: [{ member: "shop-dev", lexicon: "pulumi", planner: "pulumi", address: "urn:pulumi:dev::shop::aws:s3/bucket:Bucket::site", type: "aws:s3/bucket:Bucket", action: "create", attributes: [] }],
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

describe("the note in a product's words (#4550)", () => {
  test("the heading, the noun, the verbs and the approve line are the product's", () => {
    const note = renderPrNote(report, { words: plywood });
    expect(note).toContain("### plywood preview for `dev`");
    expect(note).toContain("Previewed 1 stack.");
    expect(note).toContain("| Stack | Component | Status |");
    expect(note).toContain("| `shop-dev` | shop | previewed |");
    expect(note).toContain(`plywood approve up --plan ${doc.digest} --sign`);
    expect(note).not.toMatch(/chant approve/);
  });

  test("chant's words render the note chant always rendered", () => {
    const note = renderPrNote({ ...report, op: "pr-12", gate: "pr-apply" }, { words: CHANT_WORDS });
    expect(note).toContain("### chant plan for `dev`");
    expect(note).toContain("Planned 1 member.");
    expect(note).toContain(`chant approve pr-12 pr-apply --plan ${doc.digest} --approver <you> --sign`);
  });

  test("statuses take the product's prefix and stage word", () => {
    expect(prStatusContext("plan", undefined, plywood)).toBe("plywood/preview");
    expect(prStatusContext("apply", "shop-dev", plywood)).toBe("plywood/up/shop-dev");
    expect(prStatusContext("plan", undefined, CHANT_WORDS)).toBe("chant/plan");
    expect(prStatusDescription(report, plywood)).toMatch(/^1 stack: /);
    expect(prApproveCommand(report, "<you>", plywood)).toBe(`plywood approve up --plan ${doc.digest} --sign`);
  });
});

describe("a member's detail section (#4573)", () => {
  test("sits in a collapsed block under the member table", () => {
    const note = renderPrNote({ ...report, details: [{ member: "shop-dev", lines: ["| Statement | Class |", "|---|---|", "| `DROP TABLE x` | destructive |"] }] }, { words: plywood });
    expect(note).toContain("<details><summary>Stack `shop-dev`</summary>");
    expect(note).toContain("| `DROP TABLE x` | destructive |");
    expect(note.indexOf("<details>")).toBeGreaterThan(note.indexOf("| Stack | Component |"));
  });

  test("is left out, and named, when it would pass the comment limit", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `| row ${i} | ${"x".repeat(40)} |`);
    const note = renderPrNote({ ...report, details: [{ member: "shop-dev", lines }] }, { words: plywood, limit: 4000 });
    expect(note).not.toContain("<details>");
    expect(note).toContain("Left out to keep this note within the comment limit: the detail of `shop-dev`.");
    expect([...note].length).toBeLessThanOrEqual(4000);
  });
});

describe("a capability's policy findings (#4550, pulumi-up's CrossGuard)", () => {
  test("a denial names the rules and the product's override line, and advisory findings are rows", () => {
    const note = renderPrNote(
      {
        ...report,
        status: "plan-failed",
        capabilityPolicy: [
          { member: "shop/dev", denied: true, denials: [{ rule: "crossguard.aws.no-public-bucket", message: "the bucket is public" }], holds: [], warnings: [] },
          { member: "shop/prod", denied: false, denials: [], holds: [{ rule: "crossguard.aws.tags", message: "missing the team tag" }], warnings: ["pack aws is in preview"] },
        ],
      },
      { words: plywood },
    );
    expect(note).toContain("The policy in `shop/dev`'s preview denied it, so nothing can apply:");
    expect(note).toContain("- `crossguard.aws.no-public-bucket`: the bucket is public");
    expect(note).toContain("plywood override up --rule crossguard.aws.no-public-bucket --reason <text>");
    expect(note).toContain("| `shop/prod` | `crossguard.aws.tags` | advisory | missing the team tag |");
    expect(note).toContain("| `shop/prod` |  | warning | pack aws is in preview |");
  });
});
