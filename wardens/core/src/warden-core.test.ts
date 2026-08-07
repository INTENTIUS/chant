import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "./cli-error.js";
import { parseFlags } from "./flags.js";
import { loadConfigFile } from "./config-file.js";
import { reportReconcileOutcome, selectCycles, type ReconcileOutcome } from "./outcome.js";
import { errMsg, requireEnv } from "./shell.js";

describe("parseFlags", () => {
  it("dispatches value and boolean flags", () => {
    const got: Record<string, unknown> = {};
    parseFlags(["--config", "g.yml", "--apply"], {
      "--config": { kind: "value", set: (v) => (got.config = v) },
      "--apply": { kind: "boolean", set: () => (got.apply = true) },
    });
    expect(got).toEqual({ config: "g.yml", apply: true });
  });

  it("rejects positionals, unknown flags, and missing values with exit code 2", () => {
    for (const argv of [["stray"], ["--nope"], ["--config"], ["--config", "--other"]]) {
      try {
        parseFlags(argv, { "--config": { kind: "value", set: () => {} }, "--other": { kind: "boolean", set: () => {} } });
        expect.unreachable(`parsed ${JSON.stringify(argv)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe(2);
      }
    }
  });

  it("lets a value-flag validator throw its own CliError", () => {
    expect(() =>
      parseFlags(["--mode", "yolo"], {
        "--mode": {
          kind: "value",
          set: (v, flag) => {
            if (v !== "dry-run" && v !== "apply") throw new CliError(2, `${flag} must be "dry-run" or "apply", got: ${v}`);
          },
        },
      }),
    ).toThrowError('--mode must be "dry-run" or "apply", got: yolo');
  });
});

describe("loadConfigFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-core-"));

  it("parses JSON by extension and YAML otherwise", () => {
    const j = join(dir, "c.json");
    writeFileSync(j, JSON.stringify({ nodes: {} }));
    expect(loadConfigFile(j, { rootKey: "nodes", parseYaml: () => ({}) })).toEqual({ nodes: {} });

    const y = join(dir, "c.yml");
    writeFileSync(y, "ignored");
    expect(loadConfigFile(y, { rootKey: "orgs", parseYaml: () => ({ orgs: { a: 1 } }) })).toEqual({ orgs: { a: 1 } });
  });

  it("rejects a config without the root map, naming it", () => {
    const y = join(dir, "bad.yml");
    writeFileSync(y, "x");
    expect(() => loadConfigFile(y, { rootKey: "nodes", parseYaml: () => ({}) })).toThrowError(
      "config must be an object with a `nodes` map",
    );
    expect(() => loadConfigFile(y, { rootKey: "orgs", parseYaml: () => ({}) })).toThrowError(
      "config must be an object with an `orgs` map",
    );
  });
});

describe("selectCycles", () => {
  const registry = { a: 1, b: 2 };

  it("returns all cycles for an empty selection, in registry order", () => {
    expect(selectCycles(registry, [])).toEqual([1, 2]);
  });

  it("resolves named cycles and rejects unknown ones listing what exists", () => {
    expect(selectCycles(registry, ["b"])).toEqual([2]);
    expect(() => selectCycles(registry, ["z"])).toThrowError('unknown cycle: "z". Known cycles: a, b');
  });
});

describe("reportReconcileOutcome", () => {
  afterEach(() => vi.restoreAllMocks());

  function outcome(overrides: Partial<ReconcileOutcome>): ReconcileOutcome {
    return { cycles: [], errored: [], deferred: { skippedCycles: [] }, ...overrides };
  }

  const cycle = (over: object) => ({
    name: "teams",
    org: "acme",
    plan: "plan",
    guardrailBlocked: false,
    guardrails: { ok: true as const },
    applied: [],
    failed: [],
    ...over,
  });

  it("returns 0 on success, 1 on a guardrail block, 3 on errors/failures", () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(reportReconcileOutcome(outcome({ cycles: [cycle({})] }), "dry-run")).toBe(0);
    expect(reportReconcileOutcome(outcome({ cycles: [cycle({ guardrailBlocked: true, guardrails: { ok: false, diagnostics: [{ message: "cap" }] } })] }), "apply")).toBe(1);
    expect(reportReconcileOutcome(outcome({ errored: [{ name: "x", org: "acme", stage: "fetch", error: "boom" }] }), "dry-run")).toBe(3);
    expect(reportReconcileOutcome(outcome({ cycles: [cycle({ failed: [{ entry: { resourceType: "team", key: "t" }, error: "409" }] })] }), "apply")).toBe(3);
  });

  it("renders the plan, apply summary, and deferred cycles", () => {
    const out: string[] = [];
    const errs: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((s) => (errs.push(String(s)), true));
    reportReconcileOutcome(
      outcome({ cycles: [cycle({ applied: [1] })], deferred: { skippedCycles: ["rulesets"] } }),
      "apply",
    );
    expect(out.join("")).toContain("=== teams @ acme ===");
    expect(out.join("")).toContain("Applied: 1, Failed: 0");
    expect(errs.join("")).toContain("DEFERRED cycles (budget exhausted): rulesets");
  });
});

describe("shell", () => {
  it("errMsg unwraps Errors and stringifies the rest", () => {
    expect(errMsg(new Error("x"))).toBe("x");
    expect(errMsg("y")).toBe("y");
  });

  it("requireEnv throws CliError(2) on unset/empty and returns the value otherwise", () => {
    const key = "WARDEN_CORE_TEST_ENV";
    delete process.env[key];
    expect(() => requireEnv(key)).toThrowError(`env var ${key} is not set or is empty`);
    process.env[key] = "";
    expect(() => requireEnv(key)).toThrow(CliError);
    process.env[key] = "v";
    expect(requireEnv(key)).toBe("v");
    delete process.env[key];
  });
});
