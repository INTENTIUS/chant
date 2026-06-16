import { describe, test, expect } from "vitest";
import { renderHtml, type AuditSnapshot } from "./report-html";
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
  { checkId: "GHA035", severity: "error", message: "elevated token on pull_request_target.", file: ".github/workflows/ci.yml", lexicon: "github" },
  { checkId: "GHA022", severity: "info", message: "no timeout.", file: ".github/workflows/ci.yml", lexicon: "github" },
];

const SNAPSHOT: AuditSnapshot = {
  target: "https://github.com/owner/repo",
  host: "github.com",
  repo: "owner/repo",
  commit: "11bd71901bbe5b1630ceea73d27597364c9af683",
  files: [".github/workflows/ci.yml"],
  generatedAt: "2026-06-16T00:00:00.000Z",
  toolVersion: "0.4.0",
};

describe("renderHtml", () => {
  test("produces a self-contained HTML document with sections and snapshot", () => {
    const html = renderHtml(FINDINGS, { files: [{ path: ".github/workflows/ci.yml", content: CI }], snapshot: SNAPSHOT });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>"); // inline CSS, self-contained
    expect(html).toContain("owner/repo");
    expect(html).toContain("11bd71901b"); // short commit in snapshot meta
    expect(html).toContain("Quick wins");
    expect(html).toContain("Needs review");
    expect(html).toContain('class="diff"'); // the permissions fix renders as a diff
    expect(html).toContain("chant 0.4.0");
  });

  test("escapes HTML in finding content (no injection)", () => {
    const evil: AuditFinding[] = [
      { checkId: "GHA036", severity: "error", message: "<script>alert(1)</script>", file: "a.yml", lexicon: "github" },
    ];
    const html = renderHtml(evil);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("applies theme knobs (title, accent)", () => {
    const html = renderHtml(FINDINGS, { theme: { title: "Acme Security", accent: "#ff0000" } });
    expect(html).toContain("<title>Acme Security</title>");
    expect(html).toContain("#ff0000");
  });

  test("honours a full template override", () => {
    const html = renderHtml(FINDINGS, { template: "<html>{{title}}::{{body}}</html>", theme: { title: "X" } });
    expect(html.startsWith("<html>X::")).toBe(true);
    expect(html).toContain("Quick wins"); // body still rendered
  });

  test("clean report when no findings", () => {
    const html = renderHtml([]);
    expect(html).toContain("No issues found.");
    expect(html).not.toContain("Quick wins");
  });
});
