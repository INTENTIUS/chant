/**
 * The composed run (#4444) with a fake binary: three roots with local state,
 * B reading A and C reading B through `terraform_remote_state`. The fake
 * answers `init`, `state pull`, `state push`, `plan`, `show` and `apply` the
 * way tofu does for these roots, so the run's order, its locks, its writes
 * and its release are checked without a binary. `run.tofu.test.ts` runs the
 * same roots on tofu.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { compositionFor, type Composition } from "../compose";
import type { TerraformConfig } from "../config";
import type { BinaryExec, StateFile } from "../state/exec";
import { lockInfo } from "../state/locks";
import { UNWRITTEN_SUFFIX } from "../state/root-states";
import { COMPOSE_DIR, COMPOSE_FILE } from "./root";
import { ComposedRun, type ComposeHookMoment, type ComposedRunOptions } from "./run";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};

const A = 'resource "terraform_data" "x" {\n  input = "a"\n}\n\noutput "id" {\n  value = terraform_data.x.id\n}\n';
const reader = (up: string): string =>
  `data "terraform_remote_state" "${up}" {\n  backend = "local"\n  config = {\n    path = "../${up}/terraform.tfstate"\n  }\n}\n\nresource "terraform_data" "x" {\n  input = data.terraform_remote_state.${up}.outputs.id\n}\n\noutput "id" {\n  value = terraform_data.x.id\n}\n`;

const tf = (name: string, dependsOn: string[] = []): DriverComponent => ({ name, dependsOn, deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: name }] }] });

interface Project {
  dir: string;
  c: Composition;
  terraform: TerraformConfig;
  stateFile: (m: string) => string;
}

function project(): Project {
  const dir = tmp("chant-compose-run-");
  for (const [m, text] of Object.entries({ a: A, b: reader("a"), c: reader("b") })) {
    mkdirSync(join(dir, "roots", m), { recursive: true });
    writeFileSync(join(dir, "roots", m, "main.tf"), text);
  }
  const terraform: TerraformConfig = { binary: "tofu", roots: { a: { dir: "roots/a" }, b: { dir: "roots/b" }, c: { dir: "roots/c" } }, compose: { enabled: true } };
  const c = compositionFor({ projectRoot: dir, terraform, components: [tf("a"), tf("b", ["a"]), tf("c", ["b"])], env: {} });
  return { dir, c, terraform, stateFile: (m) => join(dir, "roots", m, "terraform.tfstate") };
}

/** The root `.tf` files of a project, as text, by path: what a run must put back. */
function rootFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const n of readdirSync(at).sort()) {
      const p = join(at, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tf(\.json)?$|\.tfvars$/.test(n)) out[relative(dir, p)] = readFileSync(p, "utf-8");
    }
  };
  walk(join(dir, "roots"));
  return out;
}

const lockFiles = (dir: string): string[] => ["a", "b", "c"].filter((m) => existsSync(join(dir, "roots", m, "terraform.tfstate.tflock")));

const change = (m: string, actions: string[] = ["create"]) => ({
  address: `module.${m}.terraform_data.x`,
  module_address: `module.${m}`,
  mode: "managed",
  type: "terraform_data",
  name: "x",
  provider_name: "terraform.io/builtin/terraform",
  change: { actions, before: actions[0] === "create" ? null : { id: `${m}-0`, input: m }, after: actions[0] === "create" ? {} : { id: `${m}-0`, input: m }, after_unknown: actions[0] === "create" ? { id: true, input: m !== "a", output: true } : {} },
});

/** The composed plan's `show -json`: each member creates its one resource, unless `noop` names it. */
function composedPlan(noop: string[] = []): unknown {
  const ms = ["a", "b", "c"];
  return {
    format_version: "1.2",
    resource_changes: ms.map((m) => change(m, noop.includes(m) ? ["no-op"] : ["create"])),
    output_changes: Object.fromEntries(ms.map((m) => [`${m}__id`, noop.includes(m) ? { actions: ["no-op"], before: `${m}-0`, after: `${m}-0`, after_unknown: false } : { actions: ["create"], before: null, after_unknown: true }])),
    planned_values: { outputs: Object.fromEntries(ms.filter((m) => noop.includes(m)).map((m) => [`${m}__id`, { value: `${m}-0`, sensitive: false }])), root_module: {} },
  };
}

