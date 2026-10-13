import { describe, test, expect } from "vitest";
import { applyJsonPatch, applyMergePatch } from "./json-patch";

const doc = () => ({
  metadata: { name: "web", labels: { app: "web" } },
  spec: { replicas: 1, containers: [{ name: "a" }, { name: "b" }] },
});

describe("applyJsonPatch", () => {
  test("add sets a member, inserts into an array, and appends with -", () => {
    const out = applyJsonPatch(doc(), [
      { op: "add", path: "/metadata/labels/tier", value: "frontend" },
      { op: "add", path: "/spec/containers/1", value: { name: "mid" } },
      { op: "add", path: "/spec/containers/-", value: { name: "last" } },
    ]);
    expect(out.metadata.labels).toEqual({ app: "web", tier: "frontend" });
    expect(out.spec.containers.map((c) => c.name)).toEqual(["a", "mid", "b", "last"]);
  });

  test("replace changes an existing value and refuses a missing one", () => {
    expect(applyJsonPatch(doc(), [{ op: "replace", path: "/spec/replicas", value: 3 }]).spec.replicas).toBe(3);
    expect(() => applyJsonPatch(doc(), [{ op: "replace", path: "/spec/paused", value: true }])).toThrow(
      /operation 0 \(replace\): path \/spec\/paused does not exist/,
    );
  });

  test("remove deletes a member or an array element and refuses a missing path", () => {
    const out = applyJsonPatch(doc(), [
      { op: "remove", path: "/metadata/labels/app" },
      { op: "remove", path: "/spec/containers/0" },
    ]);
    expect(out.metadata.labels).toEqual({});
    expect(out.spec.containers).toEqual([{ name: "b" }]);
    expect(() => applyJsonPatch(doc(), [{ op: "remove", path: "/spec/containers/5" }])).toThrow(/out of bounds/);
  });

  test("test passes on a deep-equal value and fails with both values in the message", () => {
    expect(() =>
      applyJsonPatch(doc(), [{ op: "test", path: "/spec/containers/0", value: { name: "a" } }]),
    ).not.toThrow();
    expect(() => applyJsonPatch(doc(), [{ op: "test", path: "/spec/replicas", value: 2 }])).toThrow(
      /test failed at \/spec\/replicas: expected 2, found 1/,
    );
  });

  test("move and copy", () => {
    const out = applyJsonPatch(doc(), [
      { op: "copy", from: "/metadata/labels", path: "/spec/selector" },
      { op: "move", from: "/spec/replicas", path: "/spec/count" },
    ]);
    expect(out).toMatchObject({ spec: { selector: { app: "web" }, count: 1 } });
    expect((out.spec as Record<string, unknown>).replicas).toBeUndefined();
  });

  test("pointer escapes ~0 and ~1 address keys holding ~ and /", () => {
    const out = applyJsonPatch({ metadata: { annotations: {} as Record<string, string> } }, [
      { op: "add", path: "/metadata/annotations/example.com~1a~0b", value: "x" },
    ]);
    expect(out.metadata.annotations).toEqual({ "example.com/a~b": "x" });
  });

  test("never mutates its input, even when a later operation fails", () => {
    const input = doc();
    expect(() =>
      applyJsonPatch(input, [
        { op: "replace", path: "/spec/replicas", value: 9 },
        { op: "test", path: "/spec/replicas", value: 1 },
      ]),
    ).toThrow(/operation 1 \(test\)/);
    expect(input).toEqual(doc());
  });
});

describe("applyMergePatch (RFC 7386)", () => {
  test("merges objects, replaces arrays, deletes on null", () => {
    const out = applyMergePatch(doc(), {
      metadata: { labels: { app: null, tier: "frontend" } },
      spec: { containers: [{ name: "only" }] },
    });
    expect(out.metadata.labels).toEqual({ tier: "frontend" });
    expect(out.spec.containers).toEqual([{ name: "only" }]);
    expect(out.spec.replicas).toBe(1);
  });

  test("creates missing intermediate objects and leaves the input alone", () => {
    const input = doc();
    const out = applyMergePatch(input, { spec: { strategy: { type: "Recreate" } } });
    expect(out).toMatchObject({ spec: { strategy: { type: "Recreate" } } });
    expect(input).toEqual(doc());
  });
});
