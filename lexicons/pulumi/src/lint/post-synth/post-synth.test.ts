import { afterEach, describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { setLastMemberReport } from "../../workspace-member";
import { postSynthChecks } from "./index";
import { pul001 } from "./pul001";
import { pul002 } from "./pul002";

const ctx = { outputs: new Map(), entities: new Map() } as unknown as PostSynthContext;

afterEach(() => setLastMemberReport(undefined));

describe("pulumi post-synth checks", () => {
  test("the barrel lists both", () => {
    expect(postSynthChecks.map((c) => c.id)).toEqual(["PUL001", "PUL002"]);
  });

  test("both stay silent in a build that read no member", () => {
    setLastMemberReport(undefined);
    expect(pul001.check(ctx)).toEqual([]);
    expect(pul002.check(ctx)).toEqual([]);
  });

  test("PUL001 reports a member read with no export, with the reason", () => {
    setLastMemberReport({ objects: 0, exported: false, reason: "no stack-export.json in the member" });
    const diags = pul001.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("PUL001");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("no stack-export.json in the member");
    expect(diags[0].missing).toEqual({ kind: "stack-export.json", scope: "pulumi member" });
  });

  test("PUL001 is silent for a member that was read", () => {
    setLastMemberReport({ export: "stack-export.json", objects: 3, exported: true });
    expect(pul001.check(ctx)).toEqual([]);
  });

  test("PUL002 reports pending operations and is silent without them", () => {
    setLastMemberReport({ export: "stack-export.json", objects: 3, exported: true, pendingOperations: 2 });
    const diags = pul002.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("PUL002");
    expect(diags[0].message).toContain("2 pending operation(s)");

    setLastMemberReport({ export: "stack-export.json", objects: 3, exported: true });
    expect(pul002.check(ctx)).toEqual([]);
  });
});
