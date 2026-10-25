/**
 * The working state of a composed run (#4442): merged from each member's
 * pulled state, split back by module address. Fixtures are `state pull`
 * output in `../__fixtures__/compose`, and the working state an apply of the
 * three-module plan left (net's tags changed, app and edge as they were).
 * The lineage and serial cases are carried over from terragucci's rules
 * (`migrate.test.ts` and `compose.ts` at c493e0e).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { Composition } from "../compose";
import type { StateFile, StateResource } from "../state/exec";
import { COMPOSE_LINEAGE, derivedLineage, mergeStates, splitState, splitStates } from "./state-merge";

const FIX = join(import.meta.dirname, "..", "__fixtures__", "compose");
const state = (name: string): StateFile => JSON.parse(readFileSync(join(FIX, name), "utf-8")) as StateFile;

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

type StateComposition = Pick<Composition, "order" | "modules" | "dirs" | "roots">;
const composition = (members: string[], dirs: Record<string, string> = {}): StateComposition => ({
  order: members,
  modules: new Map(members.map((m) => [m, m])),
  dirs: new Map(Object.entries(dirs)),
  roots: new Map(members.map((m) => [m, `roots/${m}`])),
});

const c = composition(["net", "app", "edge"]);
const pulled = new Map<string, StateFile | null>([
  ["net", state("state-net.json")],
  ["app", state("state-app.json")],
  ["edge", state("state-edge.json")],
]);

describe("mergeStates", () => {
  const working = mergeStates(c, pulled);

  test("each member's resources under module.<m>, a nested module under it, outputs as <m>__<name>", () => {
    expect(working.resources.map((r) => `${r.module}.${r.type}.${r.name}`)).toEqual([
      "module.net.terraform_data.vpc",
      "module.app.module.logs.terraform_data.group",
      "module.app.terraform_data.service",
      "module.edge.terraform_data.dns",
    ]);
    expect(Object.keys(working.outputs ?? {})).toEqual(["net__vpc_id", "app__service_id", "edge__name"]);
    expect(working.check_results).toBeNull();
  });

  test("serial 1 and a lineage derived from the members in order", () => {
    expect(working.serial).toBe(1);
    expect(working.lineage).toBe(derivedLineage(COMPOSE_LINEAGE, "net", "app", "edge"));
    expect(working.lineage).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("the highest terraform_version pulled", () => {
    const newer = { ...state("state-edge.json"), terraform_version: "1.11.0" };
    expect(mergeStates(c, new Map([...pulled, ["edge", newer]])).terraform_version).toBe("1.11.0");
  });

  test("a resource whose root configures its provider names the module's provider configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-compose-state-"));
    made.push(dir);
    mkdirSync(join(dir, "net"));
    writeFileSync(join(dir, "net", "providers.tf"), 'provider "aws" {\n  region = "us-east-1"\n}\n');
    const res: StateResource = { mode: "managed", type: "aws_vpc", name: "main", provider: 'provider["registry.terraform.io/hashicorp/aws"]', instances: [] };
    const one = composition(["net", "app"], { net: join(dir, "net"), app: join(dir, "missing") });
    const s = (r: StateResource): StateFile => ({ version: 4, serial: 1, lineage: "L", resources: [r] });
    const merged = mergeStates(one, new Map([["net", s(res)], ["app", s(res)]]));
    expect(merged.resources.map((r) => r.provider)).toEqual(['module.net.provider["registry.terraform.io/hashicorp/aws"]', 'provider["registry.terraform.io/hashicorp/aws"]']);
    const back = splitState(merged, one, "net", s(res));
    expect(back.state.resources[0]!.provider).toBe(res.provider);
    expect(back.same).toBe(true);
  });
});

describe("splitState", () => {
  test("with no apply, every member's state comes back as pulled: same", () => {
    const working = mergeStates(c, pulled);
    for (const [m, s] of splitStates(working, c, pulled)) {
      expect(s.same, m).toBe(true);
      expect(s.state.resources).toEqual(pulled.get(m)!.resources.map((r) => expect.objectContaining(r)));
      expect(s.state.outputs).toEqual(pulled.get(m)!.outputs);
    }
  });

  test("after an apply that changed net, net alone comes back changed", () => {
    const split = splitStates(state("working-after-apply.json"), c, pulled);
    expect(split.get("net")!.same).toBe(false);
    expect(split.get("app")!.same).toBe(true);
    expect(split.get("edge")!.same).toBe(true);
    const net = split.get("net")!.state;
    expect((net.resources[0]!.instances![0] as any).attributes.input.value.name).toBe("core-v2");
    expect(net.resources[0]!.module).toBeUndefined();
    expect(split.get("app")!.state.resources.find((r) => r.name === "group")!.module).toBe("module.logs");
  });

  test("a split state keeps its pulled lineage and takes the pulled serial plus one", () => {
    const split = splitStates(state("working-after-apply.json"), c, pulled);
    expect(split.get("net")!.state).toMatchObject({ version: 4, lineage: "2b1f6c0a-6a1e-4c55-9f3d-7e0a1b2c3d4e", serial: 8, terraform_version: "1.10.5", check_results: null });
    expect(split.get("app")!.state).toMatchObject({ lineage: "8d4e2f1a-3b5c-4d6e-9f7a-1c2b3d4e5f60", serial: 4 });
    expect(split.get("edge")!.state).toMatchObject({ lineage: "c0ffee00-1234-4abc-8def-0123456789ab", serial: 13 });
  });

  test("a member with no state gets serial 1 and a lineage derived from the composed run and its root", () => {
    const fresh = new Map<string, StateFile | null>([...pulled, ["app", null]]);
    const split = splitStates(state("working-after-apply.json"), c, fresh);
    expect(split.get("app")!.state).toMatchObject({ serial: 1, lineage: derivedLineage(COMPOSE_LINEAGE, "roots/app") });
    expect(split.get("app")!.same).toBe(false);
    expect(derivedLineage(COMPOSE_LINEAGE, "roots/app")).toBe(derivedLineage(COMPOSE_LINEAGE, "roots/app"));
    expect(derivedLineage(COMPOSE_LINEAGE, "roots/app")).not.toBe(derivedLineage(COMPOSE_LINEAGE, "roots/edge"));
  });

  test("a member with no state that the apply left nothing in is same", () => {
    const empty = composition(["net", "new"]);
    const working = mergeStates(empty, new Map([["net", state("state-net.json")], ["new", null]]));
    expect(splitState(working, empty, "new", null)).toMatchObject({ same: true, state: { resources: [], outputs: {}, serial: 1 } });
  });

  test("a module whose name starts with another's takes only its own resources", () => {
    const two = composition(["app", "app2"]);
    const working = mergeStates(two, new Map([["app", state("state-app.json")], ["app2", state("state-edge.json")]]));
    expect(splitState(working, two, "app", state("state-app.json")).state.resources.map((r) => r.name)).toEqual(["group", "service"]);
    expect(splitState(working, two, "app2", state("state-edge.json")).same).toBe(true);
  });
});
