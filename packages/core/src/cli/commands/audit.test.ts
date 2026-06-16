import { describe, test, expect } from "vitest";
import { fileURLToPath } from "url";
import { auditCommand, discoverCiFiles, tokenForHost, coverageNotes } from "./audit";
import { MissingLexiconError, type AuditInput } from "../../audit/core";
import { readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = fileURLToPath(new URL("./__fixtures__/audit-repo", import.meta.url));

describe("auditCommand", () => {
  test("selects a host-specific token (no cross-host leakage)", () => {
    const env = { GITHUB_TOKEN: "gh", GITLAB_TOKEN: "gl", CODEBERG_TOKEN: "cb" } as unknown as NodeJS.ProcessEnv;
    expect(tokenForHost("https://github.com/o/r", env)).toBe("gh");
    expect(tokenForHost("https://gitlab.com/o/r", env)).toBe("gl");
    expect(tokenForHost("https://codeberg.org/o/r", env)).toBe("cb");
    // A GitHub token is never offered to other hosts.
    const onlyGh = { GITHUB_TOKEN: "gh" } as unknown as NodeJS.ProcessEnv;
    expect(tokenForHost("https://gitlab.com/o/r", onlyGh)).toBeUndefined();
    expect(tokenForHost("https://codeberg.org/o/r", onlyGh)).toBeUndefined();
  });

  test("coverageNotes flags unresolved GitLab includes", () => {
    const withInc: AuditInput[] = [{ path: ".gitlab-ci.yml", content: "include:\n  - local: a.yml\nbuild:\n  script: [echo]\n", lexicon: "gitlab" }];
    expect(coverageNotes(withInc)[0]).toMatch(/include:/);
    const without: AuditInput[] = [{ path: ".gitlab-ci.yml", content: "build:\n  script: [echo]\n", lexicon: "gitlab" }];
    expect(coverageNotes(without)).toEqual([]);
    // github files never produce the gitlab include note
    const gh: AuditInput[] = [{ path: ".github/workflows/ci.yml", content: "on: push\n", lexicon: "github" }];
    expect(coverageNotes(gh)).toEqual([]);
  });

  test("discovers CI files under a repo root", () => {
    const files = discoverCiFiles(REPO);
    expect(files.map((f) => f.path)).toContain(".github/workflows/ci.yml");
    expect(files.every((f) => f.lexicon === "github")).toBe(true);
  });

  test("reports merge-worthy findings on the fixture repo", async () => {
    const result = await auditCommand({ path: REPO, format: "stylish" });
    expect(result.success).toBe(true);
    const ids = new Set(result.findings.map((f) => f.checkId));
    expect(ids).toContain("GHA033");
    expect(ids).toContain("GHA021");
    expect(result.output).toContain("Merge-worthy:");
  });

  test("--json emits the versioned envelope with snapshot, summary, findings", async () => {
    const result = await auditCommand({ path: REPO, format: "json", toolVersion: "0.4.0" });
    const parsed = JSON.parse(result.output);
    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.tool).toEqual({ name: "chant-audit", version: "0.4.0" });
    expect(parsed.snapshot.files).toContain(".github/workflows/ci.yml");
    expect(parsed.snapshot.toolVersion).toBe("0.4.0");
    expect(parsed.summary.total).toBeGreaterThan(0);
    expect(Array.isArray(parsed.findings)).toBe(true);
    // Each finding carries its classification, so consumers can filter.
    const f = parsed.findings.find((x: { checkId: string }) => x.checkId === "GHA033");
    expect(f.tier).toBe("merge-worthy");
    expect(f.fixKind).toBe("deterministic");
    expect(Array.isArray(f.authority)).toBe(true);
  });

  test("--fail-on merge-worthy exits nonzero when merge-worthy findings exist", async () => {
    const fail = await auditCommand({ path: REPO, failOn: "merge-worthy" });
    expect(fail.exitCode).toBe(1);
    const none = await auditCommand({ path: REPO, failOn: "none" });
    expect(none.exitCode).toBe(0);
  });

  test("--tier merge-worthy filters out report-only findings", async () => {
    const all = await auditCommand({ path: REPO, tier: "all" });
    const mw = await auditCommand({ path: REPO, tier: "merge-worthy" });
    expect(mw.findings.length).toBeLessThanOrEqual(all.findings.length);
    expect(mw.findings.some((f) => f.checkId === "GHA022")).toBe(false); // report-only
  });

  test("writes the report to --output instead of returning it for stdout", async () => {
    const out = join(tmpdir(), `chant-audit-test-${process.pid}.md`);
    if (existsSync(out)) rmSync(out);
    const result = await auditCommand({ path: REPO, format: "markdown", output: out });
    expect(result.success).toBe(true);
    expect(result.wroteTo).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf-8")).toContain("# CI security audit");
    rmSync(out);
  });

  test("surfaces a friendly error when a lexicon package is missing", async () => {
    const result = await auditCommand({
      path: REPO,
      checksProvider: async () => {
        throw new MissingLexiconError("Missing lexicon package needed to audit github workflows. Install it with: npm i @intentius/chant-lexicon-github");
      },
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toMatch(/npm i @intentius\/chant-lexicon-github/);
  });

  test("a path with no CI files succeeds with a clear message", async () => {
    const tmp = fileURLToPath(new URL(".", import.meta.url)); // commands dir, no CI files
    const result = await auditCommand({ path: tmp });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("No CI files found");
  });

  test("audits a remote repo URL via injected fetch", async () => {
    const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");
    const yaml = "name: CI\non:\n  push:\npermissions: write-all\njobs:\n  build:\n    runs-on: ubuntu-latest\n";
    const impl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/contents/.github/workflows/ci.yml")) {
        return new Response(JSON.stringify({ name: "ci.yml", path: ".github/workflows/ci.yml", type: "file", content: b64(yaml), encoding: "base64" }), { status: 200 });
      }
      if (u.includes("/contents/.github/workflows")) {
        return new Response(JSON.stringify([{ name: "ci.yml", path: ".github/workflows/ci.yml", type: "file", size: 100 }]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await auditCommand({ path: "https://github.com/acme/widgets", fetchImpl: impl });
    expect(result.success).toBe(true);
    expect(result.scanned).toContain(".github/workflows/ci.yml");
    expect(result.findings.some((f) => f.checkId === "GHA033")).toBe(true);
  });

  test("remote markdown audit inlines a pin diff using resolved SHAs", async () => {
    const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");
    const sha = "11bd71901bbe5b1630ceea73d27597364c9af683";
    const yaml = "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n";
    const impl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/commits/v4")) return new Response(JSON.stringify({ sha }), { status: 200 });
      if (u.includes("/contents/.github/workflows/ci.yml")) {
        return new Response(JSON.stringify({ name: "ci.yml", path: ".github/workflows/ci.yml", type: "file", content: b64(yaml), encoding: "base64" }), { status: 200 });
      }
      if (u.includes("/contents/.github/workflows")) {
        return new Response(JSON.stringify([{ name: "ci.yml", path: ".github/workflows/ci.yml", type: "file", size: 100 }]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await auditCommand({ path: "https://github.com/acme/widgets", format: "markdown", fetchImpl: impl });
    expect(result.output).toContain(`actions/checkout@${sha}`);
    expect(result.output).toContain("```diff");
  });

  test("html format renders a self-contained document with a snapshot", async () => {
    const result = await auditCommand({ path: REPO, format: "html", now: "2026-06-16T00:00:00.000Z", toolVersion: "0.4.0" });
    expect(result.success).toBe(true);
    expect(result.output.startsWith("<!doctype html>")).toBe(true);
    expect(result.output).toContain("chant 0.4.0");
    expect(result.output).toContain("local"); // host for a local audit
  });

  test("a non-allowlisted URL fails cleanly", async () => {
    const result = await auditCommand({ path: "https://evil.example.com/o/r" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Host not allowed/);
  });

  test("sarif output is valid JSON with results", async () => {
    const result = await auditCommand({ path: REPO, format: "sarif" });
    const sarif = JSON.parse(result.output);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results.length).toBeGreaterThan(0);
  });
});
