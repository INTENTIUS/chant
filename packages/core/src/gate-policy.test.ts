import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertGatePolicySettings,
  checkGatePolicy,
  conftestFindings,
  exportGatePolicy,
  gatePolicyArgv,
  opaFindings,
  type GatePolicyExec,
  type GatePolicyTree,
} from "./gate-policy";

/** conftest's JSON for one input: a deny with its query, an older deny without one, and a warning. */
const CONFTEST_DENY = JSON.stringify([
  {
    filename: "input.json",
    namespace: "main",
    successes: 2,
    failures: [
      { msg: "bucket logs is public", metadata: { query: "data.main.deny_public_bucket" } },
      { msg: { msg: "no owner tag" } },
    ],
    warnings: [{ msg: "the plan deletes 3 resources" }],
  },
]);

const opa = (value: unknown): string => JSON.stringify({ result: [{ expressions: [{ value, text: "data.main", location: { row: 1, col: 1 } }] }] });

describe("reading the engine's answer (#4294)", () => {
  test("conftest: failures deny by their query, warnings are advice", () => {
    expect(conftestFindings(CONFTEST_DENY)).toEqual({
      denials: [
        { rule: "main.deny_public_bucket", message: "bucket logs is public" },
        { rule: "main.deny", message: "no owner tag" },
      ],
      holds: [],
      warnings: ["the plan deletes 3 resources"],
    });
    expect(conftestFindings(JSON.stringify([{ filename: "input.json", namespace: "main", successes: 1 }]))).toEqual({ denials: [], holds: [], warnings: [] });
    expect(conftestFindings("not json")).toBeUndefined();
    expect(conftestFindings(JSON.stringify({ result: [] }))).toBeUndefined();
  });

  test("opa: deny, violation, hold and warn rules by name; a child package one level down; allow_unattended is no rule", () => {
    const found = opaFindings(
      opa({
        deny: ["public bucket"],
        violation_size: "too many deletes",
        hold_iam: ["an IAM role changes"],
        hold: true,
        warn: ["consider tags"],
        allow_unattended: true,
        allow_unattended_docs: ["docs only"],
        other: 3,
        aws: { deny_region: ["us-west-1 is not allowed"] },
      }),
    );
    expect(found).toEqual({
      denials: [
        { rule: "main.aws.deny_region", message: "us-west-1 is not allowed" },
        { rule: "main.deny", message: "public bucket" },
        { rule: "main.violation_size", message: "too many deletes" },
      ],
      holds: [
        { rule: "main.hold", message: "hold" },
        { rule: "main.hold_iam", message: "an IAM role changes" },
      ],
      warnings: ["consider tags"],
    });
  });

  test("opa: an undefined query matches nothing, an array is a deny set, errors and other shapes are no answer", () => {
    expect(opaFindings(JSON.stringify({}))).toEqual({ denials: [], holds: [], warnings: [] });
    expect(opaFindings(opa(["a", { msg: "b" }]), "policy.deny")).toEqual({ denials: [{ rule: "policy.deny", message: "a" }, { rule: "policy.deny", message: "b" }], holds: [], warnings: [] });
    expect(opaFindings(JSON.stringify({ errors: [{ message: "rego_parse_error" }] }))).toBeUndefined();
    expect(opaFindings(opa(7))).toBeUndefined();
    expect(opaFindings("{")).toBeUndefined();
  });
});

