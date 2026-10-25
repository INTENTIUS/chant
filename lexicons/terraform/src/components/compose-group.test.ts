/**
 * `terraform-apply`'s group methods (#4447, ws-107) over three roots, a -> b
 * -> c, where b reads a's `id` and c reads b's through `stackOutput()` in
 * `vars`. The run is a fake `ComposedRunner`, so nothing here runs a binary;
 * the composition is real, read from roots written to a temporary project.
 * The real binary is `pr-loop.tofu.test.ts`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
  CapabilityRegistry,
  isPlanMovedError,
  type Capability,
  type CapabilityPlan,
  type DeployContext,
  type GroupMember,
} from "@intentius/chant/components/capability";
import { resolveStepInput, type DriverComponent } from "@intentius/chant/components/driver";
import { findComponentGroups, planComponentGroup, runComponentGroup } from "@intentius/chant/components/groups";
import { planFanOut } from "@intentius/chant/components/fan-out";
import { composeChangeSet, isEmptyChangeSet, type ChangeSetPart } from "@intentius/chant/change-set";
import type { TerraformConfig } from "../config";
import type { ComposedRunApply, ComposedRunner, ComposedRunPlan } from "../compose/estate";
import { composeGroup, groupComposition, outsideOutputs, type ComposeGroupDeps, type GroupRunnerOptions } from "./compose-group";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const ROOTS: Record<string, string> = {
  a: 'resource "terraform_data" "x" {\n  input = "a"\n}\n\noutput "id" {\n  value = terraform_data.x.output\n}\n',
  b: 'variable "a_id" {\n  type = string\n}\n\nresource "terraform_data" "x" {\n  input = var.a_id\n}\n\noutput "id" {\n  value = terraform_data.x.output\n}\n',
  c: 'variable "b_id" {\n  type = string\n}\n\nvariable "region" {\n  type = string\n}\n\nresource "terraform_data" "x" {\n  input = "${var.b_id} in ${var.region}"\n}\n\noutput "id" {\n  value = terraform_data.x.output\n}\n',
};

function project(extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-compose-group-"));
  made.push(dir);
  for (const [path, text] of Object.entries({ ...Object.fromEntries(Object.entries(ROOTS).map(([r, t]) => [`roots/${r}/main.tf`, t])), ...extra })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const out = (stack: string, name: string) => ({ stackOutput: { stack, name } });
const terraform = (compose: boolean, roots: TerraformConfig["roots"] = {}): TerraformConfig =>
  ({ binary: "tofu", roots: { a: { dir: "roots/a" }, b: { dir: "roots/b" }, c: { dir: "roots/c" }, ...roots }, ...(compose ? { compose: { enabled: true } } : {}) }) as TerraformConfig;

/** The steps as declared: c also reads `net.region`, a component outside the group. */
const STEPS: Record<string, Record<string, unknown>> = {
  a: { root: "a", vars: {} },
  b: { root: "b", vars: { a_id: out("a", "id") } },
  c: { root: "c", vars: { b_id: out("b", "id"), region: out("net", "region") } },
};
const DEPENDS: Record<string, string[]> = { a: [], b: ["a"], c: ["b", "net"] };

function members(input = true, ctx: Partial<Record<string, Partial<DeployContext>>> = {}): GroupMember<{ root: string; vars?: Record<string, unknown> }>[] {
  return ["a", "b", "c"].map((name) => ({
    component: name,
    step: STEPS[name]!,
    ...(input ? { input: { root: name, vars: resolved(name) } as { root: string; vars?: Record<string, unknown> } } : {}),
    reads: name === "a" ? [] : [{ at: `/vars/${name === "b" ? "a_id" : "b_id"}`, ref: `${name === "b" ? "a" : "b"}.id`, component: name === "b" ? "a" : "b", output: "id" }],
    dependsOn: DEPENDS[name]!,
    ctx: { env: "test", component: name, ...(ctx[name] ?? {}) },
  }));
}
/** A step's vars as core resolves them against the outputs from outside the group: a group-mate's read is `undefined`. */
const resolved = (name: string): Record<string, unknown> => (name === "c" ? { b_id: undefined, region: "eu-west-1" } : name === "b" ? { a_id: undefined } : {});

