/**
 * terraform Op activity tests (#2086).
 *
 * Nothing here runs terraform. `node:child_process` is mocked the way
 * `lexicons/k3s/src/op/activities/k3s.test.ts` mocks it — the exec export
 * carries a `nodejs.util.promisify.custom` implementation, which is what
 * `promisify(exec)` picks up, so every call the activities make lands in
 * `execCalls` with its exact command string and options.
 *
 * The project config is real, not mocked: each test writes a
 * `chant.config.json` into a temp directory and passes it as `cwd`, so the
 * `terraform.roots` lookup, the project-root-relative `dir` resolution and the
 * `binary` choice are all exercised on the path production takes.
 */

import { describe, test, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  terraformInit,
  terraformPlan,
  terraformApply,
  terraformShow,
  choudoufuLivePlan,
  terraformInitCommand,
  terraformPlanCommand,
  terraformApplyCommand,
  terraformShowCommand,
  terraformEnvironment,
  terraformBinary,
  countPlanChanges,
  terraformPlanChangeSet,
  terraformPlanDigest,
  quoteArg,
  DEFAULT_PLAN_FILE,
  __resetChoudoufuVersionCheckForTests,
} from "./terraform";

// ── The child-process stub ──────────────────────────────────────────────────

interface ExecCall {
  cmd: string;
  opts: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal };
}

const execCalls: ExecCall[] = [];

/** cmd substring -> what the stub does when it sees it. */
type Reply = { stdout: string; stderr: string } | Error;
let replies: Array<{ match: string; reply: Reply }> = [];
/** When set, every call hangs until its signal aborts (the cancellation test). */
let hangUntilAborted = false;

/** Build the Error `promisify(exec)` rejects with for a non-zero exit. */
function execError(code: number, stderr: string, stdout = ""): Error & { code: number; stdout: string; stderr: string } {
  return Object.assign(new Error(`Command failed (exit ${code})`), { code, stdout, stderr });
}

// Partial, via `importOriginal`: `@intentius/chant/op` reaches the base
// activities now (chant #2114), and modules on that path promisify
// `execFile` at load. A wholesale replacement of node:child_process would
// make them fail to import rather than fail an assertion.
vi.mock("node:child_process", async (importOriginal) => {
  const custom = Symbol.for("nodejs.util.promisify.custom");
  const exec = ((_cmd: string, _opts: unknown, cb?: (...a: unknown[]) => void) => {
    cb?.(new Error("unmocked exec path"));
  }) as unknown as Record<symbol, unknown>;
  exec[custom] = async (cmd: string, opts?: ExecCall["opts"]) => {
    execCalls.push({ cmd, opts: opts ?? {} });
    if (hangUntilAborted) {
      const signal = opts?.signal;
      return new Promise((_resolve, reject) => {
        if (!signal) return; // hangs forever; no test does this
        const fail = (): void =>
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      });
    }
    for (const { match, reply } of replies) {
      if (cmd.includes(match)) {
        if (reply instanceof Error) throw reply;
        return reply;
      }
    }
    return { stdout: "", stderr: "" };
  };
  return { ...(await importOriginal<typeof import("node:child_process")>()), exec };
});

// ── A real project config to resolve roots against ──────────────────────────

const workspaces: string[] = [];

/** Write a throwaway project with a `terraform` namespace; returns its root. */
function project(namespace: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-tf-op-"));
  workspaces.push(dir);
  mkdirSync(join(dir, "infra"), { recursive: true });
  writeFileSync(
    join(dir, "chant.config.json"),
    JSON.stringify({ lexicons: ["terraform"], terraform: namespace }, null, 2),
  );
  return dir;
}

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  execCalls.length = 0;
  replies = [];
  hangUntilAborted = false;
});

/** A plan JSON with one create, one update and one replace. */
const PLAN_JSON = JSON.stringify({
  format_version: "1.2",
  resource_changes: [
    { address: "null_resource.a", change: { actions: ["create"] } },
    { address: "null_resource.b", change: { actions: ["update"] } },
    { address: "null_resource.c", change: { actions: ["delete", "create"] } },
    { address: "null_resource.d", change: { actions: ["no-op"] } },
  ],
});

/** Wire the two `show` calls every plan makes. */
function showReplies(json = PLAN_JSON, text = "Plan: 2 to add, 1 to change, 1 to destroy.\n"): void {
  replies.push({ match: "show -json", reply: { stdout: json, stderr: "" } });
  replies.push({ match: "show -no-color", reply: { stdout: text, stderr: "" } });
}

