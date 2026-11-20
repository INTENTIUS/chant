/**
 * The change risk on the pull-request path (#5325): `ci.risk` read at base,
 * the record over a planned change set, the policy's `input.risk`, and the
 * note. No forge, model or cloud is called.
 */
import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { composeChangeSet, type ChangeSetPart } from "../change-set";
import { parseDeclaration, WorkspaceReadError } from "../workspace/declaration";
import { prLoopRiskAt, prRiskDependents, scorePrSet } from "./pr-risk";
import { memberCounts, PR_REPORT_SCHEMA_ID, renderPrNote, type PrReport } from "../pr-loop";
import { PRODUCT_CONFIG_WORDS } from "../ci-product-words";
import * as ciProduct from "../ci-product";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "pr-risk-")));
  scratch.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
const declaration = (ci: Record<string, unknown> | undefined) => ({ name: "acme", schema: 1, members: [{ name: "infra", dir: "infra", kind: "other", because: "test" }], ...(ci ? { ci } : {}) });

const part = (member: string, action: "delete" | "create"): ChangeSetPart => ({
  member: { member, lexicon: "terraform", planner: "terraform", status: "planned", planDigest: `sha256:${"9".repeat(64)}`, holes: [] },
  entries: [{ member, lexicon: "terraform", planner: "terraform", address: `aws_db_instance.${member}`, type: "aws_db_instance", action, attributes: [] }],
});

describe("ci.risk is read at base (#5325)", () => {
  test("the declaration refuses a setting that would let a score pass a gate, and quorum, which a pull request does not read", () => {
    const parse = (risk: unknown) => parseDeclaration(JSON.stringify(declaration({ risk })), "chant.workspace.json");
    expect(parse({ approveAbove: 0.5, questions: [{ id: "data", text: "Data?", weight: 0.5, approveAbove: 0.4 }] }).ci?.risk).toEqual({ approveAbove: 0.5, questions: [{ id: "data", text: "Data?", weight: 0.5, approveAbove: 0.4 }] });
    expect(() => parse({ allow_unattended: true })).toThrow(WorkspaceReadError);
    expect(() => parse({ allow_unattended: true })).toThrow(/allow_unattended/);
    expect(() => parse({ quorum: [{ count: 2 }] })).toThrow(WorkspaceReadError);
  });

  test("the settings at base win, so a change cannot raise its own threshold", () => {
    const repo = tmp();
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    mkdirSync(join(repo, "infra"));
    writeFileSync(join(repo, "chant.workspace.json"), JSON.stringify(declaration({ risk: { approveAbove: 0.3 } })));
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "chant.workspace.json"), JSON.stringify(declaration({ risk: { approveAbove: 1 } })));
    expect(prLoopRiskAt(join(repo, "infra"), base).settings).toEqual({ approveAbove: 0.3 });
  });

  test("a base with no ci.risk scores nothing: it is off by default", () => {
    const repo = tmp();
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "chant.workspace.json"), JSON.stringify(declaration(undefined)));
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    const read = prLoopRiskAt(repo, git(repo, "rev-parse", "HEAD"));
    expect(read.settings).toBeUndefined();
    expect(scorePrSet(read, { doc: composeChangeSet([part("db", "delete")]), env: "pr-5" })).toBeUndefined();
  });
});

describe("the record over a planned change set (#5325)", () => {
  const doc = composeChangeSet([part("db", "delete"), part("app", "create")]);

  test("no review found gives every question unknown, which is over its threshold, and the note says why", () => {
    const risk = scorePrSet(
      { base: "b", settings: { approveAbove: 0.95, questions: [{ id: "data", text: "Data?", weight: 0.4, approveAbove: 0.9 }] } },
      { doc, env: "pr-5", review: { found: false, risk: "unknown", head: null, reason: "#5 has no review note written by the run's token" } },
    )!;
    expect(risk.reasons.find((r) => r.id === "review")).toMatchObject({ value: 0.5 });
    expect(risk.reasons.find((r) => r.id === "question.data")).toMatchObject({ answer: "unknown", value: 1 });
    expect(risk.over).toBe(true);
    expect(risk.overBy).toEqual(["question data has no answer, which counts above its threshold of 0.9"]);
    const report: PrReport = {
      $schema: PR_REPORT_SCHEMA_ID,
      contract: 1,
      stage: "plan",
      pr: 5,
      env: "pr-5",
      base: "1".repeat(40),
      head: "2".repeat(40),
      op: "pr-5",
      gate: "pr-apply",
      digest: doc.digest,
      status: "planned",
      approval: { status: "pending" },
      selection: { changed: ["db"], dependents: [], unclaimed: [], indeterminate: [], waves: [["db"]] },
      members: [{ member: "db", component: "db", planDigest: doc.members[0]!.planDigest!, status: "planned", counts: memberCounts(doc, "db") }],
      changeSet: doc,
    };
    expect(renderPrNote(report)).not.toContain("**Risk");
    const note = renderPrNote({ ...report, risk });
    expect(note).toContain(`**Risk:** ${risk.score.toFixed(2)} (${risk.level}).`);
    expect(note).toContain("| `destroys`: 1 delete | 0.7 | 0.5 | 0.35 |");
    expect(note).toContain("question data has no answer, which counts above its threshold of 0.9, so this plan needs an approval of its own digest.");
  });

  test("the dependents come from the member's graph; a graph that cannot be read gives none and says why", async () => {
    const reader = async () => ({ ids: ["aws_db_instance.db", "aws_route.r"], edges: [{ from: "aws_route.r", to: "aws_db_instance.db" }] });
    expect(await prRiskDependents(doc, "/x", reader)).toEqual({ dependents: ["aws_route.r"] });
    expect(await prRiskDependents(doc, "/x", async () => ({ error: "no graph" }))).toEqual({ error: "no graph" });
  });
});

describe("the capability ships with its floor and its words (#5325)", () => {
  test("CHANGE_RISK_FLOOR and the record's builders are exported for products", () => {
    expect(typeof ciProduct.CHANGE_RISK_FLOOR).toBe("string");
    expect(typeof ciProduct.scoreChangeRisk).toBe("function");
    expect(typeof ciProduct.changeRiskLines).toBe("function");
  });

  test("the risk keys are in the stage section of the vocabulary", () => {
    const keys = PRODUCT_CONFIG_WORDS.filter((w) => w.key.includes("risk")).map((w) => [w.key, w.section]);
    expect(keys).toEqual([
      ["risk.approve_above", "stage"],
      ["risk.questions", "stage"],
      ["environments.<name>.risk.approval_rules", "stage"],
    ]);
  });
});