const part = (root: string, actions: string[] = ["update"]): ChangeSetPart => ({
  member: { member: root, lexicon: "terraform", planner: "tofu", status: "planned", planDigest: `jcs1-sha256:${root}`, holes: [] },
  entries: actions.map((action) => ({ member: root, address: "terraform_data.x", type: "terraform_data", action })) as never,
});

/** A composed plan where a's id is unknown after apply, so b's read of it and, through b, c's are unknown at plan. */
function composedPlan(digest = "sha256:composed-1", over: Partial<ComposedRunPlan> = {}): ComposedRunPlan {
  const member = (root: string, unknownInputs: string[], actions?: string[]) => ({
    member: root,
    planDigest: `jcs1-sha256:${root}`,
    changeSet: part(root, actions),
    outputs: { known: {}, unknown: ["id"] },
    shape: { member: root, entries: [{ logicalId: "terraform_data.x", action: "update" }], unknownInputs },
    slice: {},
    counts: { add: 0, change: 1, destroy: 0, changes: 1, destroys: 0 },
    reads: [],
  });
  return {
    members: { a: member("a", []), b: member("b", ["a.id"], []), c: member("c", ["b.id"]) },
    digest,
    planFile: "/w/composed.tfplan",
    text: "",
    texts: {},
    generated: [],
    counts: { add: 0, change: 3, destroy: 0, changes: 3, destroys: 0 },
    summary: "Plan: 0 to add, 3 to change, 0 to destroy.",
    ...over,
  } as ComposedRunPlan;
}

const appliedAll: ComposedRunApply = {
  ok: true,
  members: {
    a: { status: "applied", planned: 1, done: 1, outputs: { id: "a-new" } },
    b: { status: "applied", planned: 1, done: 1, outputs: { id: "a-new/b" } },
    c: { status: "applied", planned: 1, done: 1, outputs: { id: "a-new/b in eu-west-1" } },
  },
};

/** A fake run: what it was built with, and every call. */
class FakeRun implements ComposedRunner {
  calls: string[] = [];
  constructor(
    readonly o: GroupRunnerOptions,
    private readonly planned: () => ComposedRunPlan,
    private readonly applied: () => ComposedRunApply,
  ) {}
  async plan() {
    this.calls.push(`plan lock=${this.o.lock}`);
    return this.planned();
  }
  async apply() {
    this.calls.push("apply");
    return this.applied();
  }
  async release() {
    this.calls.push("release");
  }
}

let runs: FakeRun[];
let plans: ComposedRunPlan[];
let applied: ComposedRunApply;
beforeEach(() => {
  runs = [];
  plans = [];
  applied = appliedAll;
});

function deps(dir: string, compose = true, extra: Partial<ComposeGroupDeps> = {}): ComposeGroupDeps {
  return {
    project: async () => ({ projectRoot: dir, terraform: terraform(compose) }),
    runner: (o) => {
      const r = new FakeRun(o, () => plans.shift() ?? composedPlan(), () => applied);
      runs.push(r);
      return r;
    },
    exec: async () => ({ code: 0, stdout: "OpenTofu v1.9.0", out: "" }),
    env: {},
    log: () => {},
    ...extra,
  };
}

