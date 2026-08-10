/**
 * The observation contract itself (#1089) — the normalizer, the envelope
 * discriminant, and the multi-stack merge.
 */
import { describe, test, expect } from "vitest";
import {
  UNOBSERVED_REASONS,
  boundedConcurrently,
  formatUnobserved,
  isObservationResult,
  isUnobservedReason,
  mergeObservations,
  normalizeObservation,
  observation,
  observeEntities,
  unobservedAll,
  unobservedReasonText,
  type DeclaredEntity,
  type EntityObservation,
  type ObserverAdapter,
} from "./observation";
import type { ResourceMetadata } from "./lexicon";

const meta = (over: Partial<ResourceMetadata> = {}): ResourceMetadata => ({
  type: "Fake::Resource",
  status: "OK",
  ...over,
});

describe("normalizeObservation", () => {
  test("a bare map means 'I looked at everything'", () => {
    expect(normalizeObservation({ a: meta() })).toEqual({ resources: { a: meta() }, unobserved: {}, queried: {} });
  });

  test("the envelope carries both halves", () => {
    const value = observation({ a: meta() }, { b: { reason: "read-failed" } });
    expect(normalizeObservation(value)).toEqual({
      resources: { a: meta() },
      unobserved: { b: { reason: "read-failed" } },
      queried: {},
    });
  });

  test("undefined normalizes to empty maps", () => {
    expect(normalizeObservation(undefined)).toEqual({ resources: {}, unobserved: {}, queried: {} });
  });

  test("the envelope carries the queried addresses through normalization (#1620)", () => {
    const value = observation({}, {}, { web: "/apis/apps/v1/namespaces/default/deployments/web" });
    expect(normalizeObservation(value).queried).toEqual({
      web: "/apis/apps/v1/namespaces/default/deployments/web",
    });
    // Additive metadata only: an entity in `queried` and neither map is still
    // OBSERVED-ABSENT — the tri-state does not shift.
    expect(normalizeObservation(value).resources).toEqual({});
    expect(normalizeObservation(value).unobserved).toEqual({});
  });

  test("the envelope omits an empty queried map (#1620)", () => {
    expect(observation({ a: meta() }, {}, {})).toEqual({ observation: "v1", resources: { a: meta() } });
  });

  test("an entity literally named `observation` cannot be mistaken for the envelope", () => {
    const bare = { observation: meta({ type: "Odd::Name" }) };
    expect(isObservationResult(bare)).toBe(false);
    expect(normalizeObservation(bare).resources.observation.type).toBe("Odd::Name");
  });

  test("the envelope omits an empty unobserved map", () => {
    expect(observation({ a: meta() }, {})).toEqual({ observation: "v1", resources: { a: meta() } });
  });
});

describe("unobservedAll", () => {
  test("marks every named entity with one reason, carrying declared types", () => {
    const entities = new Map([["a", { entityType: "AWS::S3::Bucket" }]]);
    expect(unobservedAll(["a", "b"], "no-credentials", "token expired", entities)).toEqual({
      a: { reason: "no-credentials", type: "AWS::S3::Bucket", detail: "token expired" },
      b: { reason: "no-credentials", detail: "token expired" },
    });
  });
});

describe("mergeObservations (multi-stack)", () => {
  test("present beats not-observed beats absent", () => {
    const merged = mergeObservations([
      { resources: {}, unobserved: { a: { reason: "read-failed" }, b: { reason: "no-binding" } }, queried: {} },
      { resources: { a: meta() }, unobserved: {}, queried: {} },
    ]);
    expect(Object.keys(merged.resources)).toEqual(["a"]);
    expect(Object.keys(merged.unobserved)).toEqual(["b"]);
  });

  test("an entity nobody looked for in any stack stays absent", () => {
    const merged = mergeObservations([
      { resources: { a: meta() }, unobserved: {}, queried: {} },
      { resources: { b: meta() }, unobserved: {}, queried: {} },
    ]);
    expect(merged.unobserved).toEqual({});
  });

  test("queried addresses union across stacks (#1620)", () => {
    const merged = mergeObservations([
      { resources: {}, unobserved: {}, queried: { a: "stack-1/a" } },
      { resources: { b: meta() }, unobserved: {}, queried: { b: "stack-2/b" } },
    ]);
    expect(merged.queried).toEqual({ a: "stack-1/a", b: "stack-2/b" });
  });
});

describe("reason totality", () => {
  test("every reason has human text and passes the guard", () => {
    for (const reason of UNOBSERVED_REASONS) {
      expect(isUnobservedReason(reason)).toBe(true);
      expect(unobservedReasonText(reason).length).toBeGreaterThan(0);
    }
    expect(isUnobservedReason("made-up")).toBe(false);
  });

  test("formatUnobserved names the entity, the type and the detail", () => {
    expect(
      formatUnobserved("widget", { type: "K8s::X::Widget", reason: "unsupported-kind", detail: "no mapping" }),
    ).toBe("widget (K8s::X::Widget) — no reader for this resource kind: no mapping");
  });

  test("formatUnobserved appends the queried address when the entry carries one (#1620)", () => {
    expect(
      formatUnobserved("web", { reason: "read-failed", detail: "HTTP 500", queried: "/apis/apps/v1/namespaces/default/deployments/web" }),
    ).toBe("web — read failed: HTTP 500 [queried /apis/apps/v1/namespaces/default/deployments/web]");
  });
});