// ── Pure builders ───────────────────────────────────────────────────────────

describe("terraformBinary (#2086)", () => {
  test("defaults to terraform, honours an explicit tofu", () => {
    expect(terraformBinary(undefined)).toBe("terraform");
    expect(terraformBinary({ roots: {} })).toBe("terraform");
    expect(terraformBinary({ binary: "tofu", roots: {} })).toBe("tofu");
  });
});

describe("terraformEnvironment — TF_IN_AUTOMATION on every invocation (#2086)", () => {
  test("always sets TF_IN_AUTOMATION=1", () => {
    expect(terraformEnvironment()).toEqual({ TF_IN_AUTOMATION: "1" });
  });

  test("a root's workspace is selected through TF_WORKSPACE", () => {
    expect(terraformEnvironment({ workspace: "prod" })).toEqual({
      TF_IN_AUTOMATION: "1",
      TF_WORKSPACE: "prod",
    });
  });

  test("no workspace means no TF_WORKSPACE key at all", () => {
    expect(terraformEnvironment({}).TF_WORKSPACE).toBeUndefined();
  });
});

describe("terraformInitCommand (#2086)", () => {
  test("carries -input=false", () => {
    expect(terraformInitCommand({ binary: "terraform" })).toBe("terraform init -input=false");
  });

  test("backendConfig becomes -backend-config=k=v flags, in declaration order", () => {
    expect(
      terraformInitCommand({
        binary: "tofu",
        backendConfig: { bucket: "tf-state", key: "app/terraform.tfstate" },
      }),
    ).toBe("tofu init -input=false -backend-config=bucket=tf-state -backend-config=key=app/terraform.tfstate");
  });

  test("-upgrade and -reconfigure are opt-in", () => {
    expect(terraformInitCommand({ binary: "terraform", upgrade: true, reconfigure: true })).toBe(
      "terraform init -input=false -upgrade -reconfigure",
    );
  });

  test("a backend-config value with a space is quoted", () => {
    expect(terraformInitCommand({ binary: "terraform", backendConfig: { path: "my state.tfstate" } })).toBe(
      "terraform init -input=false -backend-config='path=my state.tfstate'",
    );
  });
});

describe("terraformPlanCommand (#2086)", () => {
  test("carries -input=false, -detailed-exitcode and -out", () => {
    expect(terraformPlanCommand({ binary: "terraform", planFile: "chant.tfplan" })).toBe(
      "terraform plan -input=false -detailed-exitcode -out=chant.tfplan",
    );
  });

  test("varFiles become -var-file flags, in order", () => {
    expect(
      terraformPlanCommand({ binary: "terraform", planFile: "p.tfplan", varFiles: ["base.tfvars", "prod.tfvars"] }),
    ).toBe("terraform plan -input=false -detailed-exitcode -var-file=base.tfvars -var-file=prod.tfvars -out=p.tfplan");
  });

  test("-destroy is opt-in", () => {
    expect(terraformPlanCommand({ binary: "tofu", planFile: "p", destroy: true })).toContain(" -destroy ");
  });
});

describe("terraformApplyCommand (#2086)", () => {
  test("carries -input=false and applies the saved plan positionally", () => {
    expect(terraformApplyCommand({ binary: "terraform", planFile: "chant.tfplan" })).toBe(
      "terraform apply -input=false chant.tfplan",
    );
  });
});

describe("terraformShowCommand (#2086)", () => {
  test("json and text forms, over a plan file or over state", () => {
    expect(terraformShowCommand({ binary: "terraform", json: true, planFile: "chant.tfplan" })).toBe(
      "terraform show -json chant.tfplan",
    );
    expect(terraformShowCommand({ binary: "terraform", json: false, planFile: "chant.tfplan" })).toBe(
      "terraform show -no-color chant.tfplan",
    );
    expect(terraformShowCommand({ binary: "tofu", json: true })).toBe("tofu show -json");
  });

  test("no -input flag: `terraform show` rejects it with a flag-parse error", () => {
    // Every other command here carries -input=false. `show` is the exception
    // upstream forces: `terraform show -input=false` fails with "flag provided
    // but not defined: -input". Automation for show rests on TF_IN_AUTOMATION,
    // which terraformEnvironment sets for every call.
    expect(terraformShowCommand({ binary: "terraform", json: true })).not.toContain("-input");
  });
});

