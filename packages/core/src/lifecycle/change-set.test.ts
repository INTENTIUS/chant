import { describe, expect, test } from "vitest";
import { buildChangeSet, renderChangeSet, summarize, gitlabMrReport } from "./change-set";
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
    expect(e.evidence).toEqual({ declared: true, inSnapshot: false, live: false, observed: true });
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

  test("live but undeclared, no ownership data → adopt, never delete", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(),
      observedNow: { orphan: meta() },
      observedThen: undefined,
    });
    const e = cs.entries.find((x) => x.name === "orphan")!;
    expect(e.action).toBe("adopt");
    expect(e.ownership).toBe("unknown");
  });

  test("owned orphan → delete (#121)", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(),
      observedNow: { orphan: meta({ ownership: "owned" }) },
      observedThen: undefined,
    });
    const e = cs.entries.find((x) => x.name === "orphan")!;
    expect(e.action).toBe("delete");
    expect(e.ownership).toBe("owned");
  });

  test("foreign orphan → adopt, never delete (#121)", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(),
      observedNow: { orphan: meta({ ownership: "foreign" }) },
      observedThen: undefined,
    });
    const e = cs.entries.find((x) => x.name === "orphan")!;
    expect(e.action).toBe("adopt");
    expect(e.ownership).toBe("foreign");
  });

  test("snapshot is never load-bearing: ownership/delete ignores observedThen", () => {
    // The same live orphan, once with a rich snapshot and once with none.
    // The delete decision must depend only on the LIVE ownership marker, so the
    // result must be identical regardless of what the snapshot says.
    const withSnapshot = buildChangeSet("prod", {
      declared: new Set(),
      observedNow: { orphan: meta({ ownership: "owned" }) },
      observedThen: { orphan: meta({ ownership: "foreign", status: "STALE" }) },
    });
    const withoutSnapshot = buildChangeSet("prod", {
      declared: new Set(),
      observedNow: { orphan: meta({ ownership: "owned" }) },
      observedThen: undefined,
    });
    const a = withSnapshot.entries.find((x) => x.name === "orphan")!;
    const b = withoutSnapshot.entries.find((x) => x.name === "orphan")!;
    expect(a.action).toBe("delete");
    expect(a.ownership).toBe("owned");
    expect(a.action).toBe(b.action);
    expect(a.ownership).toBe(b.ownership);
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

  // ── Owner-reference chain classification (#1077) ──────────────────────────

  test("undeclared, owner chain reaches a declared entity → runtime, never delete or adopt", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["web"]),
      observedNow: {
        web: meta({ type: "K8s::Apps::Deployment" }),
        "prod/web-abc": meta({ type: "K8s::Core::Pod", ownerChain: { root: "declared", entity: "web" } }),
      },
      observedThen: undefined,
    });
    const e = cs.entries.find((x) => x.name === "prod/web-abc")!;
    expect(e.action).toBe("runtime");
    expect(e.runtimeOwner).toBe("web");
  });

  test("a runtime child that also carries chant's own ownership marker is still `runtime`, never `delete`", () => {
    // Guards the ordering in buildChangeSet: runtimeOwner must be checked
    // before the ownership marker, in case a runtime child ever inherits the
    // marker (e.g. label propagation from its owner's pod template).
    const cs = buildChangeSet("prod", {
      declared: new Set(),
      observedNow: {
        "prod/web-abc": meta({ ownership: "owned", ownerChain: { root: "declared", entity: "web" } }),
      },
      observedThen: undefined,
    });
    const e = cs.entries.find((x) => x.name === "prod/web-abc")!;
    expect(e.action).toBe("runtime");
  });

  test("undeclared, unowned → orphan/adopt, not runtime", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(),
      observedNow: { "prod/standalone": meta({ ownerChain: { root: "unowned" } }) },
      observedThen: undefined,
    });
    const e = cs.entries.find((x) => x.name === "prod/standalone")!;
    expect(e.action).toBe("adopt");
    expect(e.runtimeOwner).toBeUndefined();
  });

  test("undeclared, foreign root → orphan/adopt, not runtime", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(),
      observedNow: { "prod/other": meta({ ownerChain: { root: "foreign" } }) },
      observedThen: undefined,
    });
    expect(cs.entries.find((x) => x.name === "prod/other")!.action).toBe("adopt");
  });

  test("undeclared, unresolved chain (unreadable/cycle/depth) → conservative adopt, not runtime", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(),
      observedNow: { "prod/mystery": meta({ ownerChain: { root: "unknown" } }) },
      observedThen: undefined,
    });
    const e = cs.entries.find((x) => x.name === "prod/mystery")!;
    expect(e.action).toBe("adopt");
    expect(e.runtimeOwner).toBeUndefined();
  });

  test("a lexicon with no owner chain at all is unaffected — undeclared stays adopt/delete as before", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(),
      observedNow: { orphan: meta({ ownership: "owned" }) },
      observedThen: undefined,
    });
    expect(cs.entries.find((x) => x.name === "orphan")!.action).toBe("delete");
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

  test("summarize and render surface the runtime action (#1077)", () => {
    const withRuntime = buildChangeSet("prod", {
      declared: new Set(["web"]),
      observedNow: {
        web: meta({ type: "K8s::Apps::Deployment" }),
        "prod/web-abc": meta({ type: "K8s::Core::Pod", ownerChain: { root: "declared", entity: "web" } }),
      },
      observedThen: undefined,
    });
    expect(summarize(withRuntime).runtime).toBe(1);
    expect(summarize(withRuntime).adopt).toBe(0);
    const out = renderChangeSet(withRuntime);
    expect(out).toContain("RUNTIME");
    expect(out).toContain("prod/web-abc");
    expect(out).toContain("owned by web");
  });
});