const resource = (m: string, id: string, input: string, status?: string): StateFile["resources"][number] => ({
  module: `module.${m}`,
  mode: "managed",
  type: "terraform_data",
  name: "x",
  provider: 'provider["terraform.io/builtin/terraform"]',
  instances: [{ schema_version: 0, ...(status ? { status } : {}), attributes: { id, input, output: input } }],
});

/** A member's own state, as `state pull` prints it: its resource in no module. */
const memberState = (m: string, id: string, input: string): StateFile => ({
  version: 4,
  terraform_version: "1.10.0",
  serial: 4,
  lineage: `lineage-${m}`,
  outputs: { id: { value: id, type: "string" } },
  resources: [{ mode: "managed", type: "terraform_data", name: "x", provider: 'provider["terraform.io/builtin/terraform"]', instances: [{ schema_version: 0, attributes: { id, input, output: input } }] }],
});

interface FakeOptions {
  /** The plan `show -json` prints. */
  plan?: unknown;
  /** The member whose resource fails to apply. */
  failing?: string;
  /** Members whose `state push` fails. */
  pushFails?: Set<string>;
  /** The plan exits 1. */
  planFails?: boolean;
}

/** A fake tofu for these roots: every call is recorded as `<dir>: <args>`. */
function fakeTofu(p: Project, o: FakeOptions = {}) {
  const calls: string[] = [];
  const pushed: string[] = [];
  const composeDir = join(p.dir, COMPOSE_DIR);
  const exec: BinaryExec = async (_bin, args, dir) => {
    const who = dir === composeDir ? "compose" : basename(dir);
    // Flags and file paths left out: `b: state push`, `compose: show -json`.
    calls.push(`${who}: ${args.filter((a) => (!a.startsWith("-") || a === "-json") && !a.includes("/")).join(" ")}`);
    const ok = (stdout = "") => ({ code: 0, stdout, out: stdout });
    const [cmd, sub] = args;
    if (cmd === "init") return ok();
    if (cmd === "state" && sub === "pull") return ok(existsSync(join(dir, "terraform.tfstate")) ? readFileSync(join(dir, "terraform.tfstate"), "utf-8") : "");
    if (cmd === "state" && sub === "push") {
      if (o.pushFails?.has(who)) return { code: 1, stdout: "", out: "Error: AccessDenied writing the state" };
      writeFileSync(join(dir, "terraform.tfstate"), readFileSync(args.at(-1)!, "utf-8"));
      pushed.push(who);
      return ok();
    }
    if (cmd === "plan") {
      if (o.planFails) return { code: 1, stdout: "", out: "Error: Unsupported argument" };
      writeFileSync(args.find((a) => a.startsWith("-out="))!.slice(5), "plan");
      return ok("Plan: 3 to add, 0 to change, 0 to destroy.\n");
    }
    if (cmd === "show" && args.includes("-json") && args.at(-1)!.endsWith(".tfplan")) return ok(JSON.stringify(o.plan ?? composedPlan()));
    if (cmd === "show" && args.at(-1)!.endsWith(".tfplan")) return ok("");
    if (cmd === "apply") {
      // What tofu writes: the working state with each member that applied, and one event line per resource.
      const working = JSON.parse(readFileSync(join(composeDir, "terraform.tfstate"), "utf-8")) as StateFile;
      const lines: string[] = [];
      const ids: Record<string, string> = {};
      let stopped = false;
      for (const m of ["a", "b", "c"]) {
        if (stopped) break;
        const addr = `module.${m}.terraform_data.x`;
        if (working.resources.some((r) => r.module === `module.${m}`)) continue;
        lines.push(JSON.stringify({ type: "apply_start", hook: { resource: { addr } } }));
        const input = m === "a" ? "a" : ids[m === "b" ? "a" : "b"]!;
        if (m === o.failing) {
          working.resources.push(resource(m, `${m}-1`, input, "tainted"));
          lines.push(JSON.stringify({ type: "apply_errored", hook: { resource: { addr }, error: "local-exec provisioner error" } }));
          stopped = true;
          continue;
        }
        ids[m] = `${m}-1`;
        working.resources.push(resource(m, ids[m]!, input));
        working.outputs = { ...working.outputs, [`${m}__id`]: { value: ids[m], type: "string" } };
        lines.push(JSON.stringify({ type: "apply_complete", hook: { resource: { addr } } }));
      }
      working.serial += 1;
      writeFileSync(join(composeDir, "terraform.tfstate"), JSON.stringify(working));
      return { code: stopped ? 1 : 0, stdout: lines.join("\n") + "\n", out: lines.join("\n") };
    }
    if (cmd === "show" && args.includes("-json")) {
      const working = JSON.parse(readFileSync(join(composeDir, "terraform.tfstate"), "utf-8")) as StateFile;
      const outputs = Object.fromEntries(Object.entries(working.outputs ?? {}).map(([k, v]) => [k, { value: (v as { value: unknown }).value, sensitive: false }]));
      const child_modules = ["a", "b", "c"].map((m) => ({ address: `module.${m}`, resources: working.resources.filter((r) => r.module === `module.${m}`).map((r) => ({ address: `module.${m}.terraform_data.x`, type: "terraform_data", name: "x" })) }));
      return ok(JSON.stringify({ format_version: "1.0", values: { outputs, root_module: { child_modules } } }));
    }
    return { code: 1, stdout: "", out: `unexpected ${args.join(" ")}` };
  };
  return { exec, calls, pushed };
}

