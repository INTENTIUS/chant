/**
 * The index is never load-bearing (#4519, rule 1).
 *
 * Every snapshot and every other index is derived and safe to lose: removing
 * the store costs history and the cost of observing again, never a decision.
 * Two checks hold that:
 *
 * 1. Behaviour. `buildChangeSet`, which `lifecycle plan` feeds from the store
 *    (`observedThen`), proposes the same create, delete, adopt, runtime and
 *    unobserved entries, with the same ownership, whether the last snapshot is
 *    there, absent (store `none`), or says something else entirely. The only
 *    thing a snapshot may move is evidence: an `update` row's deltas are drift
 *    since the last read, and with no last read there is none to show.
 *    A BREAK that lets the snapshot decide a delete is caught by the same
 *    check, which the second test proves.
 * 2. Imports. The modules that decide what to mutate (the change set, the
 *    unobserved gate, teardown, apply, the gate and its decision) do not load
 *    the store, the snapshot writer or the replay, so they cannot read an index.
 */
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChangeSet, type ChangeSet } from "./change-set";
import { createSnapshotStore } from "./snapshot-store";
import { fakeSnapshotStore } from "./snapshot-store-fake";
import type { DiffLiveInput } from "./live-diff";
import type { ResourceMetadata } from "../lexicon";
import type { SnapshotStore } from "./snapshot-store";

const meta = (over: Partial<ResourceMetadata> = {}): ResourceMetadata => ({ type: "Fake::Resource", status: "OK", ...over });

type Build = (env: string, input: DiffLiveInput) => ChangeSet;

/** The live side of each case. The snapshot side is varied below. */
const cases: Array<{ name: string; input: Omit<DiffLiveInput, "observedThen"> }> = [
  {
    name: "declared and live, declared and absent, owned orphan, foreign orphan",
    input: {
      declared: new Set(["kept", "missing"]),
      observedNow: {
        kept: meta({ ownership: "owned" }),
        orphanOwned: meta({ ownership: "owned" }),
        orphanForeign: meta({ ownership: "foreign" }),
        orphanUnknown: meta(),
      },
    },
  },
  {
    name: "a runtime child and an unobserved declaration",
    input: {
      declared: new Set(["owner", "hole"]),
      observedNow: {
        owner: meta({ ownership: "owned" }),
        child: meta({ ownerChain: { root: "declared", entity: "owner" } } as Partial<ResourceMetadata>),
      },
      unobserved: { hole: { type: "Fake::Resource", reason: "no-credentials" } },
    },
  },
];

/** Snapshots that disagree with the live read in every way a snapshot can. */
const snapshotsFor = (input: Omit<DiffLiveInput, "observedThen">): Array<Record<string, ResourceMetadata> | undefined> => {
  const names = [...new Set([...input.declared, ...Object.keys(input.observedNow), "gone"])];
  return [
    undefined,
    {},
    Object.fromEntries(names.map((n) => [n, meta({ ownership: "owned", status: "STALE" })])),
    Object.fromEntries(names.map((n) => [n, meta({ ownership: "foreign", status: "OTHER", physicalId: `old-${n}` })])),
  ];
};

const DECISIONS = new Set(["create", "delete", "adopt", "runtime", "unobserved", "effect"]);

/**
 * Every way `build` lets a snapshot change a decision, as text, empty when
 * none does. A name only the snapshot knows is never a decision.
 */
function loadBearing(build: Build): string[] {
  const found: string[] = [];
  for (const c of cases) {
    const without = build("prod", { ...c.input, observedThen: undefined });
    const decided = new Map(without.entries.map((e) => [e.name, e]));
    for (const then of snapshotsFor(c.input)) {
      const withSnap = build("prod", { ...c.input, observedThen: then });
      for (const e of withSnap.entries) {
        const base = decided.get(e.name);
        if (!base) {
          if (e.action !== "noop") found.push(`${c.name}: ${e.name} exists only in the snapshot and became ${e.action}`);
          continue;
        }
        if (e.ownership !== base.ownership) found.push(`${c.name}: ${e.name} ownership ${base.ownership} -> ${e.ownership}`);
        const decisionMoved = (DECISIONS.has(e.action) || DECISIONS.has(base.action)) && e.action !== base.action;
        if (decisionMoved) found.push(`${c.name}: ${e.name} ${base.action} -> ${e.action}`);
        // Drift since the last read is the one thing a snapshot adds, and only between update and noop.
        if (!decisionMoved && e.action !== base.action && !(base.action === "noop" && e.action === "update")) {
          found.push(`${c.name}: ${e.name} ${base.action} -> ${e.action}`);
        }
      }
    }
  }
  return found;
}

