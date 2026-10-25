/**
 * Which components form a group and where it sits (ws-107, #4440), against
 * fake capabilities: `fake-group` declares `planGroup` and `runGroup`,
 * `fake-plain` does not. Planning and applying a group in a pull request is
 * in `pr-run.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CapabilityRegistry, type GroupFallback, type GroupMember } from "./capability";
import { planFanOut } from "./fan-out";
import { findComponentGroups, groupFanOut, narrowGroups } from "./groups";
import { prWavePlan } from "./pr-run";
import type { DriverComponent } from "./driver";

const so = (stack: string, name: string) => ({ stackOutput: { stack, name } });

const component = (kind: string, name: string, dependsOn: string[] = [], vars?: Record<string, unknown>, extra: Array<Record<string, unknown>> = []): DriverComponent => ({
  name,
  dependsOn,
  deploy: [{ phase: "Apply", steps: [{ kind, root: name, ...(vars ? { vars } : {}) }, ...(extra as never[])] }],
});
const grouped = (name: string, dependsOn: string[] = [], vars?: Record<string, unknown>) => component("fake-group", name, dependsOn, vars);
const plain = (name: string, dependsOn: string[] = [], vars?: Record<string, unknown>) => component("fake-plain", name, dependsOn, vars);

function registry(fallback?: (members: readonly GroupMember[]) => GroupFallback | undefined) {
  const asked: GroupMember[][] = [];
  const r = new CapabilityRegistry();
  const unused = async (): Promise<never> => {
    throw new Error("not called here");
  };
  r.register({
    kind: "fake-group",
    run: unused,
    plan: unused,
    planGroup: unused,
    runGroup: unused,
    ...(fallback
      ? {
          async groupFallback(_ctx: unknown, members: readonly GroupMember[]) {
            asked.push([...members]);
            return fallback(members);
          },
        }
      : {}),
  } as never);
  r.register({ kind: "fake-plain", run: unused, plan: unused } as never);
  return { registry: r, asked };
}

async function groupsOf(components: DriverComponent[], changed: string[], r = registry().registry) {
  const plan = planFanOut({ components, changed });
  const found = await findComponentGroups({ components, plan, registry: r, env: "prod" });
  return { plan, found, grouped: groupFanOut(plan, components, found) };
}

describe("which components form a group (ws-107)", () => {
  /** a; b reads a; c reads b. */
  const CHAIN = [grouped("a"), grouped("b", ["a"], { upstream: so("a", "id") }), grouped("c", ["b"], { upstream: so("b", "arn") })];

  test("one-step components of a group capability joined by reads form one group, upstreams first", async () => {
    const { found } = await groupsOf(CHAIN, ["a"]);
    expect(found).toEqual({ groups: [{ capability: "fake-group", components: ["a", "b", "c"] }], fallbacks: [] });
  });

  test("a component that reads none of the others, or is of another capability, joins nothing and is not listed", async () => {
    const components = [...CHAIN, grouped("lone", ["a"]), plain("p", ["a"], { upstream: so("a", "id") })];
    const { found } = await groupsOf(components, ["a"]);
    expect(found.groups).toEqual([{ capability: "fake-group", components: ["a", "b", "c"] }]);
    expect(found.fallbacks).toEqual([]);
  });

  test("a component outside the set on a dependency path between two members splits it (ruling 2)", async () => {
    // c reads a too, but m sits between them.
    const components = [grouped("a"), plain("m", ["a"], { upstream: so("a", "id") }), grouped("c", ["m"], { upstream: so("m", "x"), first: so("a", "id") })];
    const { found } = await groupsOf(components, ["a"]);
    expect(found.groups).toEqual([]);
    expect(found.fallbacks.map((f) => [f.component, f.capability, f.kind])).toEqual([
      ["a", "fake-group", "split"],
      ["c", "fake-group", "split"],
    ]);
    expect(found.fallbacks[0]!.reason).toMatch(/^m lies on a dependency path between a/);
  });

  test("a component whose group step is one of several does not join (ruling 3), and is listed as steps", async () => {
    const components = [grouped("a"), component("fake-group", "s", ["a"], { upstream: so("a", "id") }, [{ kind: "gate", gate: "ok" }])];
    const { found } = await groupsOf(components, ["a"]);
    expect(found.groups).toEqual([]);
    expect(found.fallbacks).toEqual([
      { component: "s", capability: "fake-group", kind: "steps", reason: "s deploys in 2 steps, and only a component whose deploy is one fake-group step joins a group" },
    ]);
  });

  test("the capability's groupFallback is asked before anything plans, with each member's reads and no input, and dissolves the group", async () => {
    const r = registry(() => ({ kind: "off", reason: "grouping is turned off" }));
    const { found, grouped: plan, plan: derived } = await groupsOf(CHAIN, ["a"], r.registry);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]!.map((m) => m.component)).toEqual(["a", "b", "c"]);
    expect(r.asked[0]![1]).toMatchObject({ component: "b", step: { root: "b", vars: { upstream: so("a", "id") } }, reads: [{ at: "/vars/upstream", ref: "a.id", component: "a", output: "id" }] });
    expect(r.asked[0]![1]!.input).toBeUndefined();
    expect(found.groups).toEqual([]);
    expect(found.fallbacks.map((f) => [f.component, f.kind, f.reason])).toEqual([
      ["a", "off", "grouping is turned off"],
      ["b", "off", "grouping is turned off"],
      ["c", "off", "grouping is turned off"],
    ]);
    // No group: the waves are the derivation's.
    expect(plan.waves).toEqual(derived.waves);
    expect(plan.groups).toBeUndefined();
    expect(plan.fallbacks).toEqual(found.fallbacks);
  });
});

