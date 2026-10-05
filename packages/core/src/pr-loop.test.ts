/**
 * The pull-request loop's report and note (#3183): the schema, the note a
 * reviewer reads at each stage, and the status line.
 *
 * The report is what the terragucci plan report (#3349) reads, so the JSON
 * has a golden, and so does the note rendered from it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { composeChangeSet, type ChangeSetPart } from "./change-set";
import {
  describePlanChanged,
  memberCounts,
  PR_REPORT_SCHEMA_ID,
  prApproveCommand,
  prNoteMarker,
  PR_GATE_OP,
  prOp,
  prStatusContext,
  prStatusDescription,
  prStatusState,
  renderPrNote,
  type PrReport,
} from "./pr-loop";
import { contract, validSchema } from "./workspace/__fixtures__/contract-repo";
import schema from "./workspace/pr-report.schema.json";
import changeSetSchema from "./workspace/change-set.schema.json";

const { expectValid } = contract(schema);
const { expectValid: expectValidChangeSet } = contract(changeSetSchema);

const DIR = join(import.meta.dirname, "__fixtures__", "pr-loop");

function golden(name: string, text: string): void {
  const path = join(DIR, name);
  if (process.env.UPDATE_GOLDEN) writeFileSync(path, text);
  expect(text).toBe(readFileSync(path, "utf-8"));
}

const hex = (n: number) => n.toString(16).padStart(64, "0");

function part(member: string, n: number, entries: Array<{ address: string; action: "create" | "update" | "delete" | "replace" }>): ChangeSetPart {
  return {
    member: { member, lexicon: "terraform", planner: "tofu", status: "planned", planDigest: `jcs1-sha256:${hex(n)}`, holes: [] },
    entries: entries.map((e) => ({
      member,
      lexicon: "terraform",
      planner: "tofu",
      address: e.address,
      type: e.address.split(".")[0],
      action: e.action,
      attributes: e.action === "update" ? [{ path: "input", before: "v1", after: "v2" }] : [],
    })),
  };
}

const doc = composeChangeSet([
  part("a", 1, [{ address: "terraform_data.subnet", action: "update" }]),
  part("app", 2, []),
]);

const planReport: PrReport = {
  $schema: PR_REPORT_SCHEMA_ID,
  contract: 1,
  stage: "plan",
  pr: 12,
  env: "prod",
  base: "1".repeat(40),
  head: "2".repeat(40),
  op: prOp(12),
  gate: "pr-apply",
  digest: doc.digest,
  status: "planned",
  approval: { status: "pending" },
  selection: { changed: ["a"], dependents: ["app"], unclaimed: [], indeterminate: [], waves: [["a"], ["app"]] },
  members: [
    { member: "a", component: "a", planDigest: `jcs1-sha256:${hex(1)}`, status: "planned", counts: memberCounts(doc, "a") },
    { member: "app", component: "app", planDigest: `jcs1-sha256:${hex(2)}`, status: "planned", counts: memberCounts(doc, "app") },
  ],
  changeSet: doc,
};

const changedDigest = `jcs1-sha256:${hex(99)}`;
const refusedReport: PrReport = {
  ...planReport,
  stage: "apply",
  status: "refused",
  refusal: "plan-changed",
  approval: { status: "changed", approved: changedDigest },
  message: describePlanChanged({ op: planReport.op, gate: planReport.gate, digest: planReport.digest, approval: { status: "changed", approved: changedDigest } }),
};

const appliedReport: PrReport = {
  ...planReport,
  stage: "apply",
  status: "applied",
  approval: { status: "approved", approvedBy: ["github:alice"] },
  members: [
    { ...planReport.members[0], status: "applied" },
    { ...planReport.members[1], status: "applied", inputsMoved: ["a"] },
  ],
};

const resumedReport: PrReport = {
  ...appliedReport,
  members: [{ ...planReport.members[0], status: "applied" }, { ...planReport.members[1], status: "applied" }],
  resumed: { applied: ["a"] },
};

describe("the pr-report schema", () => {
  test("is a valid schema and names this module's id", () => {
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe(PR_REPORT_SCHEMA_ID);
  });

  test("every stage's report validates, and its change set validates against the change-set schema", () => {
    for (const report of [planReport, refusedReport, appliedReport, resumedReport]) {
      expectValid(report);
      expectValidChangeSet(report.changeSet);
      expect(report.changeSet.digest).toBe(report.digest);
    }
  });

  test("the report has a golden", () => {
    golden("pr-plan.golden.json", JSON.stringify(planReport, null, 2) + "\n");
  });
});

describe("the note", () => {
  test("the plan stage names every member, the digest and the approve command, then the grouped summary", () => {
    const note = renderPrNote(planReport, { approver: "github:<your-login>" });
    expect(note.startsWith(prNoteMarker("prod"))).toBe(true);
    expect(note).toContain(`chant approve pr-12 pr-apply --plan ${doc.digest} --approver github:<your-login> --sign`);
    expect(note).toContain("### Plan summary");
    golden("pr-plan.note.golden.md", note);
  });

  test("a refused apply names both digests and says nothing applied", () => {
    const note = renderPrNote(refusedReport);
    expect(note).toContain("The apply refused.");
    expect(note).toContain("nothing was applied");
    expect(note).toContain(`approved: ${changedDigest}; planned now: ${doc.digest}`);
    golden("pr-apply-refused.note.golden.md", note);
  });

  test("an applied member whose inputs moved says so", () => {
    const note = renderPrNote(appliedReport);
    expect(note).toContain("applied, inputs from a moved");
    expect(note).toContain("Approved by `github:alice` for this digest.");
    golden("pr-apply-applied.note.golden.md", note);
  });

  test("a resumed apply names what the earlier attempt applied (#3464)", () => {
    const note = renderPrNote(resumedReport);
    expect(note).toContain("Resumed under the same approval: `a` applied in an earlier attempt and did not run again.");
    expect(renderPrNote(appliedReport)).not.toContain("Resumed");
  });

  test("a small limit leaves the summary out rather than cutting the table", () => {
    const note = renderPrNote(planReport, { limit: 800 });
    expect(note).toContain("| `app` |");
    expect(note).not.toContain("### Plan summary");
  });
});

describe("the status", () => {
  test("describes each stage in at most 140 characters", () => {
    expect(prStatusDescription(planReport)).toMatch(/^2 members: 1 to change, 0 to destroy or replace; plan [0-9a-f]{12}$/);
    expect(prStatusDescription(refusedReport)).toBe("refused: the plan changed after review");
    expect(prStatusDescription(appliedReport)).toMatch(/^applied 2 members/);
    for (const r of [planReport, refusedReport, appliedReport]) expect(prStatusDescription(r).length).toBeLessThanOrEqual(140);
  });

  test("an unapproved apply is pending, a moved plan fails, an applied one succeeds", () => {
    expect(prStatusState({ ...refusedReport, refusal: "not-approved" })).toBe("pending");
    expect(prStatusState(refusedReport)).toBe("failure");
    expect(prStatusState(appliedReport)).toBe("success");
  });

  test("the approve command binds the digest and asks for a signature", () => {
    expect(prApproveCommand(planReport, "gitlab:ana")).toBe(`chant approve pr-12 pr-apply --plan ${doc.digest} --approver gitlab:ana --sign`);
  });
});

describe("a workspace member's loop (#3465)", () => {
  const memberReport: PrReport = { ...planReport, member: "network", op: prOp(12, "network") };

  test("the op, the note marker and the status contexts carry the member's name", () => {
    expect(prOp(12)).toBe("pr-12");
    expect(prOp(12, "network")).toBe("pr-12-network");
    expect(prNoteMarker("prod", "network")).toBe("<!-- chant-pr:prod:network -->");
    expect(prNoteMarker("prod", "network")).not.toBe(prNoteMarker("prod"));
    expect(prStatusContext("plan")).toBe("chant/plan");
    expect(prStatusContext("apply", "network")).toBe("chant/apply/network");
  });

  test("the gate op pattern takes both forms and nothing else", () => {
    for (const op of ["pr-12", "pr-12-network", "pr-3-a1-b2"]) expect(PR_GATE_OP.test(op)).toBe(true);
    for (const op of ["pr-", "pr-x", "pr-12-", "pr-12-Net", "fan-out"]) expect(PR_GATE_OP.test(op)).toBe(false);
  });

  test("the report with a member validates, and its note names the member and approves its own op", () => {
    expectValid(memberReport);
    const note = renderPrNote(memberReport);
    expect(note.startsWith("<!-- chant-pr:" + memberReport.env + ":network -->")).toBe(true);
    expect(note).toContain("in member `network`");
    expect(note).toContain("chant approve pr-12-network pr-apply");
  });
});