describe("running the engine (#4294)", () => {
  const fake = (out: { status: number | null; stdout?: string; stderr?: string }, seen: string[][] = []): GatePolicyExec => (argv) => {
    seen.push(argv);
    return { status: out.status, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
  };

  test("the engines' own argv, and a command's placeholders filled", () => {
    expect(gatePolicyArgv({}, { policy: "/p", input: "/i.json" })).toEqual(["conftest", "test", "--no-color", "--output", "json", "--policy", "/p", "--all-namespaces", "/i.json"]);
    expect(gatePolicyArgv({ engine: "conftest", namespace: "infra" }, { policy: "/p", input: "/i.json" })).toContain("--namespace");
    expect(gatePolicyArgv({ engine: "opa" }, { policy: "/p", input: "/i.json" })).toEqual(["opa", "eval", "--format", "json", "--data", "/p", "--input", "/i.json", "data.main"]);
    expect(gatePolicyArgv({ engine: "opa", command: ["./bin/check", "--rules={policy}", "{input}"] }, { policy: "/p", input: "/i.json" })).toEqual(["./bin/check", "--rules=/p", "/i.json"]);
  });

  test("the input is written to the file the engine reads, and a denial is a verdict with its sorted rules", () => {
    let input: unknown;
    const exec: GatePolicyExec = (argv) => {
      input = JSON.parse(readFileSync(argv[argv.length - 1]!, "utf-8"));
      return { status: 1, stdout: CONFTEST_DENY, stderr: "" };
    };
    const verdict = checkGatePolicy({ settings: {}, input: { changeSet: { entries: [] } }, policyDir: "/p", exec });
    expect(input).toEqual({ changeSet: { entries: [] } });
    expect(verdict).toMatchObject({ result: "denied", engine: "conftest", rules: ["main.deny", "main.deny_public_bucket"], warnings: ["the plan deletes 3 resources"] });
  });

  test("a hold with no denial is held; nothing is passed", () => {
    expect(checkGatePolicy({ settings: { engine: "opa" }, input: {}, policyDir: "/p", exec: fake({ status: 0, stdout: opa({ hold_iam: ["iam"] }) }) })).toMatchObject({ result: "held", holds: [{ rule: "main.hold_iam" }] });
    expect(checkGatePolicy({ settings: { engine: "opa" }, input: {}, policyDir: "/p", exec: fake({ status: 0, stdout: opa({ deny: [], warn: [] }) }) })).toMatchObject({ result: "passed", denials: [], holds: [] });
    expect(checkGatePolicy({ settings: { engine: "opa" }, input: {}, policyDir: "/p", exec: fake({ status: 0, stdout: opa({ deny: ["x"], hold: true }) }) }).result).toBe("denied");
  });

  test("an engine that does not start, prints no result or fails without a denial is an error", () => {
    expect(checkGatePolicy({ settings: {}, input: {}, policyDir: "/p", exec: fake({ status: null, stderr: "spawn conftest ENOENT" }) })).toMatchObject({ result: "error", error: expect.stringContaining("did not run") });
    expect(checkGatePolicy({ settings: {}, input: {}, policyDir: "/p", exec: fake({ status: 2, stdout: "Error: rego_parse_error" }) })).toMatchObject({ result: "error", error: expect.stringContaining("gave no conftest result") });
    expect(checkGatePolicy({ settings: {}, input: {}, policyDir: "/p", exec: fake({ status: 2, stdout: "[]", stderr: "could not load policy" }) })).toMatchObject({ result: "error", error: expect.stringContaining("exited 2") });
  });
});

describe("the policy at base (#4294)", () => {
  const files: Record<string, string> = { "policy/main.rego": "package main\n", "policy/lib/util.rego": "package lib\n", "src/app.ts": "" };
  const tree: GatePolicyTree = {
    stat: (p) => (files[p] !== undefined ? "file" : Object.keys(files).some((f) => f.startsWith(`${p}/`)) ? "dir" : undefined),
    list: (p) => {
      const names = new Map<string, "file" | "dir">();
      for (const f of Object.keys(files).filter((f) => f.startsWith(`${p}/`))) {
        const rest = f.slice(p.length + 1).split("/");
        names.set(rest[0]!, rest.length > 1 ? "dir" : "file");
      }
      return names.size ? [...names].map(([name, type]) => ({ name, type })) : undefined;
    },
    read: (p) => files[p]!,
  };

  test("the directory is copied out of the tree, and removed again", () => {
    const out = exportGatePolicy(tree, "./policy/");
    if ("error" in out) throw new Error(out.error);
    expect(readFileSync(join(out.dir, "main.rego"), "utf-8")).toBe("package main\n");
    expect(readFileSync(join(out.dir, "lib", "util.rego"), "utf-8")).toBe("package lib\n");
    expect(existsSync(join(out.dir, "app.ts"))).toBe(false);
    out.cleanup();
    expect(existsSync(out.dir)).toBe(false);
  });

  test("a directory the base does not have is an error", () => {
    expect(exportGatePolicy(tree, "rules")).toEqual({ error: "the policy directory rules does not exist at base" });
  });
});

describe("ci.policy settings (#4294)", () => {
  test("the four settings are read, and an unattended outcome is refused", () => {
    expect(() => assertGatePolicySettings("ci.policy", { engine: "opa", path: "policy", namespace: "main", command: ["opa", "eval", "{input}"] })).not.toThrow();
    expect(() => assertGatePolicySettings("ci.policy", {})).not.toThrow();
    expect(() => assertGatePolicySettings("ci.policy", { engine: "sentinel" })).toThrow(/conftest or opa/);
    expect(() => assertGatePolicySettings("ci.policy", { path: "../elsewhere" })).toThrow(/inside the workspace/);
    expect(() => assertGatePolicySettings("ci.policy", { command: ["check"] })).toThrow(/\{input\}/);
    expect(() => assertGatePolicySettings("ci.policy", { outcomes: ["deny", "allow_unattended"] })).toThrow(/no unattended outcome/);
    expect(() => assertGatePolicySettings("ci.policy", { allow_unattended: true })).toThrow(/no unattended outcome/);
    expect(() => assertGatePolicySettings("ci.policy", { rules: [] })).toThrow(/not a setting/);
    expect(() => assertGatePolicySettings("ci.policy", [])).toThrow(/must be/);
  });
});
