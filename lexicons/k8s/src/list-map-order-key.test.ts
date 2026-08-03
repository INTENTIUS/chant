import { describe, test, expect } from "vitest";
import { schemaListMapOrderKey } from "./deep-observe-hooks";
import { k8sListMapOrderKey } from "@intentius/chant/managed-fields";
import type { DeepArrayElement } from "@intentius/chant/lexicon";

/**
 * chant #1441 — list elements are identified by the key the SPEC declares,
 * with the hand-written conventions kept as fallback.
 *
 * The behavioural claim under test: two observations of the same object whose
 * associative lists arrive in different orders must canonicalize to the same
 * sequence, so ordering alone is never reported as drift.
 */

function el(pattern: string, element: unknown, index = 0): DeepArrayElement {
  return { entityType: "K8s::Apps::Deployment", pattern, path: pattern, element, index, side: "live" };
}

/** Sort a list the way core's normalization does, using the hook's key. */
function canonicalOrder(pattern: string, elements: unknown[]): unknown[] {
  return elements
    .map((element, index) => ({ element, key: schemaListMapOrderKey(el(pattern, element, index)) }))
    .sort((a, b) => (a.key ?? "").localeCompare(b.key ?? ""))
    .map((e) => e.element);
}

describe("conditions — the case the hardcoded table missed", () => {
  const ready = { type: "Ready", status: "True" };
  const progressing = { type: "Progressing", status: "True" };

  test("is identified by type", () => {
    expect(schemaListMapOrderKey(el("status.conditions", ready))).toBe("Ready");
  });

  test("was NOT identified before this change", () => {
    // Guards the premise: without the spec-derived table, `conditions` fell
    // through to `undefined`, which leaves the array order alone — so two
    // orderings compared positionally and read as drift.
    expect(k8sListMapOrderKey(el("status.conditions", ready))).toBeUndefined();
  });

  test("two orderings of the same conditions canonicalize identically", () => {
    expect(canonicalOrder("status.conditions", [ready, progressing])).toEqual(
      canonicalOrder("status.conditions", [progressing, ready]),
    );
  });
});

describe("ports — one name, two key shapes", () => {
  test("a container port is keyed by containerPort and protocol", () => {
    // Byte-identical to what the hardcoded implementation produced, because
    // this string is also the element's address in drift output.
    const element = { containerPort: 8080, protocol: "TCP" };
    expect(schemaListMapOrderKey(el("spec.template.spec.containers.ports", element))).toBe("08080/TCP");
    expect(schemaListMapOrderKey(el("spec.template.spec.containers.ports", element))).toBe(
      k8sListMapOrderKey(el("spec.template.spec.containers.ports", element)),
    );
  });

  test("a Service port is keyed by port and protocol", () => {
    expect(schemaListMapOrderKey(el("spec.ports", { port: 443, protocol: "TCP" }))).toBe("00443/TCP");
  });

  test("numeric key fields order numerically, not lexicographically", () => {
    const ordered = canonicalOrder("spec.ports", [
      { port: 443, protocol: "TCP" },
      { port: 80, protocol: "TCP" },
    ]);
    expect(ordered).toEqual([
      { port: 80, protocol: "TCP" },
      { port: 443, protocol: "TCP" },
    ]);
  });
});

describe("fallback", () => {
  test("a list the spec does not annotate still gets the hand-written key", () => {
    // `containers` is in both the generated table and the hardcoded one; the
    // point is that removing an element's spec-declared fields does not strand
    // it — it lands on the by-name convention.
    const key = schemaListMapOrderKey(el("spec.template.spec.containers", { name: "app", image: "nginx" }));
    expect(key).toBeDefined();
  });

  test("an unknown list is left unordered, exactly as before", () => {
    expect(schemaListMapOrderKey(el("spec.somethingUnknown", { a: 1 }))).toBeUndefined();
  });

  test("a non-object element is left to the fallback rather than crashing", () => {
    expect(() => schemaListMapOrderKey(el("spec.template.spec.containers", "not-an-object"))).not.toThrow();
  });

  test("an element missing its declared key fields falls through", () => {
    // A conditions entry with no `type` cannot be identified by the spec key.
    // It must not produce `type=undefined`, which would collide across
    // elements and silently merge distinct entries.
    const key = schemaListMapOrderKey(el("status.conditions", { status: "True" }));
    expect(key ?? "").not.toContain("undefined");
  });
});

describe("compatibility with the hardcoded table", () => {
  // The order key is the element's address in drift output, so every property
  // the hand-written table already covered must keep producing the identical
  // string. A change here silently rewrites existing drift paths.
  const cases: Array<[string, unknown]> = [
    ["spec.template.spec.containers", { name: "app", image: "nginx" }],
    ["spec.template.spec.initContainers", { name: "init" }],
    ["spec.template.spec.ephemeralContainers", { name: "debug" }],
    ["spec.template.spec.containers.env", { name: "PORT", value: "8080" }],
    ["spec.template.spec.volumes", { name: "data" }],
    ["spec.template.spec.containers.ports", { containerPort: 80, protocol: "TCP" }],
    ["spec.ports", { port: 443, protocol: "TCP" }],
  ];

  test.each(cases)("%s produces the same key as before", (pattern, element) => {
    expect(schemaListMapOrderKey(el(pattern, element))).toBe(k8sListMapOrderKey(el(pattern, element)));
  });
});