describe("groupFallback (#4447)", () => {
  test("answers off while terraform.compose is unset, so core records it and the note does not print it", async () => {
    const g = composeGroup(deps(project(), false));
    expect(await g.groupFallback({ env: "test", components: ["a", "b", "c"] }, members(false))).toEqual({ kind: "off", reason: "`terraform.compose` is not enabled" });
  });

  test("takes the group when every member composes", async () => {
    const g = composeGroup(deps(project()));
    expect(await g.groupFallback({ env: "test", components: ["a", "b", "c"] }, members(false))).toBeUndefined();
  });

  test("a member #4438 leaves out is dropped alone with its kind and reason, so core groups the rest (#4419 ruling 1)", async () => {
    const dir = project({ "roots/c/paths.tf": 'locals {\n  here = path.root\n}\n' });
    const g = composeGroup(deps(dir));
    const refused = await g.groupFallback({ env: "test", components: ["a", "b", "c"] }, members(false));
    expect(refused?.kind).toBe("path");
    expect(refused?.drop).toEqual([{ component: "c", kind: "path", reason: expect.stringContaining("`c` uses `path.root` or `path.cwd`") }]);
    // Asked again with the rest, it takes them.
    expect(await g.groupFallback({ env: "test", components: ["a", "b"] }, members(false).filter((m) => m.component !== "c"))).toBeUndefined();
  });

  test("a member under another cloud identity is dropped as identity: each root resolved as its target (#4438, #4332)", async () => {
    const id = (role: string) => ({ plan: { aws: { role: `${role}-plan`, region: "us-east-1", audience: "sts.amazonaws.com" } }, apply: { aws: { role, region: "us-east-1", audience: "sts.amazonaws.com" } } }) as never;
    const asked: string[] = [];
    const g = composeGroup(
      deps(project(), true, {
        identity: async (projectRoot, env) => {
          asked.push(env);
          expect(projectRoot).toBeTruthy();
          return (target) => ((target as readonly string[]).includes("c") ? id("role/other") : id("role/apply"));
        },
      }),
    );
    const refused = await g.groupFallback({ env: "test", components: ["a", "b", "c"] }, members(false));
    expect(asked).toEqual(["test"]);
    expect(refused?.drop).toEqual([
      { component: "c", kind: "identity", reason: "`c` applies under another cloud identity (`ci.identity.cloud`) than `a`, `b`, and one run has one set of credentials" },
    ]);
  });

  describe("a root matches a target glob by its key or its directory (#4332)", () => {
    const id = (role: string) => ({ plan: { aws: { role: `${role}-plan`, region: "us-east-1", audience: "sts.amazonaws.com" } }, apply: { aws: { role, region: "us-east-1", audience: "sts.amazonaws.com" } } }) as never;
    /** The lookup a declaration with these rules gives, in declared order, matching a glob exactly against any name. */
    const lookupOf = (rules: Array<{ glob: string; role: string }>) => (target: string | readonly string[]) => {
      const names = typeof target === "string" ? [target] : target;
      const rule = rules.find((r) => names.includes(r.glob));
      return rule ? id(rule.role) : undefined;
    };
    const asked = async (rules: Array<{ glob: string; role: string }>) => {
      const seen: Array<string | readonly string[]> = [];
      const lookup = lookupOf(rules);
      const g = composeGroup(deps(project(), true, { identity: async () => (t) => (seen.push(t), lookup(t)) }));
      const refused = await g.groupFallback({ env: "test", components: ["a", "b", "c"] }, members(false));
      return { refused, seen };
    };

    test("the lookup gets each root's key and its directory relative to the project", async () => {
      const { seen } = await asked([]);
      expect(seen).toEqual([
        ["a", "roots/a"],
        ["b", "roots/b"],
        ["c", "roots/c"],
      ]);
    });

    test("a glob on the root's key covers it", async () => {
      const { refused } = await asked([{ glob: "c", role: "role/other" }, { glob: "a", role: "role/apply" }, { glob: "b", role: "role/apply" }]);
      expect(refused?.drop?.map((d) => d.component)).toEqual(["c"]);
    });

    test("a glob on the root's directory covers it", async () => {
      const { refused } = await asked([{ glob: "roots/c", role: "role/other" }, { glob: "roots/a", role: "role/apply" }, { glob: "roots/b", role: "role/apply" }]);
      expect(refused?.drop?.map((d) => d.component)).toEqual(["c"]);
    });

    test("when the key and the directory match different rules, the first declared rule wins", async () => {
      // c's key matches the second rule and its directory the first, so the first rule's identity applies to c, the same as a and b.
      const { refused } = await asked([{ glob: "roots/c", role: "role/apply" }, { glob: "c", role: "role/other" }, { glob: "a", role: "role/apply" }, { glob: "b", role: "role/apply" }]);
      expect(refused).toBeUndefined();
    });

    test("a root neither name matches takes no identity, as before", async () => {
      const { refused } = await asked([{ glob: "elsewhere", role: "role/other" }]);
      expect(refused).toBeUndefined();
    });
  });

  test("members under one cloud identity compose", async () => {
    const g = composeGroup(deps(project(), true, { identity: async () => () => ({ plan: { aws: { role: "p", region: "us-east-1", audience: "sts.amazonaws.com" } }, apply: { aws: { role: "a", region: "us-east-1", audience: "sts.amazonaws.com" } } }) as never }));
    expect(await g.groupFallback({ env: "test", components: ["a", "b", "c"] }, members(false))).toBeUndefined();
  });

  test("a dependsOn with no read between two members falls back as order-only", async () => {
    const g = composeGroup(deps(project()));
    const ms = members(false).map((m) => (m.component === "c" ? { ...m, dependsOn: ["a", "b"] } : m));
    expect((await g.groupFallback({ env: "test", components: ["a", "b", "c"] }, ms))?.kind).toBe("order-only");
  });

  test("a member given targets falls back as targets", async () => {
    const g = composeGroup(deps(project()));
    expect((await g.groupFallback({ env: "test", components: ["a", "b", "c"] }, members(false, { b: { targets: ["terraform_data.x"] } })))?.kind).toBe("targets");
  });

  test("a composition of estates on a choudoufu older than the estates release falls back as binary", async () => {
    const live = (e: string, body: string) => `terraform {\n  live {\n    estate = "${e}"\n  }\n}\n\n${body}`;
    const dir = project(Object.fromEntries(Object.entries(ROOTS).map(([r, t]) => [`roots/${r}/main.tf`, live(r, t)])));
    const g = composeGroup({ ...deps(dir), project: async () => ({ projectRoot: dir, terraform: { ...terraform(true), binary: "choudoufu" } }), exec: async () => ({ code: 0, stdout: "choudoufu v0.20.0", out: "" }) });
    const refused = await g.groupFallback({ env: "test", components: ["a", "b", "c"] }, members(false));
    expect(refused?.kind).toBe("binary");
  });
});

