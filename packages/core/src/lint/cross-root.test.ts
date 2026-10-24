import { describe, test, expect } from "vitest";
import {
  runPostSynthChecks,
  runCrossRootChecks,
  createCrossRootContext,
  isPostSynthCheck,
  isCrossRootCheck,
  type CrossRootCheck,
  type CrossRootInput,
  type PostSynthCheck,
} from "./post-synth";

function buildResult(outputs: Record<string, string> = {}, entities: Record<string, unknown> = {}) {
  const out = new Map(Object.entries(outputs));
  return {
    outputs: out,
    entities: new Map(Object.entries(entities)) as Map<string, never>,
    warnings: [] as string[],
    errors: [] as Array<{ message: string; name: string }>,
    sourceFileCount: 0,
  };
}

const secretRoot: CrossRootInput = {
  root: "workloads",
  buildResult: buildResult({ k8s: "kind: Secret\nmetadata:\n  name: db\n" }, { dbSecret: {} }),
};
const fluxRoot: CrossRootInput = {
  root: "flux",
  dir: "/repo/flux",
  buildResult: buildResult({ k8s: "kind: Kustomization\nmetadata:\n  name: apps\n---\nkind: GitRepository\n" }),
};

const kindsAcross: CrossRootCheck = {
  id: "XR001",
  description: "records kinds across roots",
  scope: "cross-root",
  check(ctx) {
    return ctx.docs.map((d) => ({
      checkId: "XR001",
      severity: "info" as const,
      message: String((d.value as { kind?: string }).kind),
      root: d.root,
    }));
  },
};

describe("cross-root post-synth checks (chant #1939)", () => {
  test("a per-build run never calls a cross-root check", () => {
    let called = false;
    const xr = { ...kindsAcross, check: () => { called = true; return []; } };
    const diags = runPostSynthChecks([xr as unknown as PostSynthCheck], buildResult());
    expect(diags).toEqual([]);
    expect(called).toBe(false);
  });

  test("guards keep the two kinds apart", () => {
    const plain: PostSynthCheck = { id: "P", description: "p", check: () => [] };
    expect(isPostSynthCheck(kindsAcross)).toBe(false);
    expect(isCrossRootCheck(kindsAcross)).toBe(true);
    expect(isPostSynthCheck(plain)).toBe(true);
    expect(isCrossRootCheck(plain)).toBe(false);
  });

  test("docs are the union across roots, tagged by root", () => {
    const diags = runCrossRootChecks([kindsAcross], [secretRoot, fluxRoot]);
    expect(diags.map((d) => `${d.root}:${d.message}`)).toEqual([
      "workloads:Secret",
      "flux:Kustomization",
      "flux:GitRepository",
    ]);
  });

  test("a cross-root check can see that the other half lives in another root", () => {
    const needsDecryption: CrossRootCheck = {
      id: "XR002",
      description: "a Secret needs a Kustomization in some root",
      scope: "cross-root",
      check(ctx) {
        const hasKs = ctx.docs.some((d) => (d.value as { kind?: string }).kind === "Kustomization");
        return ctx.docs
          .filter((d) => (d.value as { kind?: string }).kind === "Secret" && !hasKs)
          .map((d) => ({ checkId: "XR002", severity: "warning" as const, message: "no Kustomization in any root", root: d.root }));
      },
    };
    expect(runCrossRootChecks([needsDecryption], [secretRoot, fluxRoot])).toEqual([]);
    expect(runCrossRootChecks([needsDecryption], [secretRoot])).toEqual([
      { checkId: "XR002", severity: "warning", message: "no Kustomization in any root", root: "workloads" },
    ]);
  });

  test("roots stay apart and each is a PostSynthContext", () => {
    const ctx = createCrossRootContext([secretRoot, fluxRoot], { env: "prod" });
    expect(ctx.roots.map((r) => r.root)).toEqual(["workloads", "flux"]);
    expect(ctx.root("flux")?.dir).toBe("/repo/flux");
    expect(ctx.root("flux")?.projectDir).toBe("/repo/flux");
    expect(ctx.root("flux")?.docs).toHaveLength(2);
    expect(ctx.root("workloads")?.env).toBe("prod");
    expect(ctx.root("missing")).toBeUndefined();
    expect(ctx.entities).toEqual([{ root: "workloads", name: "dbSecret", entity: {} }]);
    expect(ctx.env).toBe("prod");
  });

  test("the union is parsed lazily, once", () => {
    const ctx = createCrossRootContext([secretRoot, fluxRoot]);
    expect(ctx.docs).toBe(ctx.docs);
    expect(ctx.entities).toBe(ctx.entities);
  });

  test("plain checks in the list are skipped, and nothing is built when none is cross-root", () => {
    let called = false;
    const plain: PostSynthCheck = { id: "P", description: "p", check: () => { called = true; return []; } };
    // Duplicate root names would throw if a context were built.
    expect(runCrossRootChecks([plain], [secretRoot, secretRoot])).toEqual([]);
    expect(called).toBe(false);
  });

  test("root names must be unique and non-empty", () => {
    expect(() => createCrossRootContext([secretRoot, secretRoot])).toThrow(/appears twice/);
    expect(() => createCrossRootContext([{ ...secretRoot, root: "" }])).toThrow(/needs a name/);
  });
});
