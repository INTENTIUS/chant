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
  planSummaryHeadline,
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

describe("provisional members (#3416)", () => {
  // Four roots take the same tag change; two of them were planned before what they read applied.
  const parts = ["r1", "r2", "r3", "r4"].map((m) => part(m, [tagsUpdate(`aws_s3_bucket.b`, m)], m === "r3" || m === "r4" ? { provisional: true } : {}));
  const s = groupChangeSet(composeChangeSet(parts));

  test("group only with each other, after the real plans, and say so", () => {
    expect(s.groups.map((g) => [g.units, g.provisional])).toEqual([
      [["r1", "r2"], undefined],
      [["r3", "r4"], true],
    ]);
    expect(s.groups[0]!.id).not.toBe(s.groups[1]!.id);
    expect(s.groups[1]!.extends).toBeUndefined();
    expectValid(s);
  });

  test("keep the id a group of real plans had before", () => {
    const real = groupChangeSet(composeChangeSet(parts.slice(0, 2)));
    expect(real.groups[0]!.id).toBe(s.groups[0]!.id);
  });

  test("are counted in the headline and marked in text and markdown", () => {
    expect(planSummaryHeadline(s)).toBe("4 members: 2 groups, 1 provisional, 0 destroys or replacements.");
    expect(renderPlanSummaryText(s)).toMatch(/Group [0-9a-f]{12}: 2 members \(provisional\), identical change/);
    expect(renderPlanSummaryMarkdown(s)).toMatch(/Provisional: planned before what it reads applied/);
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

describe("imports, forgets and triggered actions", () => {
  const parts: ChangeSetPart[] = [];
  for (let i = 1; i <= 6; i++) {
    const r = `r${i}`;
    const entries: Parameters<typeof part>[1] = [tagsUpdate("aws_iam_role.app", r)];
    if (i <= 2) entries.push({ address: "aws_s3_bucket.old", action: "forget" });
    if (i === 3) entries.push({ address: "aws_s3_bucket.old", action: "delete" });
    if (i === 4) entries.push({ address: "aws_s3_bucket.adopted", action: "no-op", importing: true });
    if (i === 5) entries.push({ address: "aws_s3_bucket.adopted", action: "update", importing: true, attributes: [{ path: "tags", before: null, after: { v: "1" } }] });
    const p = part(`roots/${r}`, entries, { scope: r });
    if (i === 6) p.sideEffects = [{ address: "action.aws_lambda_invoke.notify", type: "aws_lambda_invoke", trigger: "aws_iam_role.app", event: "after_update" }];
    parts.push(p);
  }
  const doc = composeChangeSet(parts);
  const s = groupChangeSet(doc);

  test("a forget is never counted as a destroy, nor a destroy as a forget", () => {
    expect(s.destroys.map((d) => `${d.member} ${d.address} ${d.action}`)).toEqual(["roots/r3 aws_s3_bucket.old delete"]);
    expect(s.forgets.map((f) => `${f.member} ${f.address}`)).toEqual(["roots/r1 aws_s3_bucket.old", "roots/r2 aws_s3_bucket.old"]);
    expect(s.groups.map((g) => g.units)).toContainEqual(["roots/r1", "roots/r2"]);
    expect(s.groups.find((g) => g.units.includes("roots/r3"))?.units).toEqual(["roots/r3"]);
    expect(s.groups.flatMap((g) => g.destroys).map((d) => d.member)).toEqual(["roots/r3"]);
  });

  test("an import is named, whether it changes anything or not, and splits from the same change without one", () => {
    expect(s.imports.map((i) => `${i.member} ${i.address} ${i.action}`)).toEqual(["roots/r4 aws_s3_bucket.adopted no-op", "roots/r5 aws_s3_bucket.adopted update"]);
    expect(s.groups.find((g) => g.units.includes("roots/r4"))?.units).toEqual(["roots/r4"]);
  });

  test("a triggered action is a side effect, named with what triggers it", () => {
    expect(s.sideEffects).toEqual([{ member: "roots/r6", address: "action.aws_lambda_invoke.notify", type: "aws_lambda_invoke", trigger: "aws_iam_role.app", event: "after_update" }]);
    expect(s.groups.find((g) => g.units.includes("roots/r6"))?.units).toEqual(["roots/r6"]);
  });

  test("the headline and both renderings name each kind apart from destroys", () => {
    expect(planSummaryHeadline(s)).toContain("1 destroy or replacement");
    expect(planSummaryHeadline(s)).toContain("2 forgets");
    expect(planSummaryHeadline(s)).toContain("2 imports");
    expect(planSummaryHeadline(s)).toContain("1 triggered action");
    for (const out of [renderPlanSummaryText(s), renderPlanSummaryMarkdown(s)]) {
      expect(out).toContain("Forgets (2)");
      expect(out).toContain("Imports (2)");
      expect(out).toContain("Triggered actions (1)");
      expect(out).toContain("roots/r1: aws_s3_bucket.old");
      expect(out).toContain("roots/r4: aws_s3_bucket.adopted");
      expect(out).toContain("roots/r6: action.aws_lambda_invoke.notify");
    }
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