describe("planGroup (#4447)", () => {
  test("plans once without locks and releases the run before it returns", async () => {
    const g = composeGroup(deps(project()));
    const planned = await g.planGroup({ env: "test", components: ["a", "b", "c"] }, members());
    expect(runs).toHaveLength(1);
    expect(runs[0]!.calls).toEqual(["plan lock=false", "release"]);
    expect(planned.digest).toBe("sha256:composed-1");
    expect(planned.artifact).toEqual({ digest: "sha256:composed-1", estate: false });
    expect(Object.keys(planned.members)).toEqual(["a", "b", "c"]);
    // Each member's own plan, as `plan` gives one: no slice or counts ride along into the change set.
    expect(planned.members.b).toEqual({
      member: "b",
      planDigest: "jcs1-sha256:b",
      changeSet: part("b", []),
      outputs: { known: {}, unknown: ["id"] },
      shape: { member: "b", entries: [{ logicalId: "terraform_data.x", action: "update" }], unknownInputs: ["a.id"] },
    });
  });

  test("hands the run the vars as written and the outside outputs core resolved", async () => {
    const g = composeGroup(deps(project()));
    await g.planGroup({ env: "test", components: ["a", "b", "c"] }, members());
    expect(runs[0]!.o.vars).toEqual({ a: {}, b: STEPS.b!.vars, c: STEPS.c!.vars });
    expect(runs[0]!.o.componentOutputs).toEqual({ net: { region: "eu-west-1" } });
    expect(runs[0]!.o.composition.order).toEqual(["a", "b", "c"]);
  });

  test("a member that reads an outside output not known yet makes the group wait: holes, nothing planned", async () => {
    const g = composeGroup(deps(project()));
    const ms = members(true, { c: { unresolvedInputs: ["net"] } });
    const planned = await g.planGroup({ env: "test", components: ["a", "b", "c"] }, ms);
    expect(runs).toHaveLength(0);
    expect(planned.members.c!.changeSet!.member.holes).toEqual([{ address: "c", type: "terraform_root", reason: "inputs from net; planned again once they apply" }]);
    expect(planned.members.a!.changeSet!.member.holes[0]!.reason).toBe("inputs from net, read by c in its group; planned again once they apply");
  });

  test("a composed plan that fails throws, so core makes every member plan-failed with its error", async () => {
    plans = [composedPlan("", { error: "the composed plan failed: Error: boom" })];
    const g = composeGroup(deps(project()));
    await expect(g.planGroup({ env: "test", components: ["a", "b", "c"] }, members())).rejects.toThrow("Error: boom");
    expect(runs[0]!.calls).toEqual(["plan lock=false", "release"]);
  });
});

