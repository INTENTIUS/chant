import { describe, expect, test } from "vitest";
import { buildChangeSet, renderChangeSet, summarize } from "./change-set";
import type { ResourceMetadata } from "../lexicon";

const meta = (over: Partial<ResourceMetadata> = {}): ResourceMetadata => ({
  type: "Fake::Resource",
  status: "OK",
  ...over,
});

describe("buildChangeSet (#118)", () => {
  test("declared but not live → create", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["bucket"]),
      observedNow: {},
      observedThen: undefined,
    });
    const e = cs.entries.find((x) => x.name === "bucket")!;
    expect(e.action).toBe("create");
    expect(e.evidence).toEqual({ declared: true, inSnapshot: false, live: false });
    expect(e.ownership).toBe("unknown");
  });

  test("declared and live with drift since snapshot → update with deltas", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["queue"]),
      observedNow: { queue: meta({ status: "ACTIVE" }) },
      observedThen: { queue: meta({ status: "CREATING" }) },
    });
    const e = cs.entries.find((x) => x.name === "queue")!;
    expect(e.action).toBe("update");
    expect(e.deltas).toEqual([{ path: "status", oldValue: "CREATING", newValue: "ACTIVE" }]);
  });

  test("declared and live, unchanged → noop", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["queue"]),
      observedNow: { queue: meta({ status: "ACTIVE" }) },
      observedThen: { queue: meta({ status: "ACTIVE" }) },
    });
    expect(cs.entries.find((x) => x.name === "queue")!.action).toBe("noop");
  });

  test("live but undeclared → adopt, never delete (no ownership yet)", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(),
      observedNow: { orphan: meta() },
      observedThen: undefined,
    });
    const e = cs.entries.find((x) => x.name === "orphan")!;
    expect(e.action).toBe("adopt");
    expect(e.ownership).toBe("unknown");
  });

  test("never proposes a delete without ownership data", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["a"]),
      observedNow: { b: meta(), c: meta() }, // two orphans
      observedThen: { b: meta(), c: meta() },
    });
    expect(cs.entries.some((e) => e.action === "delete")).toBe(false);
    expect(cs.entries.filter((e) => e.action === "adopt").map((e) => e.name)).toEqual(["b", "c"]);
  });

  test("only in snapshot (gone now, undeclared) → noop", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(),
      observedNow: {},
      observedThen: { ghost: meta() },
    });
    expect(cs.entries.find((x) => x.name === "ghost")!.action).toBe("noop");
  });

  test("entries are sorted by name", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["z", "a", "m"]),
      observedNow: {},
      observedThen: undefined,
    });
    expect(cs.entries.map((e) => e.name)).toEqual(["a", "m", "z"]);
  });
});

describe("summarize / renderChangeSet", () => {
  const cs = buildChangeSet("prod", {
    declared: new Set(["create-me", "keep-me"]),
    observedNow: { "keep-me": meta(), orphan: meta() },
    observedThen: { "keep-me": meta() },
  });

  test("summarize counts each action", () => {
    const counts = summarize(cs);
    expect(counts.create).toBe(1);
    expect(counts.noop).toBe(1);
    expect(counts.adopt).toBe(1);
    expect(counts.delete).toBe(0);
  });

  test("render shows the env and grouped sections", () => {
    const out = renderChangeSet(cs);
    expect(out).toContain("Plan for prod");
    expect(out).toContain("CREATE:");
    expect(out).toContain("create-me");
    expect(out).toContain("ADOPT:");
    expect(out).toContain("orphan");
  });
});
