/**
 * Merging per-member lint and audit output (#2537, #2524 D16): one SARIF run
 * per member, and a `member` field on every audit finding.
 */

import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { mergeAudit, mergeSarif, type MemberOutput } from "./compose-reports";

const sarif = (uris: string[]) =>
  JSON.stringify({
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "chant", rules: [{ id: "COR001" }] } },
        results: uris.map((uri) => ({
          ruleId: "COR001",
          ruleIndex: 0,
          message: { text: "m" },
          locations: [{ physicalLocation: { artifactLocation: { uri } } }],
        })),
      },
    ],
  });

const out = (id: string, dir: string, stdout: string, exitCode = 0, stderr = ""): MemberOutput => ({
  id,
  member: id.split(":")[0],
  dir,
  exitCode,
  stdout,
  stderr,
});

describe("mergeSarif", () => {
  const root = "/work/acme";
  const log = mergeSarif(
    [
      out("platform", ".", sarif([pathToFileURL("/work/acme/src/a.ts").href])),
      out("api", "services/api", sarif([pathToFileURL("/work/acme/services/api/src/b.ts").href, "src/c.ts"])),
      out("examples:examples/demo", "examples/demo", "Error: boom", 1, "stack trace"),
    ],
    root,
  ) as { runs: Array<Record<string, unknown>> };

  test("writes one run per member, told apart by automationDetails.id", () => {
    expect(log.runs).toHaveLength(3);
    expect(log.runs.map((r) => (r.automationDetails as { id: string }).id)).toEqual(["platform/", "api/", "examples:examples/demo/"]);
    expect(log.runs[1].properties).toEqual({ member: "api", dir: "services/api" });
  });

  test("makes artifact URIs relative to the workspace root", () => {
    const uris = (i: number) =>
      (log.runs[i].results as Array<{ locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }> }>).map(
        (r) => r.locations[0].physicalLocation.artifactLocation.uri,
      );
    expect(uris(0)).toEqual(["src/a.ts"]);
    expect(uris(1)).toEqual(["services/api/src/b.ts", "services/api/src/c.ts"]);
  });

  test("gives a member whose lint printed no SARIF a failed invocation and no results", () => {
    const failed = log.runs[2] as { results: unknown[]; invocations: Array<{ executionSuccessful: boolean; exitCode: number }> };
    expect(failed.results).toEqual([]);
    expect(failed.invocations[0]).toMatchObject({ executionSuccessful: false, exitCode: 1 });
  });

  test("folds a member's extra runs into its one run", () => {
    const two = JSON.parse(sarif(["x.ts"]));
    two.runs.push(JSON.parse(sarif(["y.ts"])).runs[0]);
    const merged = mergeSarif([out("m", "m", JSON.stringify(two))], root) as { runs: Array<{ results: Array<Record<string, unknown>> }> };
    expect(merged.runs).toHaveLength(1);
    expect(merged.runs[0].results).toHaveLength(2);
    expect(merged.runs[0].results[1].ruleIndex).toBeUndefined();
  });
});

describe("mergeAudit", () => {
  const report = (files: string[]) =>
    JSON.stringify({
      schemaVersion: "1.0",
      status: "ok",
      summary: { total: files.length },
      findings: files.map((file) => ({ checkId: "WK8202", severity: "error", message: "m", file })),
    });

  test("adds a member field to every finding and keeps the rest", () => {
    const doc = mergeAudit([out("api", "services/api", report(["manifests/pod.yaml"]))], { name: "acme", root: "/w" });
    expect(doc.schemaVersion).toBe("1.0");
    expect(doc.findings).toEqual([{ checkId: "WK8202", severity: "error", message: "m", file: "manifests/pod.yaml", member: "api" }]);
  });

  test("leaves findings in another member's directory to that member", () => {
    const root = { ...out("platform", ".", report(["ci.yml", "services/api/manifests/pod.yaml"])), exclude: ["services/api"] };
    const doc = mergeAudit([root], { name: "acme", root: "/w" });
    expect(doc.findings.map((f) => f.file)).toEqual(["ci.yml"]);
    expect(doc.members[0].leftToMembers).toBe(1);
  });

  test("records a member with nothing to audit, and one whose audit failed", () => {
    const doc = mergeAudit(
      [out("empty", "e", "No auditable files found under ..\n"), out("broken", "b", "", 1, "Error: boom")],
      { name: "acme", root: "/w" },
    );
    expect(doc.members.map((m) => [m.member, m.status, m.note ?? m.error])).toEqual([
      ["empty", "ok", "No auditable files found under .."],
      ["broken", "failed", "Error: boom"],
    ]);
  });
});
