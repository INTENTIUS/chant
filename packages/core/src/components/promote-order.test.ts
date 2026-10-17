import { describe, test, expect } from "vitest";
import { promotionOrder, staticPromotionOrder } from "../workspace/promotion-order";
import { resolvePromotionSource } from "./promote-order";

describe("promotionOrder (#4030)", () => {
  test("is the literal entries in order, with canary read from the object form", () => {
    expect(promotionOrder(["dev", { name: "staging", canary: true }, { name: "prod", endpoint: "http://x" }, "pr-*"])).toEqual([
      { name: "dev", canary: false },
      { name: "staging", canary: true },
      { name: "prod", canary: false },
    ]);
  });

  test("is empty without environments, and a repeated name keeps its first place", () => {
    expect(promotionOrder(undefined)).toEqual([]);
    expect(promotionOrder(null)).toEqual([]);
    expect(promotionOrder(["a", "b", "a"]).map((s) => s.name)).toEqual(["a", "b"]);
  });
});

describe("resolvePromotionSource (#4030)", () => {
  const order = promotionOrder(["dev", "staging", "prod"]);

  test("defaults from to the step before to", () => {
    expect(resolvePromotionSource({ order, to: "prod" })).toEqual({ from: "staging" });
    expect(resolvePromotionSource({ order, to: "staging" })).toEqual({ from: "dev" });
  });

  test("an adjacent from is accepted", () => {
    expect(resolvePromotionSource({ order, to: "prod", from: "staging" })).toEqual({ from: "staging" });
  });

  test("a from that skips a step is refused, and allowSkip lifts it", () => {
    const r = resolvePromotionSource({ order, to: "prod", from: "dev" });
    expect(r).toMatchObject({ error: { code: "promote-skips-environment" } });
    expect("error" in r && r.error.message).toContain("skips staging");
    expect("error" in r && r.error.fix).toContain("--allow-skip");
    expect(resolvePromotionSource({ order, to: "prod", from: "dev", allowSkip: true })).toEqual({ from: "dev" });
  });

  test("a step outside the order is not judged", () => {
    expect(resolvePromotionSource({ order, to: "prod", from: "hotfix" })).toEqual({ from: "hotfix" });
    expect(resolvePromotionSource({ order, to: "pr-42", from: "dev" })).toEqual({ from: "dev" });
  });

  test("going backwards is not a skip", () => {
    expect(resolvePromotionSource({ order, to: "dev", from: "prod" })).toEqual({ from: "prod" });
  });

  test("no order leaves from as given", () => {
    expect(resolvePromotionSource({ order: [], to: "prod" })).toEqual({ from: undefined });
    expect(resolvePromotionSource({ order: [], to: "prod", from: "dev" })).toEqual({ from: "dev" });
  });
});

describe("staticPromotionOrder (#4030)", () => {
  test("reads literal strings and objects without running the config, comments left out", () => {
    const src = `// environments: ["old"]
import type { ChantConfig } from "@intentius/chant";
export default {
  lexicons: ["aws"],
  /* the order */
  environments: [
    "dev",
    { name: "staging", canary: true },
    { name: 'prod', endpoint: "http://localhost:4566" },
    "pr-*",
  ],
} satisfies ChantConfig;
`;
    expect(staticPromotionOrder(src)).toEqual([
      { name: "dev", canary: false },
      { name: "staging", canary: true },
      { name: "prod", canary: false },
    ]);
  });

  test("a config with no environments and no spread declares none", () => {
    expect(staticPromotionOrder('export default { lexicons: ["aws"] };\n')).toEqual([]);
  });

  test("anything computed is left to the loader", () => {
    expect(staticPromotionOrder('export default { environments: [...base, "prod"] };')).toBeUndefined();
    expect(staticPromotionOrder('const envs = ["a"];\nexport default { environments: envs };')).toBeUndefined();
    expect(staticPromotionOrder('export default { environments: ["a", `b${x}`] };')).toBeUndefined();
    expect(staticPromotionOrder('export default { environments: ["a", { name: n }] };')).toBeUndefined();
    expect(staticPromotionOrder('export default { a: { environments: ["x"] }, environments: ["y"] };')).toBeUndefined();
    expect(staticPromotionOrder("export default makeConfig();")).toBeUndefined();
  });
});