describe("the index is never load-bearing", () => {
  test("no snapshot, an empty one or a contradicting one changes a decision", () => {
    expect(loadBearing(buildChangeSet)).toEqual([]);
  });

  test("a BREAK that lets the snapshot decide a delete is caught", () => {
    // The break: an undeclared resource the last snapshot called owned is deleted.
    const broken: Build = (env, input) => {
      const cs = buildChangeSet(env, input);
      return {
        ...cs,
        entries: cs.entries.map((e) =>
          e.action === "adopt" && input.observedThen?.[e.name]?.ownership === "owned" ? { ...e, action: "delete" as const, ownership: "owned" as const } : e,
        ),
      };
    };
    expect(loadBearing(broken).some((f) => f.includes("adopt -> delete"))).toBe(true);
  });

  test("lifecycle plan's read through the store: store none and a populated store decide alike", async () => {
    const input = cases[0].input;
    const populated: SnapshotStore = fakeSnapshotStore({
      readLatest: async () => JSON.stringify({ resources: snapshotsFor(input)[2] }),
    });
    const none = createSnapshotStore({ store: "none" });
    // What runLifecyclePlan does with the store's answer.
    const plan = async (store: SnapshotStore) => {
      const content = await store.readLatest("prod", "fake");
      const observedThen = content ? (JSON.parse(content) as { resources: Record<string, ResourceMetadata> }).resources : undefined;
      return buildChangeSet("prod", { ...input, observedThen });
    };
    const decisions = (cs: ChangeSet) => cs.entries.filter((e) => DECISIONS.has(e.action)).map((e) => `${e.name}:${e.action}:${e.ownership}`);
    expect(decisions(await plan(populated))).toEqual(decisions(await plan(none)));
  });
});

describe("the modules that decide what to mutate never load the index store", () => {
  const SRC = fileURLToPath(new URL("..", import.meta.url));
  const FORBIDDEN = /lifecycle\/(snapshot-store|snapshot-store-s3|snapshot|replay)\.ts$/;
  const DECIDERS = [
    "lifecycle/change-set.ts",
    "lifecycle/unobserved-gate.ts",
    "lifecycle/teardown.ts",
    "lifecycle/green-apply.ts",
    "apply.ts",
    "op/gate.ts",
    "gate-decision.ts",
  ];
  // Runtime imports only: `import type`, `export type` and `import("...")` in a type position load nothing.
  const STATIC = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^;]*?from\s+["'](\.[^"']+)["']/g;
  const DYNAMIC = /await\s+import\(\s*["'](\.[^"']+)["']\s*\)/g;

  function resolveSpec(from: string, spec: string): string | null {
    const base = resolve(dirname(from), spec);
    for (const c of [base, `${base}.ts`, join(base, "index.ts"), base.replace(/\.js$/, ".ts")]) {
      if (c.endsWith(".ts") && existsSync(c)) return c;
    }
    return null;
  }

  test.each(DECIDERS)("%s", (entry) => {
    const start = join(SRC, entry);
    const parent = new Map<string, string | null>([[start, null]]);
    const queue = [start];
    while (queue.length > 0) {
      const file = queue.shift()!;
      const text = readFileSync(file, "utf8");
      for (const m of [...text.matchAll(STATIC), ...text.matchAll(DYNAMIC)]) {
        const target = resolveSpec(file, m[1]);
        if (target && !parent.has(target)) {
          parent.set(target, file);
          queue.push(target);
        }
      }
    }
    const reached = [...parent.keys()].filter((f) => FORBIDDEN.test(f)).map((f) => {
      const chain: string[] = [];
      for (let c: string | null | undefined = f; c; c = parent.get(c)) chain.push(relative(SRC, c));
      return chain.reverse().join(" -> ");
    });
    expect(reached).toEqual([]);
  });
});
