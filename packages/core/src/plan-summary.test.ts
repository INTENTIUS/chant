/**
 * The grouped plan summary (#3188): its schema, what is never folded into a
 * group, and the size of the markdown note.
 *
 * The normalization vectors and the real N=5 module bump run in
 * `lexicons/terraform/src/plan-summary.test.ts`, which reads them through the
 * terraform adapters. Its JSON golden is validated here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { composeChangeSet, type ChangeSetAction, type ChangeSetEntry, type ChangeSetPart } from "./change-set";
import {
  GITHUB_COMMENT_LIMIT,
  groupChangeSet,
  PLAN_SUMMARY_SCHEMA_ID,
  renderPlanSummaryMarkdown,
  renderPlanSummaryText,
  splitInstanceKeys,
  escapeMarkerAddress,
} from "./plan-summary";
import { contract, REPO, validSchema } from "./workspace/__fixtures__/contract-repo";
import schema from "./workspace/plan-summary.schema.json";

const { expectValid } = contract(schema);

let digest = 0;

function part(member: string, entries: Array<Partial<ChangeSetEntry> & { address: string; action: ChangeSetAction }>, extra: Partial<ChangeSetPart["member"]> = {}): ChangeSetPart {
  return {
    member: { member, lexicon: "terraform", planner: "terraform", status: "planned", planDigest: `jcs1-sha256:${(++digest).toString(16).padStart(64, "0")}`, holes: [], ...extra },
    entries: entries.map((e) => ({ member, lexicon: "terraform", planner: "terraform", type: e.address.split(".")[0], attributes: [], ...e })),
  };
}

const tagsUpdate = (address: string, member: string) => ({
  address,
  action: "update" as const,
  attributes: [{ path: "tags", before: { Name: `${member}-app`, v: "1" }, after: { Name: `${member}-app`, v: "2" } }],
});

describe("the plan-summary schema", () => {
  test("is a valid schema and names this module's id", () => {
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe(PLAN_SUMMARY_SCHEMA_ID);
  });

  test("accepts the golden summary of the N=5 module bump", () => {
    const path = join(REPO, "lexicons", "terraform", "src", "__fixtures__", "plan-summary", "largeset-n5.summary.golden.json");
    expectValid(JSON.parse(readFileSync(path, "utf-8")));
  });
});

describe("what is never folded into a group", () => {
  // Thirty roots take the same tag change. Three of them also destroy or
  // replace something, one failed to plan and one has a hole.
  const parts: ChangeSetPart[] = [];
  for (let i = 1; i <= 30; i++) {
    const m = `roots/r${String(i).padStart(2, "0")}`;
    const entries: Parameters<typeof part>[1] = [tagsUpdate("aws_iam_role.app", `r${String(i).padStart(2, "0")}`)];
    if (i === 3) entries.push({ address: "aws_db_instance.main", action: "delete" });
    if (i === 7 || i === 8) entries.push({ address: "aws_lambda_function.worker", action: "replace", attributes: [{ path: "runtime", before: "nodejs18.x", after: "nodejs22.x", forcesReplacement: true }] });
    parts.push(part(m, entries, { scope: `r${String(i).padStart(2, "0")}` }));
  }
  parts.push(part("roots/broken", [{ address: "aws_s3_bucket.gone", action: "delete" }], { status: "failed", error: "terraform marked the plan errored" }));
  parts.push(part("roots/r99", [tagsUpdate("aws_iam_role.app", "r99")], { scope: "r99", holes: [{ address: "aws_kms_key.k", reason: "access denied" }] }));
  const doc = composeChangeSet(parts);
  const s = groupChangeSet(doc);

  test("the identical change is one group; the destroys and replacements split off but are each named", () => {
    expect(s.groups.map((g) => g.units.length)).toEqual([28, 2, 1]);
    const named = s.destroys.map((d) => `${d.member} ${d.address} ${d.action}`);
    expect(named).toEqual([
      "roots/broken aws_s3_bucket.gone delete",
      "roots/r03 aws_db_instance.main delete",
      "roots/r07 aws_lambda_function.worker replace",
      "roots/r08 aws_lambda_function.worker replace",
    ]);
  });

  test("every delete and replace in the document is named, in the summary and in its group, in every format", () => {
    const want = [...doc.summary.deletes, ...doc.summary.replacements].map((d) => `${d.member}: ${d.address}`).sort();
    expect(s.destroys.map((d) => `${d.member}: ${d.address}`).sort()).toEqual(want);
    const grouped = s.groups.flatMap((g) => g.destroys.map((d) => `${d.member}: ${d.address}`));
    expect(grouped.sort()).toEqual(want.filter((w) => !w.startsWith("roots/broken")));
    const text = renderPlanSummaryText(s);
    const md = renderPlanSummaryMarkdown(s);
    for (const w of want) {
      expect(text).toContain(w);
      expect(md).toContain(w);
    }
  });

  test("a destroy makes its unit's group differ from one without it, however alike the rest", () => {
    for (const g of s.groups) {
      const destroying = new Set(g.destroys.map((d) => d.member));
      expect(destroying.size === 0 || destroying.size === g.units.length, g.id).toBe(true);
    }
  });

  test("a failed member is its own line with its reason, never a group member", () => {
    expect(s.failed).toEqual([{ member: "roots/broken", reason: "terraform marked the plan errored" }]);
    expect(s.groups.flatMap((g) => g.units)).not.toContain("roots/broken");
    expect(renderPlanSummaryText(s)).toContain("roots/broken: terraform marked the plan errored");
  });

  test("a hole is named with its member and reason", () => {
    expect(s.holes).toEqual([{ member: "roots/r99", address: "aws_kms_key.k", reason: "access denied" }]);
    expect(renderPlanSummaryMarkdown(s)).toContain("`roots/r99: aws_kms_key.k`: access denied");
  });

  test("validates against the schema", () => {
    expectValid(s);
  });
});

describe("the markdown note", () => {
  // 400 roots in 200 distinct groups of two, one destroy each in the last 20.
  const parts: ChangeSetPart[] = [];
  for (let i = 0; i < 400; i++) {
    const g = Math.floor(i / 2);
    const entries: Parameters<typeof part>[1] = [{ address: `aws_sqs_queue.q${g}`, action: "update", attributes: [{ path: "visibility_timeout_seconds", before: 30, after: 60 + g }] }];
    if (g >= 180) entries.push({ address: `aws_s3_bucket.old${i}`, action: "delete" });
    parts.push(part(`roots/r${String(i).padStart(3, "0")}`, entries));
  }
  const s = groupChangeSet(composeChangeSet(parts));

  test("fits the limit, keeps every destroy, drops whole groups from the end and says what it dropped", () => {
    expect(s.groups).toHaveLength(400 - 180);
    const limit = 8_000;
    const md = renderPlanSummaryMarkdown(s, { limit });
    expect([...md].length).toBeLessThanOrEqual(limit);
    for (const d of s.destroys) expect(md).toContain(d.address);
    const kept = s.groups.filter((g) => md.includes(`#### Group ${g.id}:`));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(s.groups.slice(0, kept.length));
    const cut = s.groups.length - kept.length;
    const units = s.groups.slice(kept.length).reduce((n, g) => n + g.units.length, 0);
    expect(md.trimEnd().split("\n").pop()).toBe(
      `**Truncated:** this note leaves out ${cut} groups (${units} members) to stay within ${limit} characters. \`chant change-set summary\` prints all of it.`,
    );
  });

  test("is whole under GitHub's comment limit when it fits", () => {
    const md = renderPlanSummaryMarkdown(s);
    expect([...md].length).toBeLessThanOrEqual(GITHUB_COMMENT_LIMIT);
    expect(md).not.toContain("**Truncated:**");
  });

  test("cuts destroy lines last, and counts them, when they alone are over the limit", () => {
    const md = renderPlanSummaryMarkdown(s, { limit: 1_000 });
    expect([...md].length).toBeLessThanOrEqual(1_000);
    expect(md).not.toContain("#### Group");
    expect(md).toMatch(/\*\*Truncated:\*\* this note leaves out \d+ destroys or replacements, 220 groups \(400 members\)/);
  });
});

describe("group ids", () => {
  test("are the same for the same change whatever the members are called, and differ for a different change", () => {
    const a = groupChangeSet(composeChangeSet([part("x/acme", [tagsUpdate("aws_iam_role.app", "acme")], { scope: "acme" }), part("x/globex", [tagsUpdate("aws_iam_role.app", "globex")], { scope: "globex" })]));
    const b = groupChangeSet(composeChangeSet([part("y/initech", [tagsUpdate("aws_iam_role.app", "initech")], { scope: "initech" }), part("y/hooli", [tagsUpdate("aws_iam_role.app", "hooli")], { scope: "hooli" })]));
    expect(a.groups).toHaveLength(1);
    expect(b.groups[0].id).toBe(a.groups[0].id);
    const c = groupChangeSet(composeChangeSet([part("x/acme", [{ ...tagsUpdate("aws_iam_role.app", "acme"), attributes: [{ path: "tags", before: { v: "1" }, after: { v: "3" } }] }], { scope: "acme" }), part("x/z", [], { scope: "z" })]));
    expect(c.groups[0].id).not.toBe(a.groups[0].id);
  });
});

describe("addresses", () => {
  test("instance keys come off, quoted ones decoded", () => {
    expect(splitInstanceKeys('module.a["x.y"].aws_instance.b[0]')).toEqual({ bare: "module.a.aws_instance.b", keys: ["x.y", "0"] });
  });

  test("a tofu-address marker escapes keys as choudoufu does", () => {
    expect(escapeMarkerAddress('aws_s3_bucket.logs["a.b"]')).toBe("aws_s3_bucket.logs:a@db");
    expect(escapeMarkerAddress("aws_s3_bucket.logs[3]")).toBe("aws_s3_bucket.logs:3");
    expect(escapeMarkerAddress('aws_s3_bucket.logs["a+b"]')).toBe("aws_s3_bucket.logs:a++b");
    expect(escapeMarkerAddress('aws_s3_bucket.logs["a*b"]')).toBe("aws_s3_bucket.logs:a+00002Ab");
  });
});