describe("runGroup (#4447)", () => {
  const run = { artifact: { digest: "sha256:composed-1", estate: false }, digest: "sha256:group", plans: {} as Record<string, CapabilityPlan> };

  test("plans again under the locks, applies that same plan, releases, and gives each member's outputs", async () => {
    const g = composeGroup(deps(project()));
    const outcome = await g.runGroup({ env: "test", components: ["a", "b", "c"] }, run, members());
    expect(runs[0]!.calls).toEqual(["plan lock=true", "apply", "release"]);
    expect(outcome.members).toEqual({
      a: { status: "applied", outputs: { id: "a-new" } },
      b: { status: "applied", outputs: { id: "a-new/b" } },
      c: { status: "applied", outputs: { id: "a-new/b in eu-west-1" } },
    });
  });

  test("a plan that moved since the approval applies nothing and throws core's moved-plan mark", async () => {
    plans = [composedPlan("sha256:composed-2")];
    const g = composeGroup(deps(project()));
    const err = await g.runGroup({ env: "test", components: ["a", "b", "c"] }, run, members()).catch((e: unknown) => e);
    expect(isPlanMovedError(err)).toBe(true);
    expect(runs[0]!.calls).toEqual(["plan lock=true", "release"]);
  });

  test("a lock another run holds stops the run before anything applies, and the members say why", async () => {
    plans = [composedPlan("", { error: "b: its state is locked at roots/b/terraform.tfstate.tflock by ci@host", member: "b" })];
    const g = composeGroup(deps(project()));
    const outcome = await g.runGroup({ env: "test", components: ["a", "b", "c"] }, run, members());
    expect(runs[0]!.calls).toEqual(["plan lock=true", "release"]);
    expect(Object.values(outcome.members).map((m) => m.status)).toEqual(["not-started", "not-started", "not-started"]);
    expect(outcome.error).toContain("its state is locked");
  });

  test("a failure in b leaves a applied and says so; a state kept unwritten keeps its lock and says so", async () => {
    applied = {
      ok: false,
      members: {
        a: { status: "applied", planned: 1, done: 1, outputs: { id: "a-new" } },
        b: { status: "failed", planned: 1, done: 0, error: "terraform_data.x: Error: boom", ...({ lockHeld: true, kept: "roots/b/terraform.tfstate.chant-unwritten" } as object) },
        c: { status: "not-started", planned: 1, done: 0 },
      },
      error: "the composed apply failed",
    };
    const g = composeGroup(deps(project()));
    const outcome = await g.runGroup({ env: "test", components: ["a", "b", "c"] }, run, members());
    expect(outcome.members.a).toEqual({ status: "applied", outputs: { id: "a-new" } });
    expect(outcome.members.b!.status).toBe("failed");
    expect(outcome.members.b!.error).toContain("Error: boom");
    expect(outcome.members.b!.error).toContain("kept unwritten at roots/b/terraform.tfstate.chant-unwritten");
    expect(outcome.members.c!.status).toBe("not-started");
  });

  test("a member applied whose part of the state could not be shown reads its outputs from its root", async () => {
    applied = { ok: true, members: { ...appliedAll.members, c: { status: "applied", planned: 1, done: 1 } } };
    const g = composeGroup(deps(project(), true, { outputs: async (root) => ({ id: `${root}-from-state` }) }));
    const outcome = await g.runGroup({ env: "test", components: ["a", "b", "c"] }, run, members());
    expect(outcome.members.c).toEqual({ status: "applied", outputs: { id: "c-from-state" } });
  });
});