describe("quoteArg (#2086)", () => {
  test("leaves ordinary paths and k=v pairs alone", () => {
    expect(quoteArg("prod.tfvars")).toBe("prod.tfvars");
    expect(quoteArg("bucket=tf-state")).toBe("bucket=tf-state");
    expect(quoteArg("./vars/prod.tfvars")).toBe("./vars/prod.tfvars");
  });

  test("quotes anything with a space or a shell metacharacter", () => {
    expect(quoteArg("my vars.tfvars")).toBe("'my vars.tfvars'");
    expect(quoteArg("a;rm -rf /")).toBe("'a;rm -rf /'");
    expect(quoteArg("it's.tfvars")).toBe(`'it'\\''s.tfvars'`);
  });
});

describe("countPlanChanges (#2086)", () => {
  test("a replace counts as one add and one destroy, as terraform reports it", () => {
    expect(countPlanChanges(JSON.parse(PLAN_JSON))).toEqual({ adds: 2, changes: 1, destroys: 1 });
  });

  test("a plan with no resource_changes counts zero", () => {
    expect(countPlanChanges({ format_version: "1.2" })).toEqual({ adds: 0, changes: 0, destroys: 0 });
    expect(countPlanChanges(null)).toEqual({ adds: 0, changes: 0, destroys: 0 });
  });
});

/**
 * #2300. The digest is what a `TerraformApplyOp` gate binds its approval to,
 * so what it covers and what it ignores is the contract an approver is
 * relying on. Taken over the `show -json` rendering rather than the plan
 * file's bytes: two `plan -out` runs over an unchanged root write different
 * bytes and the same plan.
 */