function run(p: Project, exec: BinaryExec, extra: Partial<ComposedRunOptions> = {}): ComposedRun {
  return new ComposedRun({ projectRoot: p.dir, composition: p.c, terraform: p.terraform, binary: { path: "tofu" }, env: {}, work: tmp("chant-compose-work-"), lock: true, runId: "run-1", exec, retryDelays: [0, 0], ...extra });
}

describe("ComposedRun's init takes the root's backend-config files (chant#4459)", () => {
  test("each member's init gets -backend-config=<file> for each file, then its pairs, run in the member's directory", async () => {
    const p = project();
    writeFileSync(join(p.dir, "roots", "a", "backend.hcl"), 'path = "terraform.tfstate"\n');
    const terraform: TerraformConfig = { ...p.terraform, roots: { ...p.terraform.roots, a: { dir: "roots/a", backendConfigFiles: ["backend.hcl"], backendConfig: { workspace_dir: "ws" } } } };
    const fake = fakeTofu(p);
    const inits: Array<[string, string[]]> = [];
    const exec: BinaryExec = async (bin, args, dir, env) => {
      if (args[0] === "init") inits.push([relative(p.dir, dir), args]);
      return fake.exec(bin, args, dir, env);
    };
    const r = run(p, exec, { terraform });
    try {
      await r.plan();
    } finally {
      await r.release();
    }
    expect(inits.find(([d]) => d === join("roots", "a"))![1]).toEqual(["init", "-input=false", "-no-color", "-backend-config=backend.hcl", "-backend-config=workspace_dir=ws"]);
    expect(inits.find(([d]) => d === join("roots", "b"))![1]).toEqual(["init", "-input=false", "-no-color"]);
  });
});

