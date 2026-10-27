/**
 * #4552, ruling A: `ci.lockGrain: target | resource | repo` at the top level
 * and on a member, the member's winning.
 */
import { describe, expect, test } from "vitest";
import { parseDeclaration, WorkspaceReadError } from "./declaration";
import { lockGrainOf } from "./ci-lock-grain";

const parse = (doc: unknown) => parseDeclaration(JSON.stringify(doc, null, 2), "chant.workspace.json");
const member = (name: string, ci?: unknown) => ({ name, dir: name, kind: "other", because: "x", ...(ci ? { ci } : {}) });

describe("ci.lockGrain", () => {
  test("reads at both levels, and a member's own wins", () => {
    const d = parse({ name: "acme", schema: 1, ci: { lockGrain: "repo" }, members: [member("net", { lockGrain: "resource" }), member("web")] });
    expect(d.ci?.lockGrain).toBe("repo");
    expect(d.members.find((m) => m.name === "net")?.ciLockGrain).toBe("resource");
    expect(d.members.find((m) => m.name === "web")?.ciLockGrain).toBeNull();
    expect(lockGrainOf(d, "net")).toBe("resource");
    expect(lockGrainOf(d, "web")).toBe("repo");
    expect(lockGrainOf(d, null)).toBe("repo");
  });

  test("absent at both levels, the member takes its lexicon's default", () => {
    const d = parse({ name: "acme", schema: 1, members: [member("net")] });
    expect(lockGrainOf(d, "net")).toBeNull();
  });

  test("a grain outside the three is refused", () => {
    expect(() => parse({ name: "acme", schema: 1, ci: { lockGrain: "stack" }, members: [member("net")] })).toThrow(WorkspaceReadError);
  });
});
