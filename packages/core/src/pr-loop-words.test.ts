/**
 * The pull request note and statuses in a product's words (#4550, ruling D:
 * fixed slots filled into chant's sentences), and the member detail sections
 * a lexicon renders (#4573).
 */
import { describe, expect, test } from "vitest";
import { composeChangeSet } from "./change-set";
import { memberCounts, PR_REPORT_SCHEMA_ID, prApproveCommand, prApproveCommands, prMergeSentence, prStatusContext, prStatusDescription, renderPrNote, type PrReport } from "./pr-loop";
import { assertProductWords, CHANT_WORDS } from "./ci-product-words";
import { PLYWOOD, TERRAGUCCI, YODEL } from "./__fixtures__/product-words";

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

describe("the approve line's target and the merge sentence (#4601)", () => {
  const yodel = assertProductWords(YODEL);
  const terragucci = assertProductWords(TERRAGUCCI);

  /** sql-yodeler's probe (src/pr/note.ts at integration/ci-products): one environment, the wave's gate and digest. */
  const probe: PrReport = {
    ...report,
    env: "yodel-probe-env",
    op: "yodel-apply",
    gate: "yodel-apply-wave-1",
    digest: "jcs1-sha256:probe",
    members: [{ member: "yodel-probe-env", component: "1 pending", planDigest: "jcs1-sha256:probe", status: "planned", counts: { create: 0, update: 0, replace: 0, delete: 0 } }],
    selection: { changed: ["yodel-probe-env"], dependents: [], unclaimed: [], indeterminate: [], waves: [["yodel-probe-env"]] },
  };

  test("sql-yodeler's probe passes: the approve line names the environment, and no release deploys the merge", () => {
    const note = renderPrNote(probe, { words: yodel });
    expect(note).toContain("yodel approve yodel-probe-env --plan jcs1-sha256:probe --sign");
    expect(note).not.toContain("a release deploys it");
    expect(note).toContain("On merge the waves are applied in order, each under an approval of its own gate for its own plan.");
  });

  test("{target} is filled once per member, and a template without it gives one line", () => {
    const tenants: PrReport = {
      ...probe,
      env: "prod",
      members: ["prod/acme", "prod/zeta"].map((m) => ({ member: m, component: "1 pending", planDigest: "jcs1-sha256:probe", status: "planned" as const, counts: { create: 0, update: 0, replace: 0, delete: 0 } })),
    };
    expect(prApproveCommands(tenants, "<you>", yodel)).toEqual(["yodel approve prod/acme --plan jcs1-sha256:probe --sign", "yodel approve prod/zeta --plan jcs1-sha256:probe --sign"]);
    const note = renderPrNote(tenants, { words: yodel });
    expect(note).toContain("approves each environment's plan with:");
    expect(note).toContain("yodel approve prod/zeta --plan jcs1-sha256:probe --sign");
    expect(prApproveCommands({ ...tenants, member: "prod/acme" }, "<you>", yodel)).toEqual(["yodel approve prod/acme --plan jcs1-sha256:probe --sign"]);
    expect(prApproveCommands({ ...tenants, members: [] }, "<you>", yodel)).toEqual(["yodel approve prod --plan jcs1-sha256:probe --sign"]);
    expect(prApproveCommands(tenants, "<you>", plywood)).toEqual([`plywood approve ${tenants.gate} --plan jcs1-sha256:probe --sign`]);
    expect(prApproveCommand({ ...report, target: "shop-dev" }, "<you>", plywood)).toBe(`plywood approve up --plan ${doc.digest} --sign`);
  });

  test("the merge sentence follows each product's apply mode", () => {
    expect(prMergeSentence(report, plywood)).toBe(
      "On merge the waves are updated in order under this approval, each while its plan is one this approval covers. A wave whose plan moved waits at its own gate, `wave-<k>`, for an approval of its own.",
    );
    expect(prMergeSentence(report, terragucci)).toBe(
      "On merge the waves are applied in order, each under an approval of its own gate for its own plan. A wave whose plan moved since this note waits at its gate for a new approval.",
    );
    expect(prMergeSentence(report, CHANT_WORDS)).toContain("On merge the plan is recorded, and a release deploys it.");
    expect(prMergeSentence(report, assertProductWords({ ...PLYWOOD, applyMode: "before-merge" }))).toBe(
      "Before merge, `/plywood up` runs this plan once the pull request is approved, mergeable and green, and only while the plan is still this one; if it moved, the apply refuses and names both digests. The merge records what was updated.",
    );
    for (const w of [plywood, terragucci, yodel]) expect(renderPrNote(report, { words: w })).not.toContain("a release deploys it");
    expect(renderPrNote({ ...report, op: "pr-12", gate: "pr-apply" }, { words: CHANT_WORDS })).toContain("On merge the plan is recorded, and a release deploys it.");
  });
});