describe("ComposedRun", () => {
  test("one plan names B's and C's reads unknown, one digest covers all three, and one apply writes each state back to its own root, upstreams first", async () => {
    const p = project();
    expect(p.c.order).toEqual(["a", "b", "c"]);
    const before = rootFiles(p.dir);
    const fake = fakeTofu(p);
    const r = run(p, fake.exec);
    try {
      const plan = await r.plan();
      expect(plan.error).toBeUndefined();
      expect(Object.keys(plan.members)).toEqual(["a", "b", "c"]);
      expect(plan.members.b!.reads).toEqual([{ upstream: "a", via: "remote-state", name: "a", outputs: ["id"], unknown: ["id"] }]);
      expect(plan.members.b!.shape.unknownInputs).toEqual(["a.id"]);
      expect(plan.unknownReads).toEqual(["b", "c"]);
      expect(plan.digest).toMatch(/\S/);
      expect(plan.generated.map(([f]) => f)).toEqual([`${COMPOSE_DIR}/main.tf`, `roots/a/${COMPOSE_FILE}`, `roots/b/${COMPOSE_FILE}`, `roots/c/${COMPOSE_FILE}`]);
      // Between the plan and the apply the roots are as they were, and every lock is held.
      expect(rootFiles(p.dir)).toEqual(before);
      expect(r.held()).toEqual(["a", "b", "c"]);

      const applied = await r.apply();
      expect(applied.ok).toBe(true);
      expect(Object.fromEntries(Object.entries(applied.members).map(([m, o]) => [m, [o.status, o.state]]))).toEqual({ a: ["applied", "written"], b: ["applied", "written"], c: ["applied", "written"] });
      expect(applied.settled).toEqual(["a", "b", "c"]);
      expect(fake.pushed).toEqual(["a", "b", "c"]);
      const a = JSON.parse(readFileSync(p.stateFile("a"), "utf-8")) as StateFile;
      const b = JSON.parse(readFileSync(p.stateFile("b"), "utf-8")) as StateFile;
      expect(a.resources[0]).not.toHaveProperty("module");
      expect((b.resources[0]!.instances![0] as { attributes: { input: string } }).attributes.input).toBe("a-1");
      expect(b.outputs).toEqual({ id: { value: "b-1", type: "string" } });
      expect(applied.members.b!.outputs).toEqual({ id: "b-1" });
      expect(applied.shown.b).toMatchObject({ values: { outputs: { id: { value: "b-1" } } } });
      // Each lock is released once its state is written.
      expect(r.held()).toEqual([]);
      expect(applied.members.c!.outputs).toEqual({ id: "c-1" });
      expect([...applied.members.b!.resources!.keys()]).toEqual(["terraform_data.x"]);
    } finally {
      await r.release();
    }
    expect(r.heldOnPurpose()).toEqual([]);
    expect(existsSync(join(p.dir, COMPOSE_DIR))).toBe(false);
    expect(rootFiles(p.dir)).toEqual(before);
  });

  test("B fails: A is applied and written, B is failed with what applied of it written, C is not-started and not written", async () => {
    const p = project();
    const fake = fakeTofu(p, { failing: "b" });
    const r = run(p, fake.exec);
    try {
      await r.plan();
      const applied = await r.apply();
      expect(applied.ok).toBe(false);
      expect(applied.members.a).toMatchObject({ status: "applied", state: "written", done: 1, planned: 1 });
      expect(applied.members.b).toMatchObject({ status: "failed", state: "written", done: 0, planned: 1, error: expect.stringContaining("terraform_data.x: local-exec provisioner error") });
      expect(applied.members.c).toMatchObject({ status: "not-started", state: "unchanged", done: 0 });
      expect(applied.members.b!.outputs).toBeUndefined();
      expect(fake.pushed).toEqual(["a", "b"]);
      const b = JSON.parse(readFileSync(p.stateFile("b"), "utf-8")) as StateFile;
      expect((b.resources[0]!.instances![0] as { status: string }).status).toBe("tainted");
      expect(existsSync(p.stateFile("c"))).toBe(false);
      expect(applied.settled).toEqual(["a", "b", "c"]);
    } finally {
      await r.release();
    }
    expect(lockFiles(p.dir)).toEqual([]);
  });

  test("a lock held by another run stops plan() before any state is pulled, names the holder, and releases what it took", async () => {
    const p = project();
    writeFileSync(`${p.stateFile("b")}.tflock`, lockInfo("x", "2026-10-25T12:00:00.000Z", { operation: "OperationTypeApply", info: "" }, "someone@ci-runner"));
    const before = rootFiles(p.dir);
    const fake = fakeTofu(p);
    const r = run(p, fake.exec);
    const plan = await r.plan();
    expect(plan.stage).toBe("lock");
    expect(plan.member).toBe("b");
    expect(plan.error).toContain("someone@ci-runner");
    expect(plan.members).toEqual({});
    expect(fake.calls.some((c) => c.includes("state pull"))).toBe(false);
    expect(fake.calls.some((c) => c.startsWith("compose:"))).toBe(false);
    // The other run's lock is left; this run's are gone.
    expect(lockFiles(p.dir)).toEqual(["b"]);
    expect(r.held()).toEqual([]);
    expect(rootFiles(p.dir)).toEqual(before);
    expect(existsSync(join(p.dir, COMPOSE_DIR))).toBe(false);
  });

  test("a write that fails every retry keeps the state unwritten and holds that lock; the next plan() writes it first", async () => {
    const p = project();
    const first = fakeTofu(p, { pushFails: new Set(["b"]) });
    const r1 = run(p, first.exec, { runId: "run-1" });
    let kept: string | undefined;
    try {
      await r1.plan();
      const applied = await r1.apply();
      expect(applied.ok).toBe(false);
      expect(applied.members.b).toMatchObject({ status: "applied", state: "not-written", lockHeld: true, kept: `${p.stateFile("b")}${UNWRITTEN_SUFFIX}` });
      expect(applied.members.b!.error).toContain("state push failed");
      expect(applied.settled).toEqual(["a", "c"]);
      // Three tries: the first and two retries.
      expect(first.calls.filter((c) => c === "b: state push").length).toBe(3);
      kept = readFileSync(`${p.stateFile("b")}${UNWRITTEN_SUFFIX}`, "utf-8");
    } finally {
      await r1.release();
    }
    expect(r1.heldOnPurpose()).toEqual(["b"]);
    expect(lockFiles(p.dir)).toEqual(["b"]);
    expect(existsSync(p.stateFile("b"))).toBe(false);

    const second = fakeTofu(p);
    const r2 = run(p, second.exec, { runId: "run-2" });
    try {
      expect((await r2.plan()).error).toBeUndefined();
      const push = second.calls.indexOf("b: state push");
      expect(push).toBeGreaterThan(-1);
      expect(push).toBeLessThan(second.calls.findIndex((c) => c.includes("state pull")));
      expect(JSON.parse(readFileSync(p.stateFile("b"), "utf-8"))).toEqual(JSON.parse(kept!));
      expect(existsSync(`${p.stateFile("b")}${UNWRITTEN_SUFFIX}`)).toBe(false);
      expect(r2.held()).toEqual(["a", "b", "c"]);
    } finally {
      await r2.release();
    }
    expect(r2.heldOnPurpose()).toEqual([]);
    expect(lockFiles(p.dir)).toEqual([]);
  });

  test("a root that planned no change, or whose state came back as pulled, is not written", async () => {
    const p = project();
    // c already has a state and plans no change; b plans a change the apply never reaches.
    writeFileSync(p.stateFile("c"), JSON.stringify(memberState("c", "c-0", "b-0")));
    const fake = fakeTofu(p, { plan: composedPlan(["c"]), failing: "a" });
    const r = run(p, fake.exec);
    try {
      await r.plan();
      const applied = await r.apply();
      expect(applied.members.a).toMatchObject({ status: "failed", state: "written" });
      expect(applied.members.b).toMatchObject({ status: "not-started", state: "unchanged" });
      expect(applied.members.c).toMatchObject({ status: "no-changes", state: "unchanged" });
      expect(fake.pushed).toEqual(["a"]);
      expect(JSON.parse(readFileSync(p.stateFile("c"), "utf-8"))).toEqual(memberState("c", "c-0", "b-0"));
      expect(r.held()).toEqual([]);
    } finally {
      await r.release();
    }
  });

  test("after release() no lock is held, every root file is as it was and the compose directory is gone, after a thrown error too", async () => {
    const p = project();
    const before = rootFiles(p.dir);
    const fake = fakeTofu(p, { planFails: true });
    const r = run(p, fake.exec);
    const plan = await r.plan();
    expect(plan).toMatchObject({ stage: "plan", error: "the composed plan failed: Error: Unsupported argument", digest: "" });
    expect(fake.calls).toContain("compose: plan");
    expect(lockFiles(p.dir)).toEqual([]);
    expect(rootFiles(p.dir)).toEqual(before);
    for (const m of ["a", "b", "c"]) expect(existsSync(join(p.dir, "roots", m, COMPOSE_FILE))).toBe(false);
    expect(existsSync(join(p.dir, COMPOSE_DIR))).toBe(false);
    // A second release changes nothing.
    await r.release();
    expect(r.heldOnPurpose()).toEqual([]);
  });

  test("hooks run for each member at the moments of a member applied alone", async () => {
    const p = project();
    const seen: string[] = [];
    const hook = async (member: string, moment: ComposeHookMoment, planFile?: string): Promise<undefined> => {
      seen.push(`${member} ${moment}${planFile ? " (plan)" : ""}`);
      return undefined;
    };
    const r = run(p, fakeTofu(p).exec, { hook });
    try {
      await r.plan();
      await r.apply();
    } finally {
      await r.release();
    }
    for (const m of ["a", "b", "c"]) {
      expect(seen.filter((s) => s.startsWith(`${m} `))).toEqual([`${m} before-observe`, `${m} before-plan`, `${m} after-plan (plan)`, `${m} before-apply (plan)`, `${m} after-apply`]);
    }
  });

  test("a hook that fails stops the plan and names the member", async () => {
    const p = project();
    const fake = fakeTofu(p);
    const hook = async (member: string, moment: ComposeHookMoment): Promise<string | undefined> => (member === "b" && moment === "before-plan" ? "policy check refused" : undefined);
    const r = run(p, fake.exec, { hook });
    const plan = await r.plan();
    expect(plan).toMatchObject({ stage: "hook", member: "b", error: "b: a before-plan hook failed: policy check refused" });
    expect(fake.calls.some((c) => c.startsWith("compose:"))).toBe(false);
    expect(lockFiles(p.dir)).toEqual([]);
  });

  test("a hook that throws before the apply leaves every member not-started and writes nothing", async () => {
    const p = project();
    const fake = fakeTofu(p);
    const hook = async (member: string, moment: ComposeHookMoment): Promise<undefined> => {
      if (member === "c" && moment === "before-apply") throw new Error("change window closed");
      return undefined;
    };
    const r = run(p, fake.exec, { hook });
    try {
      await r.plan();
      const applied = await r.apply();
      expect(applied.ok).toBe(false);
      expect(applied.error).toContain("before-apply hook of c failed");
      expect(applied.members.c).toMatchObject({ status: "not-started", state: "unchanged", error: "change window closed" });
      expect(fake.calls.some((c) => c.startsWith("compose: apply"))).toBe(false);
      expect(fake.pushed).toEqual([]);
    } finally {
      await r.release();
    }
    expect(lockFiles(p.dir)).toEqual([]);
  });

  test("a plan the gate does not let through is released and writes nothing", async () => {
    const p = project();
    const fake = fakeTofu(p);
    const r = run(p, fake.exec);
    await r.plan();
    await r.release();
    expect(fake.pushed).toEqual([]);
    expect(lockFiles(p.dir)).toEqual([]);
    expect(existsSync(join(p.dir, COMPOSE_DIR))).toBe(false);
    await expect(r.apply()).rejects.toThrow("released");
  });
});
