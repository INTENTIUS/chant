import { describe, test, expect } from "vitest";
import { renderMarkdown } from "./report";
import type { AuditFinding } from "./core";

const CI = `name: CI
on:
  pull_request_target:
permissions: write-all
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;

const FINDINGS: AuditFinding[] = [
  { checkId: "GHA033", severity: "warning", message: "write-all permissions.", file: ".github/workflows/ci.yml", lexicon: "github" },
  { checkId: "GHA021", severity: "warning", message: "unpinned checkout.", file: ".github/workflows/ci.yml", lexicon: "github", entity: "build" },
  { checkId: "GHA035", severity: "error", message: "elevated token on pull_request_target.", file: ".github/workflows/ci.yml", lexicon: "github" },
  { checkId: "GHA018", severity: "warning", message: "pull_request_target checks out PR code.", file: ".github/workflows/ci.yml", lexicon: "github", entity: "build" },
  { checkId: "GHA022", severity: "info", message: "no timeout.", file: ".github/workflows/ci.yml", lexicon: "github" },
];

describe("renderMarkdown — reworked structure", () => {
  test("summary counts by tier and severity", () => {
    const out = renderMarkdown(FINDINGS, { target: "owner/repo" });
    expect(out).toContain("Target: owner/repo");
    expect(out).toContain("5 findings — 2 quick-win, 2 needs-review, 1 report-only (1 error, 3 warning, 1 info).");
  });

  test("quick wins show a real combined diff when file content is provided", () => {
    const out = renderMarkdown(FINDINGS, { files: [{ path: ".github/workflows/ci.yml", content: CI }] });
    expect(out).toContain("## Quick wins (deterministic)");
    expect(out).toContain("Addresses GHA033 (Blanket write-all permissions):");
    expect(out).toContain("```diff");
    expect(out).toContain("-permissions: write-all");
    expect(out).toContain("+permissions:");
    expect(out).toContain("+  contents: read");
  });

  test("pin findings without a SHA resolver are listed, not diffed", () => {
    const out = renderMarkdown(FINDINGS, { files: [{ path: ".github/workflows/ci.yml", content: CI }] });
    expect(out).toContain("Needs a value before it can be auto-patched:");
    expect(out).toContain("**GHA021**");
  });

  test("pin findings are diffed when a SHA resolver is supplied", () => {
    const sha = "11bd71901bbe5b1630ceea73d27597364c9af683";
    const out = renderMarkdown(FINDINGS, {
      files: [{ path: ".github/workflows/ci.yml", content: CI }],
      resolveSha: () => sha,
    });
    expect(out).toContain(`actions/checkout@${sha}`);
  });

  test("guidance findings cluster by authority", () => {
    const out = renderMarkdown(FINDINGS);
    expect(out).toContain("<summary>Needs review (guidance)");
    // GHA035 and GHA018 both share the pwn-request authority → one cluster.
    expect(out).toContain("Preventing pwn requests");
    const clusterIdx = out.indexOf("Preventing pwn requests");
    const after = out.slice(clusterIdx);
    expect(after).toContain("**GHA035**");
    expect(after).toContain("**GHA018**");
  });

  test("report-only hygiene goes in a collapsible table", () => {
    const out = renderMarkdown(FINDINGS);
    expect(out).toContain("<details>");
    expect(out).toContain("<summary>Report-only (hygiene)");
    expect(out).toContain("| GHA022 |");
  });

  test("suppresses a report-only finding on an entity already flagged merge-worthy", () => {
    const findings: AuditFinding[] = [
      { checkId: "WGL016", severity: "error", message: "hardcoded secret.", file: ".gitlab-ci.yml", lexicon: "gitlab", entity: "DB_PASSWORD" },
      { checkId: "WGL021", severity: "warning", message: "unused variable.", file: ".gitlab-ci.yml", lexicon: "gitlab", entity: "DB_PASSWORD" },
    ];
    const out = renderMarkdown(findings);
    expect(out).toContain("WGL016");
    expect(out).not.toContain("WGL021"); // suppressed — same entity already flagged
    expect(out).toContain("1 finding — ");
  });

  test("does not suppress unrelated hygiene sharing a job entity", () => {
    const findings: AuditFinding[] = [
      { checkId: "GHA021", severity: "warning", message: "unpinned.", file: ".github/workflows/ci.yml", lexicon: "github", entity: "build" },
      { checkId: "GHA022", severity: "info", message: "no timeout.", file: ".github/workflows/ci.yml", lexicon: "github", entity: "build" },
    ];
    const out = renderMarkdown(findings);
    expect(out).toContain("GHA022"); // unrelated hygiene on the same job is kept
  });

  test("clean report when there are no findings", () => {
    const out = renderMarkdown([]);
    expect(out).toContain("No issues found.");
    expect(out).not.toContain("Quick wins");
  });

  test("omits empty sections", () => {
    const onlyGuidance = renderMarkdown([FINDINGS[2]]); // GHA035 only
    expect(onlyGuidance).toContain("<summary>Needs review (guidance)");
    expect(onlyGuidance).not.toContain("## Quick wins");
    expect(onlyGuidance).not.toContain("Report-only");
  });
});
