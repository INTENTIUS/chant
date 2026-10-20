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
  PR_REPORT_DEPLOYED_OUTPUTS_FLOOR,
  PR_REPORT_SCHEMA_ID,
  PR_REPORT_WAVES_FLOOR,
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

/** A plan whose members read `net` and `a` from the deployed estate (#4104). */
const deployedReport: PrReport = { ...planReport, deployedOutputs: { a: ["id"], net: ["cidr"], dns: [] } };

describe("the pr-report schema", () => {
  test("is a valid schema and names this module's id", () => {
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe(PR_REPORT_SCHEMA_ID);
  });

  test("every stage's report validates, and its change set validates against the change-set schema", () => {
    for (const report of [planReport, refusedReport, appliedReport, resumedReport, deployedReport]) {
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

  test("a plan that read dependencies from the deployed estate names each and its outputs (#4104)", () => {
    const note = renderPrNote(deployedReport);
    expect(note).toContain("Planned against outputs read from the deployed estate: `a` (`id`); `net` (`cidr`); `dns` (none yet).");
    expect(renderPrNote(planReport)).not.toContain("deployed estate");
    expect(PR_REPORT_DEPLOYED_OUTPUTS_FLOOR).toBe("0.124.30");
    expect(schema.required).not.toContain("deployedOutputs");
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
    expect(prStatusDescription({ ...refusedReport, refusal: "author-approved" })).toBe("refused: the approver wrote the change");
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

describe("a gate per wave on merge (#4003)", () => {
  const waveDigest = `jcs1-sha256:${hex(7)}`;
  const wave1 = { wave: 1, components: ["a"], status: "applied" as const, approval: "pull-request" as const, gate: "pr-apply", digest: doc.digest, approvedBy: ["github:alice"] };
  const waveApplied: PrReport = {
    ...appliedReport,
    status: "wave-applied",
    waveGate: "release",
    waves: [wave1],
    members: [{ ...planReport.members[0], status: "applied" }, planReport.members[1]],
  };
  const waiting: PrReport = {
    ...waveApplied,
    status: "refused",
    refusal: "wave-not-approved",
    message: "Wave 2 was planned after the waves before it applied, and the pull request's approved plan does not cover it.",
    waves: [
      wave1,
      { wave: 2, components: ["app"], status: "waiting", approval: "wave", gate: "release-wave-2", digest: waveDigest, moved: ["app now writes app.main.cidr to a different value than the approved plan"] },
    ],
  };

  test("the reports validate, waveGate and waves are optional, and both came with the same chant", () => {
    for (const r of [waveApplied, waiting]) expectValid(r);
    expect(schema.required).not.toContain("waves");
    expect(schema.required).not.toContain("waveGate");
    expect(PR_REPORT_WAVES_FLOOR).toBe("0.124.32");
  });

  test("the note has a row per wave saying whose approval it applied under", () => {
    const note = renderPrNote(waveApplied);
    expect(note).toContain("Applied wave 1 of 2. The next wave runs in its own job.");
    expect(note).toContain("| 1 | `a` | applied | the pull request's `pr-apply` by `github:alice` |");
  });

  test("a wave that waits names why its plan moved and the approve command for its own gate", () => {
    const note = renderPrNote(waiting, { approver: "github:<your-login>" });
    expect(note).toContain("Wave 2 waits at its gate `release-wave-2`; nothing in it applied.");
    expect(note).toContain("| 2 | `app` | waiting | its own `release-wave-2`, not approved yet |");
    expect(note).toContain("- app now writes app.main.cidr to a different value than the approved plan");
    expect(note).toContain(`chant approve pr-12 release-wave-2 --plan ${waveDigest} --approver github:<your-login> --sign`);
    golden("pr-apply-wave-waiting.note.golden.md", note);
  });

  test("with --wave-gate the plan's note says later waves are planned again and may stop at their own gate; without it, nothing", () => {
    const sentence = "On merge each wave after the first is planned again once the waves before it apply, and a wave whose plan moved stops at its own gate, `release-wave-<k>`, for approval.";
    const planned = renderPrNote({ ...planReport, waveGate: "release" });
    expect(planned).toContain(sentence);
    expect(renderPrNote({ ...planReport, waveGate: "release", approval: { status: "approved", approvedBy: ["github:alice"] } })).toContain(sentence);
    expect(renderPrNote(planReport)).not.toContain("planned again");
    expect(renderPrNote(waveApplied)).not.toContain("planned again");
    expectValid({ ...planReport, waveGate: "release" });
  });

  test("the status: a wave applied succeeds, a wave waiting on its approval is pending, a moved approval fails", () => {
    expect(prStatusDescription(waveApplied)).toBe("applied wave 1 of 2 under the pull request's approval");
    expect(prStatusState(waveApplied)).toBe("success");
    expect(prStatusDescription(waiting)).toBe("wave 2 waits at release-wave-2: its plan moved, approve it");
    expect(prStatusState(waiting)).toBe("pending");
    expect(prStatusState({ ...waiting, refusal: "wave-plan-changed" })).toBe("failure");
    expect(prStatusDescription({ ...waiting, waves: [wave1], refusal: "earlier-wave" })).toBe("refused: an earlier wave has not applied");
  });
});
