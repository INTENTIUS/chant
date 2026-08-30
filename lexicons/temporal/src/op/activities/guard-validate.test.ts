import { describe, test, expect, vi, beforeEach } from "vitest";
import { resolve } from "node:path";
import type { ApplicationFailure } from "@temporalio/common";

// guardValidate reaches cfn-guard through the runtime adapter's spawn (not
// node:child_process), so the I/O seam is the runtime-adapter module — same
// pattern `lexicons/aws/src/import/live-export-io.test.ts` uses for the aws
// plugin's own spawn calls. Partial mock (`importOriginal`) rather than a
// full replacement, for the same reason that test gives: the module is
// reachable from other real exports this file's own imports touch
// transitively, so replacing it wholesale would break more than `spawn`.
const spawnMock = vi.fn();
vi.mock("@intentius/chant/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@intentius/chant/runtime-adapter")>();
  return { ...actual, getRuntime: () => ({ ...actual.getRuntime(), spawn: spawnMock }) };
});

import { guardValidate, parseGuardFindings } from "./guard-validate";

const CLEAN = JSON.stringify([{ name: "template.json", not_compliant: [], compliant: [{ Rule: { name: "s3_bucket_ok" } }] }]);

const ONE_VIOLATION = JSON.stringify([
  {
    name: "template.json",
    not_compliant: [
      {
        Rule: {
          name: "s3_bucket_public_read_prohibited",
          messages: { error: "PublicAccessBlockConfiguration is missing" },
          checks: [{ Clause: { Unary: { check: { UnResolved: { path: "/Resources/MyBucket/Properties/PublicAccessBlockConfiguration" } } } } }],
        },
      },
    ],
    compliant: [],
  },
]);

describe("guardValidate activity (#522)", () => {
  beforeEach(() => spawnMock.mockReset());

  test("spawns cfn-guard validate with -r/-d/--output-format json; template defaults to <path>/template.json", async () => {
    spawnMock.mockResolvedValue({ stdout: CLEAN, stderr: "", exitCode: 0 });
    await guardValidate({ rules: "rules.guard", path: "proj" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const argv = spawnMock.mock.calls[0][0] as string[];
    expect(argv).toEqual([
      "cfn-guard", "validate",
      "-r", "rules.guard",
      "-d", resolve("proj", "template.json"),
      "--output-format", "json",
    ]);
  });

  test("an explicit template/binary override both take", async () => {
    spawnMock.mockResolvedValue({ stdout: CLEAN, stderr: "", exitCode: 0 });
    await guardValidate({ rules: "rules.guard", template: "dist/out.json", binary: "/opt/bin/cfn-guard" });
    const argv = spawnMock.mock.calls[0][0] as string[];
    expect(argv).toEqual(["/opt/bin/cfn-guard", "validate", "-r", "rules.guard", "-d", "dist/out.json", "--output-format", "json"]);
  });

  test("a clean run resolves with no findings", async () => {
    spawnMock.mockResolvedValue({ stdout: CLEAN, stderr: "", exitCode: 0 });
    await expect(guardValidate({ rules: "rules.guard" })).resolves.toEqual({
      findings: [],
      summary: expect.stringContaining("compliant"),
    });
  });

  test("a violation throws (non-retryable) and names the rule and the entity", async () => {
    spawnMock.mockResolvedValue({ stdout: ONE_VIOLATION, stderr: "", exitCode: 5 });
    await expect(guardValidate({ rules: "rules.guard" })).rejects.toThrow(
      /s3_bucket_public_read_prohibited.*MyBucket/s,
    );
  });

  test("the thrown failure is a non-retryable ApplicationFailure typed GuardViolation — same shape policyGate uses for PolicyViolation", async () => {
    spawnMock.mockResolvedValue({ stdout: ONE_VIOLATION, stderr: "", exitCode: 5 });
    try {
      await guardValidate({ rules: "rules.guard" });
      expect.unreachable("guardValidate should have thrown");
    } catch (err) {
      expect((err as ApplicationFailure).type).toBe("GuardViolation");
      expect((err as ApplicationFailure).nonRetryable).toBe(true);
    }
  });

  test("cfn-guard producing no output at all (binary missing / failed to run) is a setup error, not a clean pass", async () => {
    spawnMock.mockResolvedValue({ stdout: "", stderr: "spawn cfn-guard ENOENT", exitCode: 1 });
    await expect(guardValidate({ rules: "rules.guard" })).rejects.toThrow(/cfn-guard.*no output/i);
  });

  test("onFinding other than \"report\" is refused rather than silently ignored", async () => {
    // @ts-expect-error — the type only admits "report"; a dynamically loaded
    // Op config could still pass through an unsupported value at runtime.
    await expect(guardValidate({ rules: "rules.guard", onFinding: "issue" })).rejects.toThrow(
      /onFinding "issue" is not implemented/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("parseGuardFindings (#522 — pure mapping, no spawn)", () => {
  test("no not_compliant entries → no findings", () => {
    expect(parseGuardFindings(CLEAN)).toEqual([]);
  });

  test("maps a not_compliant entry to a finding with rule, message, and entity", () => {
    const findings = parseGuardFindings(ONE_VIOLATION);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "s3_bucket_public_read_prohibited",
      severity: "error",
      entity: "MyBucket",
    });
    expect(findings[0].message).toContain("PublicAccessBlockConfiguration is missing");
  });

  test("a single (non-array) file report is accepted", () => {
    const single = JSON.stringify({ name: "template.json", not_compliant: [{ Rule: { name: "r1" } }] });
    expect(parseGuardFindings(single)).toEqual([{ rule: "r1", severity: "error", message: 'cfn-guard rule "r1" violated' }]);
  });

  test("a rule violation with no recognizable message field still produces a finding, not a silent drop", () => {
    const noMessage = JSON.stringify([{ not_compliant: [{ Rule: { name: "r2" } }] }]);
    expect(parseGuardFindings(noMessage)).toEqual([{ rule: "r2", severity: "error", message: 'cfn-guard rule "r2" violated' }]);
  });

  test("multiple violations across multiple file reports are all collected", () => {
    const multi = JSON.stringify([
      { name: "a.json", not_compliant: [{ Rule: { name: "r1" } }] },
      { name: "b.json", not_compliant: [{ Rule: { name: "r2" } }, { Rule: { name: "r3" } }] },
    ]);
    expect(parseGuardFindings(multi).map((f) => f.rule)).toEqual(["r1", "r2", "r3"]);
  });

  test("non-JSON stdout throws a clear setup error rather than reporting zero violations", () => {
    expect(() => parseGuardFindings("cfn-guard: error: rules file not found")).toThrow(/did not return parseable JSON/);
  });
});