describe("through core's group calls (#4447, ws-107)", () => {
  const components: DriverComponent[] = ["a", "b", "c"].map((name) => ({
    name,
    dependsOn: DEPENDS[name]!,
    deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", ...STEPS[name]! }] }],
  }));
  const d: DriverComponent = { name: "d", dependsOn: ["c"], deploy: [{ phase: "Apply", steps: [{ kind: "shell", cmd: "true", reason: "reads c", env: { C_ID: out("c", "id") } }] }] };
  const byName = new Map([...components, d].map((c) => [c.name, c]));
  const group = { capability: "terraform-apply", components: ["a", "b", "c"] };

  function registry(dir: string): CapabilityRegistry {
    const g = composeGroup(deps(dir));
    const cap: Capability<never, unknown> = {
      kind: "terraform-apply",
      run: async () => {
        throw new Error("a group member is never run alone");
      },
      groupFallback: g.groupFallback as never,
      planGroup: g.planGroup as never,
      runGroup: g.runGroup as never,
    };
    return new CapabilityRegistry().register(cap);
  }

  test("core forms the group again without a member terraform-apply drops, and records its fallback (#4419 ruling 1)", async () => {
    const dir = project({ "roots/c/paths.tf": 'locals {\n  here = path.root\n}\n' });
    const net: DriverComponent = { name: "net", deploy: [{ phase: "Apply", steps: [{ kind: "shell", cmd: "true" }] }] };
    const all = [net, ...components];
    const plan = planFanOut({ components: all, changed: ["a", "net"] });
    const found = await findComponentGroups({ components: all, plan, registry: registry(dir), env: "test" });
    expect(found.groups).toEqual([{ capability: "terraform-apply", components: ["a", "b"] }]);
    expect(found.fallbacks).toEqual([{ component: "c", capability: "terraform-apply", kind: "path", reason: expect.stringContaining("`c` uses `path.root` or `path.cwd`") }]);
  });

  test("b's read of a's unknown id is not a hole, and the change set does not look empty though b changes nothing (ruling 4)", async () => {
    const planned = await planComponentGroup({
      group,
      components: byName,
      registry: registry(project()),
      env: "test",
      ctxOf: (component) => ({ env: "test", component }),
      outputs: { net: { region: "eu-west-1" } },
    });
    expect(planned.digest).toBeDefined();
    const parts = planned.plans.flatMap((p) => ("parts" in p ? p.parts : []));
    const b = parts.find((p) => p.member.member === "b")!;
    expect(b.member.holes).toEqual([]);
    expect(b.member.group).toEqual({ digest: planned.digest, reads: ["a.id"] });
    expect(isEmptyChangeSet(composeChangeSet([b]))).toBe(false);
    // Each member's digest has the group folded in, so one approval binds the whole composition.
    expect(b.member.planDigest).not.toBe("jcs1-sha256:b");
  });

  test("a component outside the group that reads c gets c's applied output", async () => {
    const dir = project();
    const reg = registry(dir);
    const planned = await planComponentGroup({
      group,
      components: byName,
      registry: reg,
      env: "test",
      ctxOf: (component) => ({ env: "test", component }),
      outputs: { net: { region: "eu-west-1" } },
    });
    const componentOutputs: Record<string, Record<string, unknown>> = { net: { region: "eu-west-1" } };
    const ran = await runComponentGroup({ group, components: byName, registry: reg, env: "test", ctxOf: (component) => ({ env: "test", component }), run: planned.run, componentOutputs });
    expect(ran.results.map((r) => [r.component, r.status])).toEqual([
      ["a", "ok"],
      ["b", "ok"],
      ["c", "ok"],
    ]);
    const { kind: _kind, ...step } = d.deploy[0]!.steps[0] as Record<string, unknown>;
    expect(resolveStepInput(step, {}, componentOutputs)).toMatchObject({ env: { C_ID: "a-new/b in eu-west-1" } });
  });
});

describe("helpers (#4447)", () => {
  test("outsideOutputs recovers what core resolved from outside the group, and nothing of the group's own", () => {
    expect(outsideOutputs(members())).toEqual({ net: { region: "eu-west-1" } });
  });

  test("groupComposition composes exactly the members, upstreams first", () => {
    const c = groupComposition({ projectRoot: project(), terraform: terraform(true) }, members(false), {});
    expect(c.fallback).toBeUndefined();
    expect(c.order).toEqual(["a", "b", "c"]);
    expect(c.reads.get("b")).toEqual([{ via: "vars", upstream: "a", variable: "a_id", output: "id" }]);
  });
});
