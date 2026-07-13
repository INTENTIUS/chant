import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { loadActivities, type ActivityFn } from "@intentius/chant/op";
import { createSpritesFake } from "./sprites-fake";
import { spriteCreate as createImpl } from "./sprites";
import {
  spriteApplyNetworkPolicy,
  spriteApplyServices,
  validateNetworkRules,
  networkRulesEqual,
  validateServices,
  serviceConfigEqual,
  type NetworkRule,
  type ServiceSpec,
} from "./sprite-config";

// Config reconcile (#849) — pure validators + end-to-end against the in-process
// fake (S7), no Docker. Network policy is a whole-object replace; services are
// additive + update, started in dependency order.

let fake: { url: string; close(): Promise<void> };
let prevBaseUrl: string | undefined;

beforeAll(async () => {
  fake = await createSpritesFake();
  prevBaseUrl = process.env.SPRITES_BASE_URL;
  process.env.SPRITES_BASE_URL = fake.url;
});

afterAll(async () => {
  if (prevBaseUrl === undefined) delete process.env.SPRITES_BASE_URL;
  else process.env.SPRITES_BASE_URL = prevBaseUrl;
  await fake?.close();
});

async function inspect(id: string): Promise<{
  netPolicy: NetworkRule[];
  services: Record<string, { name: string; needs?: string[]; state: { status: string } }>;
}> {
  const res = await fetch(`${fake.url}/v1/sprites/${id}`);
  return (await res.json()) as never;
}

describe("network policy validators (pure)", () => {
  test("validateNetworkRules rejects a bad action / empty domain", () => {
    expect(() => validateNetworkRules([{ domain: "", action: "allow" }])).toThrow(/missing domain/);
    expect(() => validateNetworkRules([{ domain: "x", action: "nope" as never }])).toThrow(/allow.*deny/);
    expect(() => validateNetworkRules([{ domain: "github.com", action: "allow" }])).not.toThrow();
  });
  test("networkRulesEqual is order-sensitive", () => {
    const a: NetworkRule[] = [{ domain: "a", action: "allow" }, { domain: "b", action: "deny" }];
    expect(networkRulesEqual(a, [...a])).toBe(true);
    expect(networkRulesEqual(a, [a[1], a[0]])).toBe(false);
    expect(networkRulesEqual(a, [a[0]])).toBe(false);
  });
});

describe("service validators (pure)", () => {
  test("validateServices returns a dependency-first order", () => {
    const svcs: ServiceSpec[] = [
      { name: "web", cmd: "run-web", needs: ["db"] },
      { name: "db", cmd: "run-db" },
    ];
    expect(validateServices(svcs)).toEqual(["db", "web"]);
  });
  test("rejects a dangling needs and a cycle and a duplicate", () => {
    expect(() => validateServices([{ name: "web", cmd: "x", needs: ["db"] }])).toThrow(/not defined/);
    expect(() =>
      validateServices([
        { name: "a", cmd: "x", needs: ["b"] },
        { name: "b", cmd: "x", needs: ["a"] },
      ]),
    ).toThrow(/cycle/);
    expect(() =>
      validateServices([
        { name: "a", cmd: "x" },
        { name: "a", cmd: "y" },
      ]),
    ).toThrow(/duplicate/);
  });
  test("serviceConfigEqual ignores undefined-vs-empty noise", () => {
    expect(serviceConfigEqual({ cmd: "x" }, { cmd: "x", args: [], env: {} })).toBe(true);
    expect(serviceConfigEqual({ cmd: "x", http_port: 80 }, { cmd: "x" })).toBe(false);
  });
});

describe("spriteApplyNetworkPolicy reconcile", () => {
  test("applies once, converges on re-apply, replaces on change", async () => {
    await createImpl({ name: "np-1", endpoint: fake.url });
    const rules: NetworkRule[] = [
      { domain: "*.github.com", action: "allow" },
      { domain: "*", action: "deny" },
    ];
    expect((await spriteApplyNetworkPolicy({ id: "np-1", rules, endpoint: fake.url })).changed).toBe(true);
    expect((await inspect("np-1")).netPolicy).toEqual(rules);

    // Idempotent: same ruleset → no change.
    expect((await spriteApplyNetworkPolicy({ id: "np-1", rules, endpoint: fake.url })).changed).toBe(false);

    // Changed ruleset → replaced.
    const tighter: NetworkRule[] = [{ domain: "github.com", action: "allow" }, { domain: "*", action: "deny" }];
    expect((await spriteApplyNetworkPolicy({ id: "np-1", rules: tighter, endpoint: fake.url })).changed).toBe(true);
    expect((await inspect("np-1")).netPolicy).toEqual(tighter);
  });

  test("invalid rules throw before any HTTP", async () => {
    await expect(
      spriteApplyNetworkPolicy({ id: "np-1", rules: [{ domain: "", action: "allow" }], endpoint: fake.url }),
    ).rejects.toThrow(/missing domain/);
  });
});

describe("spriteApplyServices reconcile", () => {
  test("creates services, starts them in dependency order, converges on re-apply", async () => {
    await createImpl({ name: "svc-1", endpoint: fake.url });
    const services: ServiceSpec[] = [
      { name: "web", cmd: "run-web", needs: ["db"], http_port: 8080 },
      { name: "db", cmd: "run-db" },
    ];
    const r1 = await spriteApplyServices({ id: "svc-1", services, start: true, endpoint: fake.url });
    expect(new Set(r1.applied)).toEqual(new Set(["web", "db"]));
    // Started dependency-first.
    expect(r1.started).toEqual(["db", "web"]);

    const state = await inspect("svc-1");
    expect(Object.keys(state.services).sort()).toEqual(["db", "web"]);
    expect(state.services.web.state.status).toBe("running");

    // Re-apply unchanged → nothing applied.
    const r2 = await spriteApplyServices({ id: "svc-1", services, endpoint: fake.url });
    expect(r2.applied).toEqual([]);

    // Change one → only it is re-applied.
    const changed = services.map((s) => (s.name === "web" ? { ...s, http_port: 9090 } : s));
    const r3 = await spriteApplyServices({ id: "svc-1", services: changed, endpoint: fake.url });
    expect(r3.applied).toEqual(["web"]);
  });

  test("a dependency cycle throws before any HTTP", async () => {
    await createImpl({ name: "svc-2", endpoint: fake.url });
    await expect(
      spriteApplyServices({
        id: "svc-2",
        services: [
          { name: "a", cmd: "x", needs: ["b"] },
          { name: "b", cmd: "x", needs: ["a"] },
        ],
        endpoint: fake.url,
      }),
    ).rejects.toThrow(/cycle/);
  });
});

describe("config activities resolve by name", () => {
  test("loadActivities([\"fly\"]) exposes the reconcile activities", async () => {
    const activities: Map<string, ActivityFn> = await loadActivities(["fly"]);
    expect(typeof activities.get("spriteApplyNetworkPolicy")).toBe("function");
    expect(typeof activities.get("spriteApplyServices")).toBe("function");
  });
});
