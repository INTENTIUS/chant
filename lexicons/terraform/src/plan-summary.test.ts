/**
 * The grouped plan summary (#3188) over terraform-family change sets.
 *
 * `packages/core/src/__fixtures__/plan-summary/normalization-vectors.json`
 * is the rule table chant and choudoufu both run (the ruling on #3188 and
 * choudoufu#1753). Its root pairs are choudoufu set-plan roots, read here
 * through `choudoufuSetPlanParts` exactly as a real set plan is; its
 * instance pairs are two `resource_changes` of one plan. The table is proved
 * red two ways: a grouper that compares raw changes fails every must-group
 * row, and one that blanks every string fails the must-not rows the file
 * names.
 *
 * `__fixtures__/plan-summary/largeset-n5-bump.json` is choudoufu's real set
 * plan of choudoufu#1750's module bump at N=5 against floci
 * (`internal/live/plansummary/testdata/largeset-n5-bump.json`, choudoufu
 * 8f08b6cbb7). e04 is the planted outlier. Goldens regenerate with
 * `UPDATE_GOLDEN=1`; `packages/core/src/plan-summary.test.ts` validates the
 * JSON one against the schema.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { composeChangeSet } from "@intentius/chant/change-set";
import { groupChangeSet, renderPlanSummaryMarkdown, renderPlanSummaryText } from "@intentius/chant/plan-summary";
import { choudoufuSetPlanParts, terraformChangeSetPart } from "./change-set";

const DIR = join(import.meta.dirname, "__fixtures__", "plan-summary");
const VECTORS = join(import.meta.dirname, "..", "..", "..", "packages", "core", "src", "__fixtures__", "plan-summary", "normalization-vectors.json");

function golden(name: string, text: string): void {
  const path = join(DIR, name);
  if (process.env.UPDATE_GOLDEN) writeFileSync(path, text);
  expect(text).toBe(readFileSync(path, "utf-8"));
}

type Json = Record<string, any>;

interface Pair {
  name: string;
  group: boolean;
  a: Json;
  b: Json;
}

const vectors = JSON.parse(readFileSync(VECTORS, "utf-8")) as {
  format: string;
  rootPairs: Pair[];
  instancePairs: Pair[];
  overEagerFalselyGroups: string[];
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Whether the summary puts two roots of one set plan in one group. */
function rootsGroup(a: Json, b: Json): boolean {
  const doc = composeChangeSet(choudoufuSetPlanParts({ document: { roots: [a, b] } }));
  const s = groupChangeSet(doc);
  return s.failed.length === 0 && s.groups.length === 1;
}

/** Whether the summary puts two instances of one plan in one group. */
function instancesGroup(a: Json, b: Json): boolean {
  const doc = composeChangeSet([terraformChangeSetPart({ member: "root", plan: { format_version: "1.2", resource_changes: [a, b] } })]);
  return groupChangeSet(doc).groups.length === 1;
}

/** Grouping by the raw change set: equal bytes or nothing. */
const naiveRootsGroup = (a: Json, b: Json): boolean => JSON.stringify(a.plan.resource_changes) === JSON.stringify(b.plan.resource_changes);

/** The normalizer this must not be: every string in before and after blanked first. */
function blankStrings(root: Json): Json {
  const blank = (v: unknown): unknown =>
    typeof v === "string" ? "x" : Array.isArray(v) ? v.map(blank) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, e]) => [k, blank(e)])) : v;
  const r = clone(root);
  for (const rc of r.plan.resource_changes) {
    if (rc.change.before) rc.change.before = blank(rc.change.before);
    if (rc.change.after) rc.change.after = blank(rc.change.after);
  }
  return r;
}