describe("a groupFallback that drops members (#4419 ruling 1)", () => {
  /** A fallback that drops `names` while any of them is still in the group, and takes the group once none is. */
  const dropping = (names: string[]) => (members: readonly GroupMember[]): GroupFallback | undefined => {
    const hit = members.filter((m) => names.includes(m.component)).map((m) => m.component);
    return hit.length === 0 ? undefined : { kind: "lock", reason: "holds no lock", drop: hit.map((component) => ({ component, reason: `${component} holds no lock` })) };
  };

  test("dropping one of three leaves the other two grouped; core asks again with the two, and the report names the one", async () => {
    const components = [grouped("a"), grouped("b", ["a"], { upstream: so("a", "id") }), grouped("c", ["b"], { upstream: so("b", "id") })];
    const r = registry(dropping(["c"]));
    const { found, grouped: plan } = await groupsOf(components, ["a"], r.registry);
    expect(r.asked.map((ms) => ms.map((m) => m.component))).toEqual([
      ["a", "b", "c"],
      ["a", "b"],
    ]);
    expect(found.groups).toEqual([{ capability: "fake-group", components: ["a", "b"] }]);
    expect(found.fallbacks).toEqual([{ component: "c", capability: "fake-group", kind: "lock", reason: "c holds no lock" }]);
    expect(plan.fallbacks).toEqual(found.fallbacks);
    // c depends on the group, so it plans in the wave after it.
    expect(plan.waves).toEqual([["a", "b"], ["c"], []]);
  });

  test("a dropped member on a dependency path between the rest splits them, each as split", async () => {
    // c reads a and b; b reads a. Without b, a and c still read each other, but b applies between them.
    const components = [grouped("a"), grouped("b", ["a"], { upstream: so("a", "id") }), grouped("c", ["a", "b"], { first: so("a", "id"), second: so("b", "id") })];
    const r = registry(dropping(["b"]));
    const { found } = await groupsOf(components, ["a"], r.registry);
    expect(r.asked).toHaveLength(1);
    expect(found.groups).toEqual([]);
    expect(found.fallbacks.map((f) => [f.component, f.kind])).toEqual([
      ["a", "split"],
      ["b", "lock"],
      ["c", "split"],
    ]);
    expect(found.fallbacks[0]!.reason).toMatch(/^b lies on a dependency path between a/);
  });

  test("a drop that leaves one member is no group, and that member falls back as alone", async () => {
    const components = [grouped("a"), grouped("b", ["a"], { upstream: so("a", "id") })];
    const r = registry(dropping(["a"]));
    const { found, grouped: plan, plan: derived } = await groupsOf(components, ["a"], r.registry);
    expect(r.asked).toHaveLength(1);
    expect(found.groups).toEqual([]);
    expect(found.fallbacks).toEqual([
      { component: "a", capability: "fake-group", kind: "lock", reason: "a holds no lock" },
      { component: "b", capability: "fake-group", kind: "alone", reason: "b is the only member of its group left once a fell back, and a group of one is no group" },
    ]);
    expect(plan.waves).toEqual(derived.waves);
  });

  test("a drop that names no member of the group dissolves it with the fallback's kind", async () => {
    const r = registry(() => ({ kind: "lock", reason: "holds no lock", drop: [{ component: "elsewhere" }] }));
    const components = [grouped("a"), grouped("b", ["a"], { upstream: so("a", "id") })];
    const { found } = await groupsOf(components, ["a"], r.registry);
    expect(found.groups).toEqual([]);
    expect(found.fallbacks.map((f) => [f.component, f.kind, f.reason])).toEqual([
      ["a", "lock", "holds no lock"],
      ["b", "lock", "holds no lock"],
    ]);
  });
});