describe("terraformPlanDigest (#2300)", () => {
  test("the same change set digests the same across renderings that differ only in noise", () => {
    const a = JSON.parse(PLAN_JSON) as Record<string, unknown>;
    const b = {
      ...JSON.parse(PLAN_JSON) as Record<string, unknown>,
      format_version: "1.3",
      terraform_version: "1.9.0",
      timestamp: "2026-09-09T12:00:00Z",
      prior_state: { anything: true },
      configuration: { root_module: { resources: ["moved around"] } },
      checks: [],
    };
    expect(terraformPlanDigest(b)).toBe(terraformPlanDigest(a));
  });

  test("a renamed resource changes it — the exact edit choudoufu#1026 made between approve and re-run", () => {
    const before = JSON.parse(PLAN_JSON) as { resource_changes: { address: string }[] };
    const after = JSON.parse(PLAN_JSON) as { resource_changes: { address: string }[] };
    after.resource_changes[0].address = "null_resource.renamed";
    expect(terraformPlanDigest(after)).not.toBe(terraformPlanDigest(before));
  });

  test("a changed planned value changes it, even at the same addresses and actions", () => {
    const before = { resource_changes: [{ address: "null_resource.a", change: { actions: ["create"], after: { triggers: { v: "1" } } } }] };
    const after = { resource_changes: [{ address: "null_resource.a", change: { actions: ["create"], after: { triggers: { v: "2" } } } }] };
    expect(terraformPlanDigest(after)).not.toBe(terraformPlanDigest(before));
  });

  test("a changed action changes it — create is not destroy", () => {
    const create = { resource_changes: [{ address: "null_resource.a", change: { actions: ["create"] } }] };
    const destroy = { resource_changes: [{ address: "null_resource.a", change: { actions: ["delete"] } }] };
    expect(terraformPlanDigest(destroy)).not.toBe(terraformPlanDigest(create));
  });

  test("output changes are part of the plan", () => {
    const withOutput = { resource_changes: [], output_changes: { url: { actions: ["create"], after: "https://a" } } };
    const withOther = { resource_changes: [], output_changes: { url: { actions: ["create"], after: "https://b" } } };
    expect(terraformPlanDigest(withOther)).not.toBe(terraformPlanDigest(withOutput));
  });

  test("the emitter's iteration order does not change the answer", () => {
    const one = { resource_changes: [{ address: "b", change: { actions: ["create"] } }, { address: "a", change: { actions: ["create"] } }] };
    const two = { resource_changes: [{ address: "a", change: { actions: ["create"] } }, { address: "b", change: { actions: ["create"] } }] };
    expect(terraformPlanDigest(one)).toBe(terraformPlanDigest(two));
  });

  test("a plan with no resource_changes still digests, rather than throwing", () => {
    expect(terraformPlanDigest({ format_version: "1.2" })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(terraformPlanDigest(null)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("the change set keeps the fields an approver reads and drops the rest", () => {
    const { resourceChanges } = terraformPlanChangeSet({
      timestamp: "2026-09-09T12:00:00Z",
      resource_changes: [{
        address: "null_resource.a", mode: "managed", type: "null_resource", name: "a",
        provider_name: "registry.terraform.io/hashicorp/null",
        change: { actions: ["create"], before: null, after: { x: 1 }, after_unknown: {}, before_sensitive: false },
      }],
    });
    expect(resourceChanges[0]).toMatchObject({ address: "null_resource.a", actions: ["create"], after: { x: 1 } });
    expect(resourceChanges[0]).not.toHaveProperty("before_sensitive");
    expect(resourceChanges[0]).not.toHaveProperty("change");
  });
});

// ── Root resolution ─────────────────────────────────────────────────────────

describe("root resolution against terraform.roots (#2086)", () => {
  test("dir resolves against the project root, not the cwd", async () => {
    const dir = project({ roots: { app: { dir: "./infra" } } });
    const result = await terraformInit({ root: "app", cwd: dir });
    expect(result.dir).toBe(resolve(dir, "infra"));
    expect(execCalls[0].opts.cwd).toBe(resolve(dir, "infra"));
  });

  test("an unknown root name fails naming the roots that do exist", async () => {
    const dir = project({ roots: { app: { dir: "./infra" }, data: { dir: "./infra" } } });
    await expect(terraformInit({ root: "nope", cwd: dir })).rejects.toThrow(
      /no root named "nope" in terraform\.roots.*known roots: app, data/s,
    );
  });

  test("the configured binary drives every command", async () => {
    const dir = project({ binary: "tofu", roots: { app: { dir: "./infra" } } });
    await terraformInit({ root: "app", cwd: dir });
    expect(execCalls[0].cmd.startsWith("tofu init")).toBe(true);
  });
});

// ── terraformInit ───────────────────────────────────────────────────────────

describe("terraformInit (#2086)", () => {
  test("runs init with -input=false and TF_IN_AUTOMATION=1", async () => {
    const dir = project({ roots: { app: { dir: "./infra" } } });
    await terraformInit({ root: "app", cwd: dir });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].cmd).toBe("terraform init -input=false");
    expect(execCalls[0].opts.env?.TF_IN_AUTOMATION).toBe("1");
  });

  test("backendConfig from the root becomes -backend-config flags", async () => {
    const dir = project({
      roots: { app: { dir: "./infra", backendConfig: { path: "terraform.tfstate" } } },
    });
    await terraformInit({ root: "app", cwd: dir });
    expect(execCalls[0].cmd).toBe("terraform init -input=false -backend-config=path=terraform.tfstate");
  });

  test("the root's workspace reaches the child as TF_WORKSPACE", async () => {
    const dir = project({ roots: { app: { dir: "./infra", workspace: "prod" } } });
    const result = await terraformInit({ root: "app", cwd: dir });
    expect(execCalls[0].opts.env?.TF_WORKSPACE).toBe("prod");
    expect(result.workspace).toBe("prod");
  });
});

// ── terraformPlan ───────────────────────────────────────────────────────────

describe("terraformPlan — the -detailed-exitcode mapping (#2086)", () => {
  test("exit 0: no changes, and both show renders come back", async () => {
    const dir = project({ roots: { app: { dir: "./infra" } } });
    showReplies();
    const result = await terraformPlan({ root: "app", cwd: dir });
    expect(result.changed).toBe(false);
    expect(result.planFile).toBe(DEFAULT_PLAN_FILE);
    expect(result.text).toContain("Plan: 2 to add");
    expect(result.json).toEqual(JSON.parse(PLAN_JSON));
    expect(result).toMatchObject({ adds: 2, changes: 1, destroys: 1 });
    expect(execCalls.map((c) => c.cmd)).toEqual([
      "terraform plan -input=false -detailed-exitcode -out=chant.tfplan",
      "terraform show -json chant.tfplan",
      "terraform show -no-color chant.tfplan",
    ]);
  });

  // #2300 — the Plan phase is where the plan gets its identity, so the
  // activity's own result carries it and the Gate step references it from
  // there rather than re-reading the file.
  test("the result carries the plan's digest, taken off the show -json rendering", async () => {
    const dir = project({ roots: { app: { dir: "./infra" } } });
    showReplies();
    const result = await terraformPlan({ root: "app", cwd: dir });
    expect(result.planDigest).toBe(terraformPlanDigest(JSON.parse(PLAN_JSON)));
  });

  test("exit 2: changed, and the plan is still shown", async () => {
    const dir = project({ roots: { app: { dir: "./infra" } } });
    replies.push({ match: "plan ", reply: execError(2, "", "Plan: 2 to add...\n") });
    showReplies();
    const result = await terraformPlan({ root: "app", cwd: dir });
    expect(result.changed).toBe(true);
    expect(result.destroys).toBe(1);
  });

  test("exit 1: throws with terraform's stderr attached, and never shows the plan", async () => {
    const dir = project({ roots: { app: { dir: "./infra" } } });
    replies.push({
      match: "plan ",
      reply: execError(1, 'Error: Reference to undeclared input variable\n\n  on main.tf line 3'),
    });
    showReplies();
    await expect(terraformPlan({ root: "app", cwd: dir })).rejects.toThrow(
      /terraform plan failed in .*infra \(exit 1\)[\s\S]*Reference to undeclared input variable/,
    );
    expect(execCalls).toHaveLength(1);
  });

  test("varFiles and TF_IN_AUTOMATION reach the plan invocation", async () => {
    const dir = project({
      roots: { app: { dir: "./infra", varFiles: ["prod.tfvars"], workspace: "prod" } },
    });
    showReplies();
    await terraformPlan({ root: "app", cwd: dir, planFile: "custom.tfplan" });
    expect(execCalls[0].cmd).toBe(
      "terraform plan -input=false -detailed-exitcode -var-file=prod.tfvars -out=custom.tfplan",
    );
    for (const call of execCalls) {
      expect(call.opts.env?.TF_IN_AUTOMATION).toBe("1");
      expect(call.opts.env?.TF_WORKSPACE).toBe("prod");
    }
  });

  test("-destroy plans the removal of the whole root", async () => {
    const dir = project({ roots: { app: { dir: "./infra" } } });
    showReplies();
    await terraformPlan({ root: "app", cwd: dir, destroy: true });
    expect(execCalls[0].cmd).toContain(" -destroy ");
  });
});

// ── terraformApply ──────────────────────────────────────────────────────────

describe("terraformApply — saved plans only (#2086)", () => {
  test("applies the named plan file with -input=false and TF_IN_AUTOMATION=1", async () => {
    const dir = project({ roots: { app: { dir: "./infra" } } });
    const result = await terraformApply({ root: "app", cwd: dir, planFile: "chant.tfplan" });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].cmd).toBe("terraform apply -input=false chant.tfplan");
    expect(execCalls[0].opts.env?.TF_IN_AUTOMATION).toBe("1");
    expect(result).toMatchObject({ planFile: "chant.tfplan", applied: true });
  });

  test("no planFile on a stock root: refused, with no bare apply run", async () => {
    const dir = project({ roots: { app: { dir: "./infra" } } });
    await expect(
      terraformApply({ root: "app", cwd: dir } as unknown as { root: string; cwd: string; planFile: string }),
    ).rejects.toThrow(/planFile is required.*no bare-apply mode/s);
    expect(execCalls).toHaveLength(0);
  });

  test("an empty planFile is refused too", async () => {
    const dir = project({ roots: { app: { dir: "./infra" } } });
    await expect(terraformApply({ root: "app", cwd: dir, planFile: "   " })).rejects.toThrow(
      /planFile is required/,
    );
    expect(execCalls).toHaveLength(0);
  });
});

