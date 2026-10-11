/**
 * #2815 — a work item id has to be a ref path segment git accepts. The cases
 * are checked against `git check-ref-format` itself, in every ref the id lands in.
 */
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { isWorkItemId, workItemIdProblem } from "./work-item-id";

function gitAccepts(ref: string): boolean {
  return spawnSync("git", ["check-ref-format", ref]).status === 0;
}

const REF_SHAPES = [
  (id: string) => `refs/chant/lease/work/${id}`,
  (id: string) => `refs/chant/lease/_members/api/work/${id}`,
  (id: string) => `refs/chant/kept/api/${id}/0123abcd`,
  (id: string) => `refs/heads/chant/work/api/${id}`,
];

const ACCEPTED = ["W-001", "upgrade-1", "a", "0", "a.b", "a_b", "v1.2.3", "x.lock2", "lock", "a.lockb", "A".repeat(100)];
const REFUSED = [
  "upgrade-.",
  ".",
  "x.",
  "x.lock",
  "x.LOCK",
  "x.Lock",
  "a..b",
  "..",
  ".hidden",
  "-lead",
  "_lead",
  "a/b",
  "a b",
  "a~b",
  "a^b",
  "a:b",
  "a?b",
  "a*b",
  "a[b",
  "a\\b",
  "a@{b",
  "@",
  "",
  "a\tb",
  "A".repeat(101),
];

describe("work item id (#2815)", () => {
  test.each(ACCEPTED)("%s keys a lease, and git takes it in every ref it lands in", (id) => {
    expect(workItemIdProblem(id)).toBeUndefined();
    expect(isWorkItemId(id)).toBe(true);
    for (const shape of REF_SHAPES) expect(gitAccepts(shape(id)), shape(id)).toBe(true);
  });

  test.each(REFUSED)("%j is refused", (id) => {
    expect(workItemIdProblem(id)).toMatch(/can't key a work lease/);
    expect(isWorkItemId(id)).toBe(false);
  });

  test("everything git refuses in the lease ref is refused here", () => {
    for (const id of REFUSED.filter((i) => i !== "" && !i.includes("\t") && i.length <= 100)) {
      if (!gitAccepts(`refs/chant/lease/work/${id}`)) expect(isWorkItemId(id), id).toBe(false);
    }
  });

  test("a non-string is refused", () => {
    expect(workItemIdProblem(undefined)).toMatch(/not a string/);
    expect(isWorkItemId(42)).toBe(false);
  });
});