describe("where a group sits (ws-107)", () => {
  test("in the earliest wave any member is in; the waves it left stay, empty, and the digest is the derivation's", async () => {
    const components = [grouped("a"), grouped("b", ["a"], { upstream: so("a", "id") }), grouped("c", ["b"], { upstream: so("b", "id") })];
    const { plan, grouped: g } = await groupsOf(components, ["a"]);
    expect(plan.waves).toEqual([["a"], ["b"], ["c"]]);
    expect(g.waves).toEqual([["a", "b", "c"], [], []]);
    expect(g.order).toEqual(["a", "b", "c"]);
    expect(g.digest).toBe(plan.digest);
  });

  test("after everything its members depend on outside it; what depends on a member moves after the group", async () => {
    // b reads a and depends on u too; z depends on a.
    const components = [plain("u"), grouped("a"), grouped("b", ["a", "u"], { upstream: so("a", "id") }), plain("z", ["a"])];
    const { plan, grouped: g } = await groupsOf(components, ["a", "u"]);
    expect(plan.waves).toEqual([["a", "u"], ["b", "z"]]);
    expect(g.groups).toEqual([{ capability: "fake-group", components: ["a", "b"] }]);
    expect(g.waves).toEqual([["u"], ["a", "b"], ["z"]]);
  });

  test("a round's narrowing keeps what is left of a group as one; a wave gate's wave carries the group (ws-107)", async () => {
    const components = [plain("x"), grouped("a", ["x"], { upstream: so("x", "id") }), grouped("b", ["a"], { upstream: so("a", "id") })];
    const { grouped: g } = await groupsOf(components, ["x"]);
    expect(g.waves).toEqual([["x"], ["a", "b"], []]);
    const left = narrowGroups({ ...g, order: ["a", "b"], waves: [["a"], ["b"]], groups: undefined }, components, g.groups);
    expect(left.groups).toEqual(g.groups);
    expect(left.waves).toEqual([["a", "b"], []]);
    const wave = prWavePlan(g, components, 2, ["x"]);
    expect(wave).toMatchObject({ order: ["a", "b"], waves: [["a", "b"]], groups: g.groups, seeds: ["x"], digest: g.digest });
  });
});

describe("core stays lexicon-free here (ws-107)", () => {
  const read = (file: string) => readFileSync(join(import.meta.dirname, file), "utf-8");
  const imports = (source: string) => [...source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]!);

  test("the group modules import no lexicon, and groups.ts names none", () => {
    for (const file of ["groups.ts", "capability.ts", "pr-run.ts", "fan-out-run.ts", "fan-out.ts"]) {
      const from = imports(read(file));
      expect(from.length, file).toBeGreaterThan(0);
      expect(from.filter((m) => /lexicon|^@intentius\/chant-lexicon|lexicons\//.test(m)), file).toEqual([]);
    }
    expect(read("groups.ts")).not.toMatch(/terraform|tofu|choudoufu|cloudformation|\bcfn\b|kubernetes|\baws\b|\bazure\b|\bgcp\b/i);
  });
});