// ── terraformShow ───────────────────────────────────────────────────────────

describe("terraformShow (#2086)", () => {
  test("over state: json plus text, zero change counts, TF_IN_AUTOMATION=1", async () => {
    const dir = project({ roots: { app: { dir: "./infra" } } });
    replies.push({ match: "show -json", reply: { stdout: '{"values":{}}', stderr: "" } });
    replies.push({ match: "show -no-color", reply: { stdout: "No state.\n", stderr: "" } });
    const result = await terraformShow({ root: "app", cwd: dir });
    expect(execCalls.map((c) => c.cmd)).toEqual(["terraform show -json", "terraform show -no-color"]);
    expect(result.source).toBe("state");
    expect(result).toMatchObject({ adds: 0, changes: 0, destroys: 0 });
    expect(result.text).toBe("No state.\n");
    expect(execCalls[0].opts.env?.TF_IN_AUTOMATION).toBe("1");
  });

  test("over a plan file: counts the change set, so a gate can report destroys", async () => {
    const dir = project({ roots: { app: { dir: "./infra" } } });
    showReplies();
    const result = await terraformShow({ root: "app", cwd: dir, planFile: "chant.tfplan" });
    expect(result.source).toBe("plan");
    expect(result.planFile).toBe("chant.tfplan");
    expect(result.destroys).toBe(1);
    expect(execCalls[0].cmd).toBe("terraform show -json chant.tfplan");
  });
});

