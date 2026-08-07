/**
 * Scaffolding smoke test: the shared reconcile primitive resolves and works.
 * Confirms the @intentius/chant/reconcile dependency + subpath are wired up.
 */

import { describe, it, expect } from "vitest";
import { diffCollection, runReconcile, removalDeltaCap } from "@intentius/chant/reconcile";
import type { ChangeSet } from "@intentius/chant/reconcile";

describe("chant/reconcile is wired up", () => {
  it("exposes the harness primitives", () => {
    expect(typeof diffCollection).toBe("function");
    expect(typeof runReconcile).toBe("function");
    expect(typeof removalDeltaCap).toBe("function");
  });

  it("diffCollection produces a create entry", () => {
    const out: ChangeSet["entries"] = [];
    diffCollection<{ v: number }, { v: number }>({
      resourceType: "thing",
      desired: new Map([["a", { v: 1 }]]),
      live: new Map(),
      compareFields: () => [],
      opts: {},
      out,
    });
    expect(out).toEqual([{ kind: "create", resourceType: "thing", key: "a", after: { v: 1 } }]);
  });
});
