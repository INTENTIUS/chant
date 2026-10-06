import { describe, test, expect } from "vitest";
import { applyRenderedPatches, renderedPatch, type RenderedPatch } from "./rendered-patch";

const docs = (): Array<Record<string, unknown>> => [
  { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "cfg", namespace: "a" }, data: { level: "info" } },
  { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "cfg", namespace: "b" }, data: { level: "info" } },
  { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web", namespace: "a" }, spec: { replicas: 1 } },
];

describe("applyRenderedPatches", () => {
  test("no patches returns the documents unchanged", () => {
    expect(applyRenderedPatches(docs(), undefined, "src")).toEqual(docs());
    expect(applyRenderedPatches(docs(), [], "src")).toEqual(docs());
  });

  test("a namespaced selector patches only that document", () => {
    const out = applyRenderedPatches(
      docs(),
      [{ kind: "ConfigMap", name: "cfg", namespace: "b", merge: { data: { level: "debug" } } }],
      "src",
    );
    expect(out.map((d) => (d.data as { level?: string } | undefined)?.level)).toEqual(["info", "debug", undefined]);
  });

  test("without a namespace, every document of that kind and name matches", () => {
    const out = applyRenderedPatches(
      docs(),
      [{ kind: "ConfigMap", name: "cfg", jsonPatch: [{ op: "replace", path: "/data/level", value: "warn" }] }],
      "src",
    );
    expect(out.slice(0, 2).map((d) => (d.data as { level: string }).level)).toEqual(["warn", "warn"]);
  });

  test("patches apply in order, each seeing the last one's result", () => {
    const out = applyRenderedPatches(
      docs(),
      [
        { kind: "Deployment", name: "web", merge: { spec: { replicas: 3 } } },
        { kind: "Deployment", name: "web", jsonPatch: [{ op: "test", path: "/spec/replicas", value: 3 }] },
      ],
      "src",
    );
    expect((out[2].spec as { replicas: number }).replicas).toBe(3);
  });

  test("a selector matching nothing is an error naming the source and the documents of that kind", () => {
    expect(() =>
      applyRenderedPatches(docs(), [{ kind: "Deployment", name: "api", merge: { spec: { replicas: 2 } } }], 'HelmRender "x"'),
    ).toThrow(/HelmRender "x": patch 0 \(kind Deployment, name api\) matched no document\. Deployment documents present: a\/web\./);
    expect(() =>
      applyRenderedPatches(docs(), [{ kind: "Service", name: "web", merge: {} }], "src"),
    ).toThrow(/There are no Service documents/);
  });

  test("apiVersion narrows the selector", () => {
    expect(() =>
      applyRenderedPatches(docs(), [{ kind: "Deployment", name: "web", apiVersion: "apps/v1beta1", merge: {} }], "src"),
    ).toThrow(/matched no document/);
  });

  test("a failed operation names the source and the patch", () => {
    expect(() =>
      applyRenderedPatches(
        docs(),
        [{ kind: "Deployment", name: "web", jsonPatch: [{ op: "test", path: "/spec/replicas", value: 2 }] }],
        "file.yaml",
      ),
    ).toThrow(/file\.yaml: patch 0 \(kind Deployment, name web\): operation 0 \(test\): test failed/);
  });

  test("both or neither of jsonPatch and merge is refused", () => {
    const both = { kind: "Deployment", name: "web", jsonPatch: [], merge: {} } as unknown as RenderedPatch;
    const neither = { kind: "Deployment", name: "web" } as unknown as RenderedPatch;
    expect(() => applyRenderedPatches(docs(), [both], "src")).toThrow(/exactly one of jsonPatch and merge/);
    expect(() => applyRenderedPatches(docs(), [neither], "src")).toThrow(/exactly one of jsonPatch and merge/);
  });

  test("a patch that removes kind is refused", () => {
    expect(() =>
      applyRenderedPatches(docs(), [{ kind: "Deployment", name: "web", jsonPatch: [{ op: "remove", path: "/kind" }] }], "src"),
    ).toThrow(/left a document without a string apiVersion and kind/);
  });

  test("renderedPatch infers the kind and returns the patch unchanged", () => {
    const patch = renderedPatch({ kind: "Deployment", name: "web", merge: { spec: { replicas: 5 } } });
    expect(patch).toEqual({ kind: "Deployment", name: "web", merge: { spec: { replicas: 5 } } });
    const out = applyRenderedPatches(docs(), [patch], "src");
    expect((out[2].spec as { replicas: number }).replicas).toBe(5);
  });

  test("the input documents are not mutated", () => {
    const input = docs();
    applyRenderedPatches(input, [{ kind: "Deployment", name: "web", merge: { spec: { replicas: 9 } } }], "src");
    expect(input).toEqual(docs());
  });
});