// ── choudoufuLivePlan: subprocess echo never lands on real stdout (chant#2395) ─
//
// `describeResources()` (`../../describe-resources.ts`) calls this activity
// directly, in-process, as an internal read — the same call `chant lifecycle
// plan --live --json` and `chant components status --live --json` make while
// building their own JSON document. Before the fix, `report()` echoed the
// `choudoufu live-plan -json` subprocess's raw stdout onto real
// `console.log`, landing on the very stream the caller's own JSON document is
// about to be printed to: two concatenated JSON values on one stdout, which
// broke `convergeTick`'s bare `JSON.parse(stdout)` downstream
// (`packages/core/src/op/activities/converge.ts`) with "Unexpected
// non-whitespace character after JSON at position …". This captures exactly
// that scenario — a live root, a `-json` live-plan read — and asserts real
// stdout carries none of the subprocess's document.
describe("choudoufuLivePlan — subprocess echo never lands on real stdout (chant#2395)", () => {
  const LIVE_PLAN_DOCUMENT = JSON.stringify({
    estate: "converge-operator-example",
    bound: [],
    omissions: [],
    unowned: [],
  });

  function liveProject(): string {
    const dir = project({ binary: "choudoufu", roots: { estate: { dir: "./infra" } } });
    writeFileSync(join(dir, "infra", "estate.chdf.hcl"), 'estate = "converge-operator-example"\n');
    return dir;
  }

  beforeEach(() => {
    __resetChoudoufuVersionCheckForTests();
    replies.push(
      { match: "choudoufu version", reply: { stdout: "choudoufu v0.15.0 (based on OpenTofu v1.13.0)\non darwin_arm64", stderr: "" } },
      { match: "-json", reply: { stdout: LIVE_PLAN_DOCUMENT, stderr: "" } },
      { match: "-no-color", reply: { stdout: "No changes.\n\nPlan: 0 to add, 0 to change, 0 to destroy.\n", stderr: "" } },
    );
  });

  test("RED/GREEN: real stdout carries no part of the subprocess's JSON document", async () => {
    const dir = liveProject();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await choudoufuLivePlan({ root: "estate", cwd: dir });
      expect(result.estate).toBe("converge-operator-example");

      // The would-be second document — chant's own JSON render for the
      // command as a whole — is simulated here the way the real CLI produces
      // it: one more line on real stdout after the activity returns.
      console.log(JSON.stringify({ env: "dev", entries: [] }));

      const stdoutText = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(stdoutText).not.toContain(LIVE_PLAN_DOCUMENT);
      // Exactly one JSON value on stdout: the caller's own document, not the
      // subprocess's.
      expect(() => JSON.parse(stdoutText)).not.toThrow();

      // The subprocess's document went to stderr instead — echoed, not
      // silently dropped, for a human running this as a `chant run` step.
      const stderrText = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(stderrText).toContain(LIVE_PLAN_DOCUMENT);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

// ── Cancellation ────────────────────────────────────────────────────────────

describe("every activity forwards the AbortSignal (#2086)", () => {
  const cases: Array<[string, (dir: string, signal: AbortSignal) => Promise<unknown>]> = [
    ["terraformInit", (dir, signal) => terraformInit({ root: "app", cwd: dir }, signal)],
    ["terraformPlan", (dir, signal) => terraformPlan({ root: "app", cwd: dir }, signal)],
    ["terraformApply", (dir, signal) => terraformApply({ root: "app", cwd: dir, planFile: "p" }, signal)],
    ["terraformShow", (dir, signal) => terraformShow({ root: "app", cwd: dir }, signal)],
  ];

  for (const [name, invoke] of cases) {
    test(`${name}: aborting mid-run rejects, and the signal reached the child`, async () => {
      const dir = project({ roots: { app: { dir: "./infra" } } });
      hangUntilAborted = true;
      const controller = new AbortController();
      const pending = invoke(dir, controller.signal);
      // Let the activity read the config and start the child before aborting.
      await vi.waitFor(() => expect(execCalls.length).toBeGreaterThan(0));
      expect(execCalls[0].opts.signal).toBe(controller.signal);
      controller.abort();
      await expect(pending).rejects.toThrow(/aborted/i);
    });
  }
});