describe("gitlabMrReport (#329)", () => {
  test("counts only create/update/delete; adopt and noop are excluded", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["new-bucket", "drifted-queue", "stable-topic"]),
      observedNow: {
        "drifted-queue": meta({ status: "ACTIVE" }), // declared+live+drift → update
        "stable-topic": meta({ status: "OK" }), // declared+live, no drift → noop
        "owned-orphan": meta({ ownership: "owned" }), // owned orphan → delete
        "foreign-orphan": meta({ ownership: "foreign" }), // foreign orphan → adopt
        // new-bucket: declared, not live → create
      },
      observedThen: {
        "drifted-queue": meta({ status: "CREATING" }),
        "stable-topic": meta({ status: "OK" }),
      },
    });
    expect(gitlabMrReport(cs)).toEqual({ create: 1, update: 1, delete: 1 });
  });

  test("a runtime child (#1077) is excluded from the widget — never counted as a change", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["web"]),
      observedNow: {
        web: meta({ type: "K8s::Apps::Deployment" }),
        "prod/web-abc": meta({ type: "K8s::Core::Pod", ownerChain: { root: "declared", entity: "web" } }),
      },
      observedThen: undefined,
    });
    expect(gitlabMrReport(cs)).toEqual({ create: 0, update: 0, delete: 0 });
  });

  test("empty plan reports all zeros", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(),
      observedNow: {},
      observedThen: undefined,
    });
    expect(gitlabMrReport(cs)).toEqual({ create: 0, update: 0, delete: 0 });
  });

  test("adopt-only plan reports zeros — the widget never shows undeclared resources", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(),
      observedNow: { orphan: meta() }, // unknown ownership → adopt
      observedThen: undefined,
    });
    expect(gitlabMrReport(cs)).toEqual({ create: 0, update: 0, delete: 0 });
  });
});

// ── The observation tri-state (#1089) ───────────────────────────────────────

describe("buildChangeSet: not-observed is not absent (#1089)", () => {
  test("declared and not observed → unobserved, never create", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["crd-widget"]),
      observedNow: {},
      observedThen: undefined,
      unobserved: {
        "crd-widget": {
          type: "K8s::Example::Widget",
          reason: "unsupported-kind",
          detail: "no kubectl mapping",
        },
      },
    });
    const e = cs.entries.find((x) => x.name === "crd-widget")!;
    expect(e.action).toBe("unobserved");
    expect(e.evidence).toEqual({ declared: true, inSnapshot: false, live: false, observed: false });
    expect(e.unobservedReason).toBe("unsupported-kind");
    expect(e.type).toBe("K8s::Example::Widget");
  });

  test("the same entity, confirmed absent, still classifies as create", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["crd-widget"]),
      observedNow: {},
      observedThen: undefined,
    });
    expect(cs.entries.find((x) => x.name === "crd-widget")!.action).toBe("create");
  });

  test("a create carries the address the provider confirmed absent, when the lexicon reported one (#1620)", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["web"]),
      observedNow: {},
      observedThen: undefined,
      queried: { web: "/apis/apps/v1/namespaces/default/deployments/web" },
    });
    const e = cs.entries.find((x) => x.name === "web")!;
    // The verdict is unchanged — the address is diagnostic, never load-bearing.
    expect(e.action).toBe("create");
    expect(e.queried).toBe("/apis/apps/v1/namespaces/default/deployments/web");
  });

  test("an unobserved entry's own queried address wins over the map (#1620)", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["web"]),
      observedNow: {},
      observedThen: undefined,
      unobserved: { web: { reason: "read-failed", queried: "from-entry" } },
      queried: { web: "from-map" },
    });
    const e = cs.entries.find((x) => x.name === "web")!;
    expect(e.action).toBe("unobserved");
    expect(e.queried).toBe("from-entry");
  });

  test("a returned resource wins over an unobserved claim for the same name", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["queue"]),
      observedNow: { queue: meta() },
      observedThen: undefined,
      unobserved: { queue: { reason: "read-failed" } },
    });
    const e = cs.entries.find((x) => x.name === "queue")!;
    expect(e.action).toBe("noop");
    expect(e.evidence.observed).toBe(true);
  });

  test("an unobserved entity that is in the snapshot is not read as gone", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["queue"]),
      observedNow: {},
      observedThen: { queue: meta() },
      unobserved: { queue: { reason: "no-credentials" } },
    });
    const e = cs.entries.find((x) => x.name === "queue")!;
    expect(e.action).toBe("unobserved");
    expect(e.evidence.inSnapshot).toBe(true);
  });

  test("an unobserved entity is never a delete, even with an owned marker in the snapshot", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(),
      observedNow: {},
      observedThen: { legacy: meta({ ownership: "owned" }) },
      unobserved: { legacy: { reason: "read-failed" } },
    });
    expect(cs.entries.find((x) => x.name === "legacy")!.action).toBe("unobserved");
  });

  test("summarize and render surface the hole", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["a"]),
      observedNow: {},
      observedThen: undefined,
      unobserved: { a: { reason: "no-binding", detail: "no kubectl context for prod" } },
    });
    expect(summarize(cs).unobserved).toBe(1);
    expect(summarize(cs).create).toBe(0);
    const out = renderChangeSet(cs);
    expect(out).toContain("UNOBSERVED");
    expect(out).toContain("no binding for this environment");
    expect(out).toContain("no kubectl context for prod");
  });

  test("the GitLab widget excludes unobserved — its three columns cannot express a hole", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["a"]),
      observedNow: {},
      observedThen: undefined,
      unobserved: { a: { reason: "read-failed" } },
    });
    expect(gitlabMrReport(cs)).toEqual({ create: 0, update: 0, delete: 0 });
  });
});
