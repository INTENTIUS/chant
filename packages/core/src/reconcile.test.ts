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

  test("returns the live entry count for managedCount accumulation (#2067)", () => {
    const out: ChangeSetEntry[] = [];
    const count = diffCollection<D, L>({
      resourceType: "thing",
      desired: new Map([["a", { name: "a", v: 1 }]]),
      live: new Map([
        ["a", { name: "a", v: 1 }],
        ["b", { name: "b", v: 2 }],
        ["c", { name: "c", v: 3 }],
      ]),
      compareFields: () => [],
      opts: noOpts,
      out,
    });
    expect(count).toBe(3);
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

  test("preserves managedCount and managedCounts on the resolved set", () => {
    const cs: ChangeSet = {
      org: "acme",
      managedCount: 7,
      managedCounts: { team: 4, member: 3 },
      entries: [
        { kind: "delete", resourceType: "team", key: "old", before: { slug: "old" } },
        { kind: "create", resourceType: "team", key: "new", after: { previously: "old" } },
      ],
    };
    const resolved = resolveRenames(cs);
    expect(resolved.managedCount).toBe(7);
    expect(resolved.managedCounts).toEqual({ team: 4, member: 3 });
  });

  test("only matches previously within the same resourceType", () => {
    // A team create claiming previously "old" must NOT swallow a member
    // delete that happens to share the key — that would hide a real delete
    // from guardrail counting.
    const cs: ChangeSet = {
      org: "acme",
      entries: [
        { kind: "delete", resourceType: "member", key: "old", before: { login: "old" } },
        { kind: "create", resourceType: "team", key: "new", after: { previously: "old" } },
      ],
    };
    const resolved = resolveRenames(cs);
    expect(resolved).toBe(cs); // untouched: no same-type match exists
    expect(resolved.entries.filter((e) => e.kind === "delete")).toHaveLength(1);

    // With a same-type delete alongside the cross-type collision, exactly
    // the team delete collapses; the member delete survives.
    const both: ChangeSet = {
      org: "acme",
      entries: [
        { kind: "delete", resourceType: "member", key: "old", before: { login: "old" } },
        { kind: "delete", resourceType: "team", key: "old", before: { slug: "old" } },
        { kind: "create", resourceType: "team", key: "new", after: { previously: "old" } },
      ],
    };
    const bothResolved = resolveRenames(both);
    expect(bothResolved.entries.filter((e) => e.kind === "delete")).toEqual([
      { kind: "delete", resourceType: "member", key: "old", before: { login: "old" } },
    ]);
    expect(bothResolved.entries.find((e) => e.kind === "update")!.before).toEqual({ slug: "old" });
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

  // Live-denominator mode (#2067) — the warden reference cases.

  test("one stale delete of 10 live managed entries passes at the default cap", () => {
    const cs: ChangeSet = {
      org: "acme",
      entries: [{ kind: "delete", resourceType: "x", key: "stale" }],
    };
    // Plan-relative this is 1/1 = 100% and trips; against the live count it
    // is 1/10 = 10% and passes — the routine converged-cycle cleanup.
    expect(removalDeltaCap(cs)).not.toBeNull();
    expect(removalDeltaCap(cs, { managedTotal: 10 })).toBeNull();
  });

  test("4 deletes of 10 live managed entries blocks, with the live-mode message", () => {
    const cs: ChangeSet = {
      org: "acme",
      entries: Array.from({ length: 4 }, (_, i) => ({
        kind: "delete" as const,
        resourceType: "x",
        key: `k${i}`,
      })),
    };
    const d = removalDeltaCap(cs, { managedTotal: 10 })!;
    expect(d.guardrail).toBe("removalDeltaCap");
    expect(d.message).toContain("4 of 10 live managed entries (40%)");
  });

  test("reads changeSet.managedCount when opts.managedTotal is absent", () => {
    const cs: ChangeSet = {
      org: "acme",
      managedCount: 10,
      entries: [{ kind: "delete", resourceType: "x", key: "stale" }],
    };
    expect(removalDeltaCap(cs)).toBeNull(); // 1/10 via the change set's own count
    // An explicit managedTotal wins over the change set's count.
    expect(removalDeltaCap({ ...cs, managedCount: 2 }, { managedTotal: 10 })).toBeNull();
  });

  test("without managed info the diagnostic deep-equals the plan-relative one", () => {
    const cs: ChangeSet = {
      org: "acme",
      entries: [
        { kind: "delete", resourceType: "x", key: "a" },
        { kind: "delete", resourceType: "x", key: "b" },
      ],
    };
    const expected = {
      guardrail: "removalDeltaCap",
      message:
        "2 of 2 managed entries (100%) would be deleted, exceeding the 25% threshold. " +
        "Check for typos in config or raise maxFraction to proceed.",
    };
    expect(removalDeltaCap(cs)).toEqual(expected);
    // A zero live count means "no live info" — it never divides by zero and
    // never loosens the cap; behavior stays exactly plan-relative.
    expect(removalDeltaCap(cs, { managedTotal: 0 })).toEqual(expected);
  });

  test("a changeSet with only the legacy managedCount deep-equals the 0.55.0 behavior", () => {
    const entries = Array.from({ length: 4 }, (_, i) => ({
      kind: "delete" as const,
      resourceType: "x",
      key: `k${i}`,
    }));
    expect(removalDeltaCap({ org: "acme", managedCount: 10, entries })).toEqual({
      guardrail: "removalDeltaCap",
      message:
        "4 of 10 live managed entries (40%) would be deleted, exceeding the 25% threshold. " +
        "Check for typos in config or raise maxFraction to proceed.",
    });
    expect(removalDeltaCap({ org: "acme", managedCount: 20, entries })).toBeNull(); // 4/20
  });

  // Per-resource-type mode — the three-repo review cases. The pooled
  // denominator let live entries of one type dilute a wipe of another.

  test("3 of 4 team deletes blocks at 75% even with 20 live members in another type", () => {
    const cs: ChangeSet = {
      org: "acme",
      managedCounts: { team: 4, member: 20 },
      entries: Array.from({ length: 3 }, (_, i) => ({
        kind: "delete" as const,
        resourceType: "team",
        key: `t${i}`,
      })),
    };
    // Pooled (0.55.0) this read 3/24 = 12.5% and sailed under the default cap.
    expect(removalDeltaCap({ ...cs, managedCounts: undefined, managedCount: 24 })).toBeNull();
    const d = removalDeltaCap(cs)!;
    expect(d.guardrail).toBe("removalDeltaCap");
    expect(d.message).toContain("3 of 4 live team entries (75%) would be deleted");
  });

  test("a full org-secret wipe blocks at 100% regardless of live repo count", () => {
    const cs: ChangeSet = {
      org: "acme",
      managedCounts: { "org-secret": 2, repo: 75 },
      entries: [
        { kind: "delete", resourceType: "org-secret", key: "s1" },
        { kind: "delete", resourceType: "org-secret", key: "s2" },
      ],
    };
    // Pooled this read 2/77 = 2.6% and passed.
    expect(removalDeltaCap({ ...cs, managedCounts: undefined, managedCount: 77 })).toBeNull();
    const d = removalDeltaCap(cs)!;
    expect(d.message).toContain("2 of 2 live org-secret entries (100%) would be deleted");
  });

  test("a type with no live count falls back to its own plan non-creates", () => {
    const cs: ChangeSet = {
      org: "acme",
      managedCounts: { team: 10 },
      entries: [
        { kind: "delete", resourceType: "team", key: "t0" }, // 1/10 live: fine
        { kind: "delete", resourceType: "webhook", key: "w0" },
        { kind: "delete", resourceType: "webhook", key: "w1" },
        { kind: "update", resourceType: "webhook", key: "w2" },
      ],
    };
    // webhook has no live count → plan-relative within the type: 2/3 = 67%.
    const d = removalDeltaCap(cs)!;
    expect(d.message).toContain("2 of 3 planned webhook entries (67%) would be deleted");
    // team creates never pad the webhook denominator, and vice versa.
    expect(d.message).not.toContain("team");
  });

  test("passes when every type stays under the cap, and zero live counts fall back", () => {
    const cs: ChangeSet = {
      org: "acme",
      managedCounts: { team: 10, member: 20 },
      entries: [
        { kind: "delete", resourceType: "team", key: "t0" },
        { kind: "delete", resourceType: "member", key: "m0" },
        { kind: "delete", resourceType: "member", key: "m1" },
      ],
    };
    expect(removalDeltaCap(cs)).toBeNull(); // 1/10 and 2/20

    // A zero live count for a type means "no live info for it" — that type
    // is measured plan-relative (1/1 here), never divided by zero.
    const zero: ChangeSet = {
      org: "acme",
      managedCounts: { team: 0 },
      entries: [{ kind: "delete", resourceType: "team", key: "t0" }],
    };
    expect(removalDeltaCap(zero)!.message).toContain("1 of 1 planned team entries (100%)");
  });

  test("names the worst offender first and lists other tripping types", () => {
    const cs: ChangeSet = {
      org: "acme",
      managedCounts: { "org-secret": 2, team: 4 },
      entries: [
        { kind: "delete", resourceType: "team", key: "t0" },
        { kind: "delete", resourceType: "team", key: "t1" },
        { kind: "delete", resourceType: "team", key: "t2" },
        { kind: "delete", resourceType: "org-secret", key: "s0" },
        { kind: "delete", resourceType: "org-secret", key: "s1" },
      ],
    };
    const d = removalDeltaCap(cs)!;
    // 100% secrets beats 75% teams for the headline; teams are still listed.
    expect(d.message).toMatch(/^2 of 2 live org-secret entries \(100%\) would be deleted/);
    expect(d.message).toContain("Also over the cap: 3 of 4 live team entries (75%)");
  });

  test("opts.managedTotals wins over changeSet counts; per-type wins over pooled", () => {
    const cs: ChangeSet = {
      org: "acme",
      managedCounts: { team: 2 },
      managedCount: 100,
      entries: [{ kind: "delete", resourceType: "team", key: "t0" }],
    };
    // Per-type (2) beats the diluting pooled 100: 1/2 = 50% trips.
    expect(removalDeltaCap(cs)).not.toBeNull();
    // Explicit opts.managedTotals overrides the change set's counts.
    expect(removalDeltaCap(cs, { managedTotals: { team: 10 } })).toBeNull();
  });

  test("maxFraction outside (0,1] throws instead of silently disabling the cap", () => {
    const cs: ChangeSet = {
      org: "acme",
      entries: [{ kind: "delete", resourceType: "x", key: "a" }],
    };
    for (const bad of [Number.NaN, 0, 1.5, -1]) {
      expect(() => removalDeltaCap(cs, { maxFraction: bad })).toThrow(/maxFraction must be in \(0, 1\]/);
    }
    // The bounds themselves: 1 is allowed (nothing short of a full wipe trips)…
    expect(removalDeltaCap(cs, { maxFraction: 1, managedTotal: 2 })).toBeNull();
    // …and the default 0.25 stays valid explicitly.
    expect(removalDeltaCap(cs, { maxFraction: 0.25, managedTotal: 10 })).toBeNull();
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

  test("threads live context to checks that take it (#2067)", () => {
    const cs: ChangeSet = {
      org: "acme",
      entries: [{ kind: "delete", resourceType: "x", key: "stale" }],
    };
    const check: GuardrailCheck = (resolved, ctx) =>
      removalDeltaCap(resolved, { managedTotal: ctx?.managedCount });
    // Without ctx the check falls back to plan-relative and trips (1/1).
    expect(runGuardrailChecks(cs, [check]).ok).toBe(false);
    // With the live count threaded through, 1/10 passes.
    expect(runGuardrailChecks(cs, [check], { managedCount: 10 })).toEqual({ ok: true });
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
