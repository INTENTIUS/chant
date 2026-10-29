/**
 * #4552: the lock grain, the rule of cover between a stack row and its URN
 * rows (ruling C), and what a pull request locks under ci.locks (ruling D).
 */
import { describe, expect, test } from "vitest";
import {
  anyResourceGrain,
  isLockGrain,
  leaseRowsOf,
  lockRowCover,
  lockRowsConflict,
  lockTargetsOf,
  LockGrainRefusedError,
  objectRowKey,
  resolvePlannedLock,
  sortedLockRows,
  stackRowKey,
  urnRowKey,
  type LockRow,
  type PlannedLock,
} from "./lock-rows";

const URN = "urn:pulumi:dev::site::aws:s3/bucket:Bucket::logs";
const OTHER_STACK = "urn:pulumi:prod::site::aws:s3/bucket:Bucket::logs";

describe("row keys and cover", () => {
  test("the grains", () => {
    expect(isLockGrain("resource")).toBe(true);
    expect(isLockGrain("stack")).toBe(false);
  });

  test("a URN row is covered by its stack's row, and by no other", () => {
    expect(lockRowCover(urnRowKey(URN))).toBe(stackRowKey("site", "dev"));
    expect(lockRowCover(objectRowKey("b-1"))).toBeUndefined();
    expect(lockRowCover("estate e01 aws_s3_bucket.logs")).toBeUndefined();
  });

  test("a stack row conflicts with every URN row of the stack, either way round, and with nothing of another stack", () => {
    expect(lockRowsConflict(stackRowKey("site", "dev"), urnRowKey(URN))).toBe(true);
    expect(lockRowsConflict(urnRowKey(URN), stackRowKey("site", "dev"))).toBe(true);
    expect(lockRowsConflict(stackRowKey("site", "dev"), urnRowKey(OTHER_STACK))).toBe(false);
    expect(lockRowsConflict(urnRowKey(URN), urnRowKey(OTHER_STACK))).toBe(false);
    expect(lockRowsConflict(objectRowKey("b-1"), objectRowKey("b-1"))).toBe(true);
  });

  test("rows sort by key and keep the first of a key", () => {
    const rows = sortedLockRows([
      { key: "b", target: "t", address: "1" },
      { key: "a", target: "t", address: "2" },
      { key: "b", target: "t", address: "3" },
    ]);
    expect(rows).toEqual([
      { key: "a", target: "t", address: "2" },
      { key: "b", target: "t", address: "1" },
    ]);
  });
});

describe("resolvePlannedLock", () => {
  const rows: LockRow[] = [{ key: "estate e01 aws_s3_bucket.logs", target: "net", address: "aws_s3_bucket.logs" }];
  const choudoufu = { kind: "terraform-apply", defaultLockGrain: () => "resource" as const, lockRows: () => rows };
  const terraform = {
    kind: "terraform-apply",
    defaultLockGrain: () => "target" as const,
    lockGrainRefusal: (_input: never, grain: string) => (grain === "resource" ? "Terraform keeps a root's state in one file" : undefined),
    lockRows: () => rows,
  };

  test("the lexicon's default holds when nothing is declared", async () => {
    expect(await resolvePlannedLock(choudoufu, {}, { member: "net" }, null)).toEqual({ grain: "resource", source: "lexicon", rows });
    expect(await resolvePlannedLock(terraform, {}, { member: "net" }, undefined)).toEqual({ grain: "target", source: "lexicon", rows: [] });
    expect(await resolvePlannedLock({ kind: "docker-build" }, {}, { member: "img" }, null)).toEqual({ grain: "target", source: "default", rows: [] });
  });

  test("the declared grain wins over the default, and the step's own over both", async () => {
    expect(await resolvePlannedLock(choudoufu, {}, { member: "net" }, "target")).toEqual({ grain: "target", source: "declared", rows: [] });
    expect(await resolvePlannedLock(choudoufu, { lockGrain: "repo" }, { member: "net" }, "resource")).toEqual({
      grain: "repo",
      source: "step",
      rows: [],
      queue: [{ key: "repo", target: "net", address: "the repository" }],
    });
  });

  test("resource is refused by name where the lexicon refuses it, and where no hook names rows", async () => {
    await expect(resolvePlannedLock(terraform, {}, { member: "net" }, "resource")).rejects.toThrow(LockGrainRefusedError);
    await expect(resolvePlannedLock(terraform, {}, { member: "net" }, "resource")).rejects.toThrow(/Terraform keeps a root's state/);
    await expect(resolvePlannedLock({ kind: "docker-build" }, {}, { member: "img" }, "resource")).rejects.toThrow(/docker-build names no rows/);
  });
});

describe("what a pull request locks", () => {
  const lock = (component: string, grain: PlannedLock["grain"], keys: string[] = []): PlannedLock & { component: string } => ({
    grain,
    source: "lexicon",
    component,
    rows: keys.map((key) => ({ key, target: component, address: key })),
  });

  test("component names when no member is on the resource grain", () => {
    expect(lockTargetsOf(["web", "net"], undefined)).toEqual(["web", "net"]);
    expect(anyResourceGrain({ web: lock("web", "target") })).toBe(false);
  });

  test("row keys for resource members, names for the rest", () => {
    const locks = {
      "site/dev": lock("site", "resource", [urnRowKey(URN), objectRowKey("b-1")]),
      net: lock("net", "target"),
    };
    expect(anyResourceGrain(locks)).toBe(true);
    expect(lockTargetsOf(["net", "site", "docs"], locks)).toEqual(["docs", "net", objectRowKey("b-1"), urnRowKey(URN)].sort());
    expect(leaseRowsOf(locks).map((r) => r.key)).toEqual([objectRowKey("b-1"), urnRowKey(URN)].sort());
  });
});