describe("the shared normalization vectors", () => {
  test("are the format this test reads, with both kinds of pair", () => {
    expect(vectors.format).toBe("plan-summary-normalization-vectors/1");
    for (const rows of [vectors.rootPairs, vectors.instancePairs]) {
      expect(rows.some((r) => r.group)).toBe(true);
      expect(rows.some((r) => !r.group)).toBe(true);
    }
  });

  test.each(vectors.rootPairs.map((r) => [r.name, r] as const))("roots: %s", (_, row) => {
    expect(rootsGroup(row.a, row.b)).toBe(row.group);
  });

  test.each(vectors.instancePairs.map((r) => [r.name, r] as const))("instances: %s", (_, row) => {
    expect(instancesGroup(row.a, row.b)).toBe(row.group);
  });

  test("red first: a raw hash keeps every must-group pair apart", () => {
    const grouped = vectors.rootPairs.filter((r) => r.group && naiveRootsGroup(r.a, r.b)).map((r) => r.name);
    expect(grouped).toEqual([]);
  });

  test("red first: blanking every string falsely groups exactly the named must-not pairs", () => {
    const falselyGrouped = vectors.rootPairs.filter((r) => !r.group && rootsGroup(blankStrings(r.a), blankStrings(r.b))).map((r) => r.name);
    expect(falselyGrouped.sort()).toEqual([...vectors.overEagerFalselyGroups].sort());
  });
});

describe("choudoufu#1750's module bump at N=5", () => {
  const document = JSON.parse(readFileSync(join(DIR, "largeset-n5-bump.json"), "utf-8")) as Json;
  const doc = composeChangeSet(choudoufuSetPlanParts({ document }));
  const summary = groupChangeSet(doc);

  test("is one group plus the planted outlier, which reads as the group's change plus its extra queue", () => {
    expect(summary.groups.map((g) => g.units)).toEqual([["estates/e01", "estates/e02", "estates/e03", "estates/e05"], ["estates/e04"]]);
    const [base, outlier] = summary.groups;
    expect(outlier.outlier).toBe(true);
    expect(outlier.extends).toBe(base.id);
    expect(outlier.plus?.map((l) => l.line)).toEqual(["~ module.shared.aws_sqs_queue.extra: tags, tags_all"]);
    expect(summary.destroys).toEqual([]);
    expect(summary.failed).toEqual([]);
  });

  test("keeps its group ids when the same change is planned again", () => {
    const again = groupChangeSet(composeChangeSet(choudoufuSetPlanParts({ document: clone(document) }).reverse()));
    expect(again.groups.map((g) => g.id)).toEqual(summary.groups.map((g) => g.id));
  });

  test("renders its goldens", () => {
    golden("largeset-n5.summary.golden.json", JSON.stringify(summary, null, 2) + "\n");
    golden("largeset-n5.summary.golden.txt", renderPlanSummaryText(summary));
    golden("largeset-n5.summary.golden.md", renderPlanSummaryMarkdown(summary));
  });
});

describe("one root's for_each expansion", () => {
  test("groups instances whose changes differ only in their own key, and names each destroy", () => {
    const changes = ["a", "b", "c"].map((k) => ({
      address: `aws_s3_bucket.logs["${k}"]`,
      change: { actions: ["update"], before: { bucket: `logs-${k}`, tags: { Name: `logs-${k}`, v: "1" } }, after: { bucket: `logs-${k}`, tags: { Name: `logs-${k}`, v: "2" } } },
    }));
    changes.push({ address: 'aws_s3_bucket.logs["d"]', change: { actions: ["delete", "create"], before: { bucket: "logs-d", tags: { Name: "logs-d", v: "1" } }, after: { bucket: "logs-d2", tags: { Name: "logs-d", v: "2" } } } });
    const doc = composeChangeSet([terraformChangeSetPart({ member: "root", plan: { format_version: "1.2", resource_changes: changes } })]);
    const s = groupChangeSet(doc);
    expect(s.unit).toBe("instance");
    expect(s.groups.map((g) => [g.resource, g.units])).toEqual([
      ["aws_s3_bucket.logs", ['aws_s3_bucket.logs["a"]', 'aws_s3_bucket.logs["b"]', 'aws_s3_bucket.logs["c"]']],
      ["aws_s3_bucket.logs", ['aws_s3_bucket.logs["d"]']],
    ]);
    expect(s.destroys).toEqual([{ member: "root", address: 'aws_s3_bucket.logs["d"]', type: "aws_s3_bucket", action: "replace" }]);
  });
});
