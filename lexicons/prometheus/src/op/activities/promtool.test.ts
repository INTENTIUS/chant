/**
 * The promtool and amtool steps, against stand-in binaries: small shell
 * scripts that answer `--version` and accept or reject a file by its
 * content, run as the real tools would be (the step's own child process).
 * The real tools are exercised by `tools.test.ts` and `slo-burn.test.ts`
 * when they are on PATH.
 */

import { describe, expect, test } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecRunner } from "@intentius/chant-lexicon-otel/op/activities/exec";
import { amtoolCheckConfig, amtoolRoutesTest, parseRoutesOutput, promtoolCheckRules, promtoolTestRules } from "./promtool";

const dir = mkdtempSync(join(tmpdir(), "chant-promtool-step-"));

function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const PROMTOOL = script(
  "promtool",
  `case "$1" in
  --version) echo "promtool, version 3.15.0"; exit 0;;
  check) if grep -q BAD "$3"; then echo "FAILED: $3: bad rule" >&2; exit 1; fi; echo "SUCCESS: $3"; exit 0;;
  test) if grep -q FAIL "$3"; then echo "FAILED: alert did not fire" >&2; exit 1; fi; grep -q "rule_files" "$3" || exit 3; test -f rules.yml || exit 4; echo "SUCCESS"; exit 0;;
esac
exit 2`,
);
const AMTOOL = script(
  "amtool",
  `case "$1" in
  --version) echo "amtool, version 0.34.1"; exit 0;;
  check-config) if grep -q BAD "$2"; then echo "FAILED" >&2; exit 1; fi; echo "SUCCESS"; exit 0;;
esac
exit 2`,
);

function file(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

const RULES = file("rules.yml", "groups:\n  - name: g\n    rules:\n      - record: x\n        expr: up\n");

describe("promtool steps", () => {
  test("check rules passes a good file and fails a bad one with the tool's output", async () => {
    await expect(promtoolCheckRules({ rules: RULES, bin: PROMTOOL })).resolves.toMatchObject({ ok: true, files: [RULES] });
    const bad = file("bad.yml", "BAD");
    await expect(promtoolCheckRules({ rules: [RULES, bad], bin: PROMTOOL })).rejects.toThrow(/promtool check rules rejected .*bad\.yml.*bad rule/s);
  });

  test("a missing binary fails the step: a check that did not run is not a pass", async () => {
    await expect(promtoolCheckRules({ rules: RULES, bin: join(dir, "no-such-promtool") })).rejects.toThrow(/is not installed/);
  });

  test("test rules runs once per test file and inline document, each beside rules.yml", async () => {
    const t = file("t.test.yml", "rule_files: [rules.yml]\ntests: []\n");
    const r = await promtoolTestRules({ rules: RULES, tests: t, testYaml: ["rule_files: [rules.yml]\ntests: []\n"], bin: PROMTOOL });
    expect(r.tests).toBe(2);
    await expect(promtoolTestRules({ rules: RULES, testYaml: "rule_files: [rules.yml]\n# FAIL\n", bin: PROMTOOL })).rejects.toThrow(/alert did not fire/);
    await expect(promtoolTestRules({ rules: RULES, bin: PROMTOOL })).rejects.toThrow(/give tests or testYaml/);
  });

  test("amtool check-config", async () => {
    await expect(amtoolCheckConfig({ config: file("am.yml", "route: {}\n"), bin: AMTOOL })).resolves.toMatchObject({ ok: true });
    await expect(amtoolCheckConfig({ config: file("am-bad.yml", "BAD"), bin: AMTOOL })).rejects.toThrow(/amtool check-config rejected/);
  });
});

describe("amtoolRoutesTest", () => {
  test("reads the receivers amtool prints", () => {
    expect(parseRoutesOutput("oncall\n")).toEqual(["oncall"]);
    expect(parseRoutesOutput("oncall,tickets\n")).toEqual(["oncall", "tickets"]);
    expect(parseRoutesOutput("")).toEqual([]);
  });

  const exec = (stdout: string, code = 0): { exec: ExecRunner; calls: string[][] } => {
    const calls: string[][] = [];
    return {
      calls,
      exec: async (bin, args) => {
        calls.push([bin, ...args]);
        return { code, stdout, stderr: "" };
      },
    };
  };

  test("passes when the labels route to the expected receivers", async () => {
    const { exec: e, calls } = exec("oncall\n");
    const r = await amtoolRoutesTest({ config: "/tmp/am.yml", labels: { severity: "page", slo: "checkout" }, expect: "oncall", _exec: e });
    expect(r.receivers).toEqual(["oncall"]);
    expect(calls[0]).toEqual(["amtool", "config", "routes", "test", "--config.file=/tmp/am.yml", "severity=page", "slo=checkout"]);
  });

  test("fails when they route elsewhere, naming both", async () => {
    const { exec: e } = exec("tickets\n");
    await expect(amtoolRoutesTest({ config: "/tmp/am.yml", labels: { severity: "page" }, expect: ["oncall"], _exec: e })).rejects.toThrow(
      /severity=page routes to tickets .* expected oncall/,
    );
  });
});
