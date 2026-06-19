/**
 * Tests for the provider-agnostic reconcile primitive.
 *
 * Pure unit tests over the generic primitives — no provider types, no I/O.
 */

import { describe, expect, test } from "vitest";
import {
  deepEqual,
  diffFields,
  diffCollection,
  summarizeChangeSet,
  renderChangeSet,
  resolveRenames,
  removalDeltaCap,
  runGuardrailChecks,
} from "./reconcile";
import type { ChangeSet, ChangeSetEntry, DiffOptions, GuardrailCheck } from "./reconcile";

const noOpts: DiffOptions = {};

// ---------------------------------------------------------------------------
// deepEqual / diffFields
// ---------------------------------------------------------------------------

describe("deepEqual", () => {
  test("compares primitives and nested structures", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("a", "b")).toBe(false);
    expect(deepEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });
});

describe("diffFields", () => {
  test("compares every key of desired when no key list is given", () => {
    expect(diffFields({ a: 1, b: 2 }, { a: 1, b: 9 })).toEqual([{ field: "b", before: 9, after: 2 }]);
  });

  test("compares only listed keys present in desired", () => {
    expect(diffFields({ a: 1, b: 2 }, { a: 9, b: 9 }, ["a"])).toEqual([{ field: "a", before: 9, after: 1 }]);
  });

  test("ignores listed keys absent from desired (selective-by-omission)", () => {
    expect(diffFields({ a: 1 }, { a: 1, b: 2 }, ["a", "b"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// diffCollection
// ---------------------------------------------------------------------------

interface D {
  name: string;
  v?: number;
}
interface L {
  name: string;
  v?: number;
}

function runCollection(desired: D[], live: L[], opts: DiffOptions = noOpts): ChangeSetEntry[] {
  const out: ChangeSetEntry[] = [];
  diffCollection<D, L>({
    resourceType: "thing",
    keyPrefix: "p/",
    desired: new Map(desired.map((d) => [d.name, d])),
    live: new Map(live.map((l) => [l.name, l])),
    compareFields: (d, l) => (d.v !== l.v ? [{ field: "v", before: l.v, after: d.v }] : []),
    opts,
    out,
  });
  return out;
}

describe("diffCollection", () => {
  test("creates entries for desired-not-live (with key prefix)", () => {
    const out = runCollection([{ name: "a", v: 1 }], []);
    expect(out).toEqual([{ kind: "create", resourceType: "thing", key: "p/a", after: { name: "a", v: 1 } }]);
  });

  test("updates when compareFields reports differences", () => {
    const out = runCollection([{ name: "a", v: 2 }], [{ name: "a", v: 1 }]);
    expect(out[0]!.kind).toBe("update");
    expect(out[0]!.fields).toEqual([{ field: "v", before: 1, after: 2 }]);
  });

  test("emits no entry when live matches desired", () => {
    expect(runCollection([{ name: "a", v: 1 }], [{ name: "a", v: 1 }])).toEqual([]);
  });

  test("only deletes live-not-desired when ownership-gated", () => {
    const live = [
      { name: "a", v: 1 },
      { name: "stray", v: 9 },
    ];
    expect(runCollection([{ name: "a", v: 1 }], live)).toEqual([]); // no predicate
    const owned = runCollection([{ name: "a", v: 1 }], live, { isOwned: (_t, k) => k === "p/stray" });
    expect(owned).toEqual([
      { kind: "delete", resourceType: "thing", key: "p/stray", before: { name: "stray", v: 9 } },
    ]);
  });

  test("honours createAfter / updateAfter mappers", () => {
    const out: ChangeSetEntry[] = [];
    diffCollection<D, L>({
      resourceType: "thing",
      desired: new Map([["a", { name: "a", v: 5 }]]),
      live: new Map(),
      compareFields: () => [],
      createAfter: (key, d) => ({ normalized: key, v: d.v }),
      opts: noOpts,
      out,
    });
    expect(out[0]!.after).toEqual({ normalized: "a", v: 5 });
  });
});

// ---------------------------------------------------------------------------
// summarize / render
// ---------------------------------------------------------------------------

describe("summarizeChangeSet / renderChangeSet", () => {
  const cs: ChangeSet = {
    org: "acme",
    entries: [
      { kind: "create", resourceType: "thing", key: "a" },
      { kind: "update", resourceType: "thing", key: "b", fields: [{ field: "v", before: 1, after: 2 }] },
      { kind: "delete", resourceType: "thing", key: "c" },
    ],
  };

  test("counts entries by kind", () => {
    expect(summarizeChangeSet(cs)).toEqual({ create: 1, update: 1, delete: 1 });
  });

  test("renders a readable plan with the scope id and field changes", () => {
    const out = renderChangeSet(cs);
    expect(out).toContain("Plan for acme: 1 to create, 1 to update, 1 to delete");
    expect(out).toContain("[thing] b");
    expect(out).toContain("v: 1 → 2");
  });

  test("renders 'No changes.' for an empty set", () => {
    expect(renderChangeSet({ org: "acme", entries: [] })).toContain("No changes.");
  });
});

// ---------------------------------------------------------------------------
// Guardrail framework
// ---------------------------------------------------------------------------

describe("resolveRenames", () => {
  test("collapses delete(previously)+create(key) into one update", () => {
    const cs: ChangeSet = {
      org: "acme",
      entries: [
        { kind: "delete", resourceType: "team", key: "old", before: { slug: "old" } },
        { kind: "create", resourceType: "team", key: "new", after: { previously: "old" } },
      ],
    };
    const resolved = resolveRenames(cs);
    expect(resolved.entries.some((e) => e.kind === "delete")).toBe(false);
    const update = resolved.entries.find((e) => e.kind === "update")!;
    expect(update.key).toBe("new");
    expect(update.before).toEqual({ slug: "old" });
  });

  test("is a no-op without a matching previously alias", () => {
    const cs: ChangeSet = { org: "acme", entries: [{ kind: "delete", resourceType: "team", key: "old" }] };
    expect(resolveRenames(cs)).toBe(cs);
  });
});

describe("removalDeltaCap", () => {
  test("trips when deletes exceed the fraction of pre-existing entries", () => {
    const cs: ChangeSet = {
      org: "acme",
      entries: Array.from({ length: 4 }, (_, i) => ({
        kind: "delete" as const,
        resourceType: "x",
        key: `k${i}`,
      })),
    };
    expect(removalDeltaCap(cs)!.guardrail).toBe("removalDeltaCap");
  });

  test("excludes creates from the denominator and passes under the cap", () => {
    const cs: ChangeSet = {
      org: "acme",
      entries: [
        { kind: "delete", resourceType: "x", key: "d" },
        { kind: "update", resourceType: "x", key: "u1" },
        { kind: "update", resourceType: "x", key: "u2" },
        { kind: "update", resourceType: "x", key: "u3" },
        { kind: "create", resourceType: "x", key: "c" },
      ],
    };
    expect(removalDeltaCap(cs)).toBeNull(); // 1/4 = 25%, not > 25%
  });
});

describe("runGuardrailChecks", () => {
  test("resolves renames once and aggregates failing checks", () => {
    const cs: ChangeSet = {
      org: "acme",
      entries: [
        { kind: "delete", resourceType: "x", key: "a" },
        { kind: "delete", resourceType: "x", key: "b" },
      ],
    };
    const failing: GuardrailCheck = (resolved) => removalDeltaCap(resolved);
    const passing: GuardrailCheck = () => null;
    const result = runGuardrailChecks(cs, [failing, passing]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toHaveLength(1);
  });

  test("returns ok when every check passes", () => {
    const cs: ChangeSet = { org: "acme", entries: [{ kind: "create", resourceType: "x", key: "a" }] };
    expect(runGuardrailChecks(cs, [() => null])).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Reconcile runner (fake provider — proves provider-agnosticism)
// ---------------------------------------------------------------------------

import { runReconcile, BudgetExhaustedError } from "./reconcile";
import type { Cycle } from "./reconcile";

interface FakeClient {
  calls: string[];
}
interface FakeConfig {
  create?: number;
}
type FakeLive = Record<string, never>;

function fakeCycle(
  name: string,
  over: Partial<Cycle<FakeClient, FakeConfig, FakeLive>> = {},
): Cycle<FakeClient, FakeConfig, FakeLive> {
  return {
    name,
    async fetchLive(client, scopeId, _scope, budget) {
      budget.use(1);
      client.calls.push(`fetch:${name}@${scopeId}`);
      return {};
    },
    buildDesired(config) {
      return config;
    },
    async apply(client, entry, _scopeId, _scope, budget) {
      budget.use(1);
      client.calls.push(`apply:${entry.key}`);
    },
    ...over,
  };
}

// Injected diff: emit N create entries from config.create.
const fakeDiff = (scopeId: string, desired: FakeConfig): ChangeSet => ({
  org: scopeId,
  entries: Array.from({ length: desired.create ?? 0 }, (_, i) => ({
    kind: "create" as const,
    resourceType: "thing",
    key: `k${i}`,
  })),
});

describe("runReconcile (generic)", () => {
  test("dry-run reports the plan and mutates nothing", async () => {
    const client: FakeClient = { calls: [] };
    const result = await runReconcile<FakeClient, FakeConfig, FakeLive>({
      client,
      scopes: { acme: { create: 3 } },
      cycles: [fakeCycle("c1")],
      diff: fakeDiff,
      mode: "dry-run",
    });
    expect(result.mode).toBe("dry-run");
    expect(result.completed).toBe(true);
    expect(result.cycles[0]!.counts.create).toBe(3);
    expect(result.cycles[0]!.applied).toHaveLength(0);
    expect(client.calls.filter((c) => c.startsWith("apply:"))).toHaveLength(0);
  });

  test("apply applies each entry across multiple scopes", async () => {
    const client: FakeClient = { calls: [] };
    const result = await runReconcile<FakeClient, FakeConfig, FakeLive>({
      client,
      scopes: { acme: { create: 2 }, beta: { create: 1 } },
      cycles: [fakeCycle("c1")],
      diff: fakeDiff,
      mode: "apply",
    });
    expect(result.completed).toBe(true);
    expect(result.cycles.flatMap((c) => c.applied)).toHaveLength(3);
    expect(client.calls.filter((c) => c.startsWith("apply:"))).toHaveLength(3);
  });

  test("guardrails block the apply unless overridden", async () => {
    const client: FakeClient = { calls: [] };
    const opts = {
      client,
      scopes: { acme: { create: 1 } },
      cycles: [fakeCycle("c1")],
      diff: fakeDiff,
      mode: "apply" as const,
      guardrails: () => ({ ok: false as const, diagnostics: [{ guardrail: "x", message: "no" }] }),
    };
    const blocked = await runReconcile<FakeClient, FakeConfig, FakeLive>(opts);
    expect(blocked.cycles[0]!.guardrailBlocked).toBe(true);
    expect(blocked.cycles[0]!.applied).toHaveLength(0);

    const overridden = await runReconcile<FakeClient, FakeConfig, FakeLive>({ ...opts, allowGuardrailOverride: true });
    expect(overridden.cycles[0]!.guardrailBlocked).toBe(false);
    expect(overridden.cycles[0]!.applied).toHaveLength(1);
  });

  test("records deferred work when the budget is exhausted", async () => {
    const client: FakeClient = { calls: [] };
    const result = await runReconcile<FakeClient, FakeConfig, FakeLive>({
      client,
      scopes: { acme: { create: 0 }, beta: { create: 0 } },
      cycles: [fakeCycle("c1"), fakeCycle("c2")],
      diff: fakeDiff,
      requestBudget: 1, // only the first fetchLive fits
    });
    expect(result.completed).toBe(false);
    expect(result.deferred.skippedCycles.length).toBeGreaterThan(0);
  });

  test("an errored fetchLive is recorded and the run continues", async () => {
    const client: FakeClient = { calls: [] };
    const boom = fakeCycle("boom", {
      async fetchLive() {
        throw new Error("kaboom");
      },
    });
    const result = await runReconcile<FakeClient, FakeConfig, FakeLive>({
      client,
      scopes: { acme: { create: 1 } },
      cycles: [boom, fakeCycle("ok")],
      diff: fakeDiff,
    });
    expect(result.errored).toHaveLength(1);
    expect(result.errored[0]!.name).toBe("boom");
    expect(result.cycles.some((c) => c.name === "ok")).toBe(true); // ran past the error
  });

  test("a budget-exhausted throw mid-fetch is deferred, not errored", async () => {
    const client: FakeClient = { calls: [] };
    const greedy = fakeCycle("greedy", {
      async fetchLive(_c, _s, _scope, budget) {
        budget.use(1);
        throw new BudgetExhaustedError();
      },
    });
    const result = await runReconcile<FakeClient, FakeConfig, FakeLive>({
      client,
      scopes: { acme: { create: 0 } },
      cycles: [greedy],
      diff: fakeDiff,
      requestBudget: 5,
    });
    expect(result.errored).toHaveLength(0);
    expect(result.deferred.skippedCycles).toContain("greedy@acme");
  });
});