describe("boundedConcurrently", () => {
  test("processes every item", async () => {
    const seen: number[] = [];
    await boundedConcurrently([1, 2, 3, 4, 5], async (n) => {
      seen.push(n);
    }, 2);
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  test("never exceeds the limit in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await boundedConcurrently(Array.from({ length: 20 }, (_, i) => i), async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    }, 4);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // it did run concurrently, not serially
  });

  test("an empty list is a no-op", async () => {
    await expect(boundedConcurrently([], async () => {})).resolves.toBeUndefined();
  });
});

describe("observeEntities harness (#1201)", () => {
  const entity = (name: string, type = "Fake::Resource"): DeclaredEntity => ({ name, type, props: {} });

  /** A fake adapter whose `read` is table-driven by entity name. */
  const adapterOf = (
    reads: Record<string, EntityObservation | (() => Promise<EntityObservation>)>,
    over: Partial<ObserverAdapter<{ ok: true }>> = {},
  ): ObserverAdapter<{ ok: true }> => ({
    bind: async () => ({ ok: true }),
    classifyBindFailure: () => ({ reason: "read-failed" }),
    read: async (_client, e) => {
      const r = reads[e.name];
      if (typeof r === "function") return r();
      if (!r) throw new Error(`no fake read for ${e.name}`);
      return r;
    },
    ...over,
  });

  test("routes the tri-state: present -> resources, absent -> neither, unobserved -> unobserved", async () => {
    const result = await observeEntities(
      [entity("a"), entity("b"), entity("c", "Fake::Odd")],
      adapterOf({
        a: { present: meta({ physicalId: "id-a" }) },
        b: { absent: true },
        c: { unobserved: { reason: "unsupported-kind", detail: "no reader" } },
      }),
    );
    expect(Object.keys(result.resources)).toEqual(["a"]);
    expect(result.resources.a.physicalId).toBe("id-a");
    // absent 'b' is in neither map
    expect(result.unobserved).toEqual({
      c: { type: "Fake::Odd", reason: "unsupported-kind", detail: "no reader" },
    });
  });

  test("collects the queried address from every variant — the absent one especially (#1620)", async () => {
    const result = await observeEntities(
      [entity("a"), entity("b"), entity("c")],
      adapterOf({
        a: { present: meta(), queried: "region-1/a" },
        b: { absent: true, queried: "region-1/b" },
        c: { unobserved: { reason: "read-failed", detail: "boom" }, queried: "region-1/c" },
      }),
    );
    // The absent entity stays in neither map — additive metadata, tri-state unshifted.
    expect(Object.keys(result.resources)).toEqual(["a"]);
    expect(Object.keys(result.unobserved ?? {})).toEqual(["c"]);
    expect(result.queried).toEqual({ a: "region-1/a", b: "region-1/b", c: "region-1/c" });
    // The unobserved entry carries its own copy, so a row renders without a join.
    expect(result.unobserved?.c.queried).toBe("region-1/c");
  });

  test("a bind failure marks every entity NOT-OBSERVED with the typed reason and declared type", async () => {
    const result = await observeEntities(
      [entity("a", "AWS::S3::Bucket"), entity("b", "AWS::S3::Bucket")],
      adapterOf(
        {},
        {
          bind: async () => {
            throw new Error("no creds");
          },
          classifyBindFailure: () => ({ reason: "no-credentials", detail: "token expired" }),
        },
      ),
    );
    expect(result.resources).toEqual({});
    expect(result.unobserved).toEqual({
      a: { reason: "no-credentials", type: "AWS::S3::Bucket", detail: "token expired" },
      b: { reason: "no-credentials", type: "AWS::S3::Bucket", detail: "token expired" },
    });
  });

  test("a loud refusal rethrows instead of degrading to a hole", async () => {
    await expect(
      observeEntities(
        [entity("a")],
        adapterOf(
          {},
          {
            bind: async () => {
              throw new Error("context mismatch");
            },
            classifyBindFailure: () => "rethrow",
          },
        ),
      ),
    ).rejects.toThrow("context mismatch");
  });

  test("a per-entity read throw degrades to read-failed for that one entity, not an absence", async () => {
    const result = await observeEntities(
      [entity("a"), entity("b")],
      adapterOf({
        a: () => Promise.reject(new Error("boom")),
        b: { present: meta() },
      }),
    );
    expect(Object.keys(result.resources)).toEqual(["b"]);
    expect(result.unobserved?.a).toEqual({ type: "Fake::Resource", reason: "read-failed", detail: "boom" });
  });

  test("uses the adapter's own concurrency pool when it supplies one", async () => {
    let usedPool = false;
    await observeEntities(
      [entity("a")],
      adapterOf(
        { a: { present: meta() } },
        {
          concurrently: async (items, fn) => {
            usedPool = true;
            for (const it of items) await fn(it);
          },
        },
      ),
    );
    expect(usedPool).toBe(true);
  });
});
