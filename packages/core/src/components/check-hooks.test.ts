import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { assertOpWaveHooks, assertPrLoopHooks } from "../op/op-waves";
import { checkHookEnv, checkHooksOf, runCheckHooks, writeCiHook } from "./check-hooks";

describe("the check moment (#4556)", () => {
  test("ci.hooks takes check hooks, and refuses approve and {plan} there", () => {
    expect(() => assertPrLoopHooks("ci.hooks", { check: [{ name: "tflint", command: ["tflint", "--chdir", "{target}"], perRun: true }] })).not.toThrow();
    expect(() => assertPrLoopHooks("ci.hooks", { check: [{ command: ["lint"], onFailure: "approve" }] })).toThrow(/nothing to approve/);
    expect(() => assertPrLoopHooks("ci.hooks", { check: [{ command: ["lint", "{plan}"], perRun: true }] })).toThrow(/no \{plan\}/);
    expect(() => assertPrLoopHooks("ci.hooks", { check: [{ command: ["lint", "{target}"] }] })).toThrow(/perRun/);
  });

  test("an Op waves spec has no check moment", () => {
    expect(() => assertOpWaveHooks("Op waves", { check: [{ command: ["lint"] }] } as never)).toThrow(/check job/);
  });

  test("a check hook's environment has no forge token or cloud credentials", () => {
    const env = checkHookEnv({ PATH: "/bin", GITHUB_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s", ACTIONS_ID_TOKEN_REQUEST_URL: "u", TF_TOKEN_app_terraform_io: "x", TF_TOKEN_registry_example_com: "y", PULUMI_ACCESS_TOKEN: "p" });
    expect(env).toEqual({ PATH: "/bin" });
  });

  test("the top level's check hooks run before the member's", () => {
    const declaration = { ci: { hooks: { check: [{ name: "a", command: ["a"] }] } }, members: [{ name: "net", ciHooks: { check: [{ name: "b", command: ["b"] }] } }] } as never;
    expect(checkHooksOf(declaration, "net").map((h) => h.name)).toEqual(["a", "b"]);
  });

  test("runs each hook once, or once per target, and reports each call", () => {
    const cwd = mkdtempSync(join(tmpdir(), "chant-check-"));
    const calls: string[][] = [];
    const report = runCheckHooks({
      base: "abc123",
      targets: ["roots/a", "roots/b"],
      cwd,
      read: { base: "abc123", hooks: [{ name: "fmt", command: ["fmt"] }, { name: "tflint", command: ["tflint", "{target}"], perRun: true, targets: ["roots/b"] }] },
      exec: (argv, _cwd, env) => {
        calls.push([...argv, env?.CHANT_HOOK ?? ""]);
        return argv[1] === "roots/b" ? 2 : 0;
      },
      log: () => {},
    });
    expect(calls).toEqual([["fmt", "check"], ["tflint", "roots/b", "check"]]);
    expect(report).toMatchObject({ status: "failed", base: "abc123", hooks: [{ name: "fmt", outcome: "passed", exit: 0 }, { name: "tflint", target: "roots/b", outcome: "failed", exit: 2 }] });
    expect(JSON.parse(readFileSync(join(cwd, ".chant/check/check-hooks.json"), "utf8")).status).toBe("failed");
  });

  test("no check hook at base is status none", () => {
    const cwd = mkdtempSync(join(tmpdir(), "chant-check-"));
    expect(runCheckHooks({ base: "abc", cwd, read: { base: "abc", hooks: [] }, log: () => {} }).status).toBe("none");
  });

  test("writeCiHook adds a check hook, keeps the file's other keys, and replaces one of the same name", () => {
    const root = mkdtempSync(join(tmpdir(), "chant-check-"));
    writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({ version: 1, members: [{ name: "net", path: "net" }] }, null, 2) + "\n");
    expect(writeCiHook(root, "check", { name: "pre-commit", command: ["pre-commit", "run", "--all-files"] }).replaced).toBe(false);
    expect(writeCiHook(root, "check", { name: "pre-commit", command: ["pre-commit", "run", "-a"] }).replaced).toBe(true);
    writeCiHook(root, "check", { name: "tflint", command: ["tflint"] }, { member: "net" });
    const doc = JSON.parse(readFileSync(join(root, "chant.workspace.json"), "utf8"));
    expect(doc.ci.hooks.check).toEqual([{ name: "pre-commit", command: ["pre-commit", "run", "-a"] }]);
    expect(doc.members[0].ci.hooks.check).toEqual([{ name: "tflint", command: ["tflint"] }]);
    expect(doc.version).toBe(1);
    expect(() => writeCiHook(root, "check", { command: ["x"], onFailure: "approve" })).toThrow(/nothing to approve/);
  });
});
