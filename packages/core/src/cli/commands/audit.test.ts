import { describe, test, expect } from "vitest";
import { fileURLToPath } from "url";
import { auditCommand, tokenForHost, coverageNotes, installLine, NO_LEXICONS_EXIT_CODE } from "./audit";
import { discoverByDetection, loadAuditPlugins } from "../../audit/discover";
import { MissingLexiconError, type AuditInput, type AuditLexicon } from "../../audit/core";

/** Discover with all audit lexicons loaded, then keep one lexicon's inputs. */
async function discoverLexicon(repo: string, lexicon: AuditLexicon): Promise<AuditInput[]> {
  return discoverByDetection(repo, await loadAuditPlugins()).filter((i) => i.lexicon === lexicon);
}
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fingerprintSecret } from "../../audit/secrets";

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

  test("discovers and audits Kubernetes manifests", async () => {
    const repo = fileURLToPath(new URL("./__fixtures__/audit-k8s", import.meta.url));
    const files = await discoverLexicon(repo, "k8s");
    expect(files.map((f) => f.path)).toContain("manifests/deploy.yaml");
    expect(files.every((f) => f.lexicon === "k8s")).toBe(true);

    const result = await auditCommand({ path: repo, format: "stylish" });
    expect(result.success).toBe(true);
    const ids = new Set(result.findings.map((f) => f.checkId));
    expect(ids).toContain("WK8202"); // privileged container
    expect(ids).toContain("WK8006"); // :latest image
  });

  test("discovers and audits Docker artifacts (nested Dockerfile + compose)", async () => {
    const repo = fileURLToPath(new URL("./__fixtures__/audit-docker", import.meta.url));
    const files = await discoverLexicon(repo, "docker");
    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain("app/Dockerfile");
    expect(paths).toContain("docker-compose.yml");

    const result = await auditCommand({ path: repo, format: "stylish" });
    expect(result.success).toBe(true);
    const ids = new Set(result.findings.map((f) => f.checkId));
    expect(ids).toContain("DKRD012"); // Dockerfile has no USER (nested — basename-key fix)
    expect(ids).toContain("DKRD010"); // apt-get without --no-install-recommends
    expect(ids).toContain("DKRD003"); // compose exposes SSH port 22
  });

  test("discovers and audits CloudFormation (JSON and YAML)", async () => {
    const repo = fileURLToPath(new URL("./__fixtures__/audit-aws", import.meta.url));
    const files = await discoverLexicon(repo, "aws");
    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain("template.json");
    expect(paths).toContain("stack.yaml");
    // YAML is normalized to a JSON string the aws checks can JSON.parse.
    expect(() => JSON.parse(files.find((f) => f.path === "stack.yaml")!.content)).not.toThrow();

    const result = await auditCommand({ path: repo, format: "stylish" });
    expect(result.success).toBe(true);
    const ids = new Set(result.findings.map((f) => f.checkId));
    expect(ids).toContain("WAW018"); // S3 missing public access block (JSON template)
    expect(ids).toContain("WAW021"); // RDS not encrypted (JSON template)
    expect(ids).toContain("WAW019"); // SG open SSH (YAML template — proves YAML works)
  });

  test("discovers and audits Azure ARM templates", async () => {
    const repo = fileURLToPath(new URL("./__fixtures__/audit-azure", import.meta.url));
    expect((await discoverLexicon(repo, "azure")).map((f) => f.path)).toContain("azuredeploy.json");
    const result = await auditCommand({ path: repo, format: "stylish" });
    expect(result.success).toBe(true);
    const ids = new Set(result.findings.map((f) => f.checkId));
    expect(ids).toContain("AZR014"); // storage allows public blob access
  });

  test("discovers and audits GCP Config Connector (not misclassified as k8s)", async () => {
    const repo = fileURLToPath(new URL("./__fixtures__/audit-gcp", import.meta.url));
    const gcp = await discoverLexicon(repo, "gcp");
    expect(gcp.map((f) => f.path).sort()).toEqual(["bucket.yaml", "firewall.yaml"]);
    // cnrm manifests must NOT also be picked up as k8s.
    expect(await discoverLexicon(repo, "k8s")).toEqual([]);

    const result = await auditCommand({ path: repo, format: "stylish" });
    expect(result.success).toBe(true);
    const ids = new Set(result.findings.map((f) => f.checkId));
    expect(ids).toContain("WGC109"); // firewall open to 0.0.0.0/0
    // k8s checks did not run on these.
    expect([...ids].some((id) => id.startsWith("WK8"))).toBe(false);
  });

  test("discovers and audits fountain manifests (not misclassified as k8s) — FTN rules fire (#1566/#1567)", async () => {
    const repo = fileURLToPath(new URL("./__fixtures__/audit-fountain", import.meta.url));
    const fountain = await discoverLexicon(repo, "fountain");
    expect(fountain.map((f) => f.path)).toEqual(["agents/fleet.yaml"]);
    // The fountain manifest is NOT also picked up as k8s; the plain k8s manifest still is.
    expect((await discoverLexicon(repo, "k8s")).map((f) => f.path)).toEqual(["k8s/deploy.yaml"]);

    const result = await auditCommand({ path: repo, format: "stylish" });
    expect(result.success).toBe(true);
    const ftn = result.findings.filter((f) => f.checkId.startsWith("FTN"));
    const ids = new Set(ftn.map((f) => f.checkId));
    expect(ids).toContain("FTN011"); // unrestricted networking
    expect(ids).toContain("FTN012"); // credential-shaped env_vars key
    expect(ids).toContain("FTN014"); // vault key shadows an environment key
    expect(ftn.find((f) => f.checkId === "FTN012")!.severity).toBe("error");
    for (const f of ftn) {
      expect(f.lexicon).toBe("fountain");
      expect(f.file).toBe("agents/fleet.yaml");
    }
    // No k8s check ran against the fountain manifest.
    for (const f of result.findings.filter((f) => f.lexicon === "k8s")) {
      expect(f.file).not.toBe("agents/fleet.yaml");
    }
  });

  test("fountain findings carry their authority citations in json, sarif, and markdown", async () => {
    const repo = fileURLToPath(new URL("./__fixtures__/audit-fountain", import.meta.url));

    const json = await auditCommand({ path: repo, format: "json" });
    const envelope = JSON.parse(json.output) as { findings: Array<{ checkId: string; authority: Array<{ url: string }>; severity: string }> };
    const ftn11 = envelope.findings.find((f) => f.checkId === "FTN011")!;
    expect(ftn11.authority.length).toBeGreaterThan(0);
    expect(ftn11.authority[0].url).toContain("fountain");
    expect(envelope.findings.find((f) => f.checkId === "FTN012")!.severity).toBe("error");

    const sarif = await auditCommand({ path: repo, format: "sarif" });
    const run = (JSON.parse(sarif.output) as { runs: Array<{ tool: { driver: { rules: Array<{ id: string; helpUri?: string }> } }; results: Array<{ ruleId: string }> }> }).runs[0];
    expect(run.results.some((r) => r.ruleId === "FTN011")).toBe(true);
    expect(run.tool.driver.rules.find((r) => r.id === "FTN011")!.helpUri).toContain("fountain");

    const md = await auditCommand({ path: repo, format: "markdown" });
    expect(md.output).toContain("FTN011");
    expect(md.output).toContain("FTN014");
  });

  test("a clean fountain manifest set audits quiet", async () => {
    const repo = fileURLToPath(new URL("./__fixtures__/audit-fountain-clean", import.meta.url));
    const result = await auditCommand({ path: repo, format: "stylish" });
    expect(result.success).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.scanned).toEqual(["fleet.yaml"]);
  });

  test("discovers and audits a Helm chart (as a bundle, not loose manifests)", async () => {
    const repo = fileURLToPath(new URL("./__fixtures__/audit-helm", import.meta.url));
    const charts = await discoverLexicon(repo, "helm");
    expect(charts).toHaveLength(1);
    expect(charts[0].lexicon).toBe("helm");
    expect(charts[0].files!["Chart.yaml"]).toContain("name: mychart");
    expect(charts[0].files!["templates/deployment.yaml"]).toContain("privileged");

    const result = await auditCommand({ path: repo, format: "stylish" });
    expect(result.success).toBe(true);
    const ids = new Set(result.findings.map((f) => f.checkId));
    expect(ids).toContain("WHM401"); // :latest image in the chart
    expect(ids).toContain("WHM404"); // privileged container in a template
    // the chart's template was NOT double-audited as a loose k8s manifest
    expect([...ids].some((id) => id.startsWith("WK8"))).toBe(false);
  });

  test("discovers CI files under a repo root", async () => {
    const files = await discoverLexicon(REPO, "github");
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
    expect(readFileSync(out, "utf-8")).toContain("# chant audit");
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

  describe("lexicon coverage (#1623)", () => {
    const MIXED = fileURLToPath(new URL("./__fixtures__/audit-coverage", import.meta.url));

    test("zero lexicons: says it had nothing to look with, names each file's lexicon, prints the npx line, exits 2", async () => {
      const result = await auditCommand({ path: MIXED, plugins: [] });
      expect(result.success).toBe(true);
      expect(result.status).toBe("no-lexicons");
      expect(result.exitCode).toBe(NO_LEXICONS_EXIT_CODE);
      expect(result.stream).toBe("stderr");
      expect(result.findings).toEqual([]);
      expect(result.output).toContain("nothing to look with");
      expect(result.output).not.toMatch(/Audited \d+ files/);
      expect(result.output).toContain(".github/workflows/ci.yml  ->  github");
      expect(result.output).toContain("k8s/deploy.yaml  ->  k8s");
      expect(result.output).toContain("infra/stack.json  ->  aws");
      expect(result.output).toContain("Dockerfile  ->  docker");
      expect(result.output).toContain("infra/main.tf  ->  terraform (not audited; see chant carve)");
      // The install line names only the lexicons the files wanted, never terraform.
      expect(result.output).toContain(
        `npx -p @intentius/chant -p @intentius/chant-lexicon-github -p @intentius/chant-lexicon-docker -p @intentius/chant-lexicon-aws -p @intentius/chant-lexicon-k8s chant audit ${MIXED}`,
      );
      expect(result.output).not.toContain("chant-lexicon-terraform");
    });

    test("zero lexicons with --json: status no-lexicons plus the unclaimed list and install line", async () => {
      const result = await auditCommand({ path: MIXED, plugins: [], format: "json" });
      expect(result.exitCode).toBe(NO_LEXICONS_EXIT_CODE);
      expect(result.stream).toBe("stdout");
      const json = JSON.parse(result.output);
      expect(json.status).toBe("no-lexicons");
      expect(json.findings).toEqual([]);
      expect(json.missingLexicons).toEqual(["github", "docker", "aws", "k8s"]);
      expect(json.unclaimed).toContainEqual({ path: "k8s/deploy.yaml", lexicon: "k8s" });
      expect(json.unclaimed).toContainEqual({ path: "infra/main.tf", lexicon: "terraform" });
      expect(json.install).toMatch(/^npx -p @intentius\/chant /);
    });

    test("zero lexicons on an empty dir still refuses to report clean", async () => {
      const tmp = join(tmpdir(), `chant-audit-nolex-${process.pid}`);
      const { mkdirSync } = await import("fs");
      mkdirSync(tmp, { recursive: true });
      const result = await auditCommand({ path: tmp, plugins: [] });
      expect(result.status).toBe("no-lexicons");
      expect(result.exitCode).toBe(NO_LEXICONS_EXIT_CODE);
      expect(result.output).toContain("nothing to look with");
      rmSync(tmp, { recursive: true, force: true });
    });

    test("partial: github loaded, k8s/aws/docker absent -> audit runs and a one-line hint names the gap", async () => {
      const all = await loadAuditPlugins();
      const github = all.filter((p) => p.name === "github");
      expect(github).toHaveLength(1);
      const result = await auditCommand({ path: MIXED, plugins: github });
      expect(result.status).toBe("ok");
      expect(result.exitCode).toBe(0);
      expect(result.scanned).toEqual([".github/workflows/ci.yml"]);
      expect(result.output).toMatch(/^Note: 3 files look like docker\/aws\/k8s but those lexicons are not installed, so they were skipped \(npm i @intentius\/chant-lexicon-docker @intentius\/chant-lexicon-aws @intentius\/chant-lexicon-k8s\)\./);
      expect(result.output).toContain("1 Terraform file skipped; the audit does not read HCL (see chant carve).");
      expect(result.unclaimed).toContainEqual({ path: "k8s/deploy.yaml", lexicon: "k8s" });
    });

    test("partial with --json: status ok and the unclaimed files ride along", async () => {
      const all = await loadAuditPlugins();
      const result = await auditCommand({ path: MIXED, plugins: all.filter((p) => p.name === "github"), format: "json" });
      const json = JSON.parse(result.output);
      expect(json.status).toBe("ok");
      expect(json.unclaimed.map((u: { lexicon: string }) => u.lexicon).sort()).toEqual(["aws", "docker", "k8s", "terraform"]);
    });

    test("all lexicons loaded: no coverage note, no unclaimed (terraform aside)", async () => {
      const result = await auditCommand({ path: MIXED, plugins: await loadAuditPlugins() });
      expect(result.status).toBe("ok");
      expect(result.unclaimed).toEqual([{ path: "infra/main.tf", lexicon: "terraform" }]);
      expect(result.output).not.toContain("not installed");
      expect(result.scanned.sort()).toEqual([".github/workflows/ci.yml", "Dockerfile", "infra/stack.json", "k8s/deploy.yaml"]);
    });

    test("installLine puts every lexicon on the same npx -p path", () => {
      expect(installLine(["github", "gitlab"], ".")).toBe("npx -p @intentius/chant -p @intentius/chant-lexicon-github -p @intentius/chant-lexicon-gitlab chant audit .");
    });
  });

  test("a path with no CI files succeeds with a clear message", async () => {
    const tmp = join(tmpdir(), `chant-audit-empty-${process.pid}`);
    const { mkdirSync } = await import("fs");
    mkdirSync(tmp, { recursive: true });
    const result = await auditCommand({ path: tmp });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("No auditable files found");
    rmSync(tmp, { recursive: true, force: true });
  });

  test("audits a remote repo URL via injected fetch", async () => {
    const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");
    const yaml = "name: CI\non:\n  push:\npermissions: write-all\njobs:\n  build:\n    runs-on: ubuntu-latest\n";
    const impl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/git/trees/")) {
        return new Response(JSON.stringify({ tree: [{ path: ".github/workflows/ci.yml", type: "blob", size: 100 }] }), { status: 200 });
      }
      if (u.includes("/contents/.github/workflows/ci.yml")) {
        return new Response(JSON.stringify({ name: "ci.yml", path: ".github/workflows/ci.yml", type: "file", content: b64(yaml), encoding: "base64" }), { status: 200 });
      }
      if (/\/repos\/acme\/widgets(\?|$)/.test(u)) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
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
      if (u.includes("/git/trees/")) {
        return new Response(JSON.stringify({ tree: [{ path: ".github/workflows/ci.yml", type: "blob", size: 100 }] }), { status: 200 });
      }
      if (u.includes("/contents/.github/workflows/ci.yml")) {
        return new Response(JSON.stringify({ name: "ci.yml", path: ".github/workflows/ci.yml", type: "file", content: b64(yaml), encoding: "base64" }), { status: 200 });
      }
      if (/\/repos\/acme\/widgets(\?|$)/.test(u)) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
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

describe("secrets detection (#443)", () => {
  // A deliberately fake, non-functional AWS-access-key-ID-shaped value, built
  // via concatenation (never a contiguous literal in this file's raw bytes)
  // so pushing this file doesn't trip GitHub's own secret-scanning push
  // protection on what is just a test fixture.
  const FAKE_AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP";
  const FAKE_STRIPE_LIVE = "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc";

  function tmpRepo(): string {
    const dir = join(tmpdir(), `chant-audit-secrets-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  test("flags a hardcoded credential even when no lexicon is installed", async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, ".env"), `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n`);
    const result = await auditCommand({ path: dir, plugins: [] });
    expect(result.status).toBe("no-lexicons"); // no lexicon installed — still not a clean miss
    expect(result.findings.map((f) => f.checkId)).toContain("SEC001");
    expect(JSON.stringify(result.findings)).not.toContain(FAKE_AWS_KEY); // redaction
    rmSync(dir, { recursive: true, force: true });
  });

  test("a secret rides alongside lexicon findings, tiered and cataloged like any other finding", async () => {
    const dir = tmpRepo();
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(dir, ".github", "workflows", "ci.yml"),
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
    );
    writeFileSync(join(dir, ".env"), `STRIPE_KEY=${FAKE_STRIPE_LIVE}\n`);
    const all = await loadAuditPlugins();
    const result = await auditCommand({ path: dir, plugins: all.filter((p) => p.name === "github"), format: "json" });
    expect(result.status).toBe("ok");
    const json = JSON.parse(result.output);
    const sec = json.findings.find((f: { checkId: string }) => f.checkId === "SEC006");
    expect(sec).toBeDefined();
    expect(sec.tier).toBe("merge-worthy");
    expect(sec.category).toBe("security");
    expect(sec.file).toBe(".env");
    expect(JSON.stringify(json)).not.toContain(FAKE_STRIPE_LIVE); // redaction, incl. the JSON report
    rmSync(dir, { recursive: true, force: true });
  });

  test("an inline `chant-audit-ignore` marker suppresses the finding", async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, ".env"), `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY} # chant-audit-ignore: SEC001\n`);
    const result = await auditCommand({ path: dir, plugins: [] });
    expect(result.findings.map((f) => f.checkId)).not.toContain("SEC001");
    rmSync(dir, { recursive: true, force: true });
  });

  test(".chant-audit.json's allowlist suppresses a finding by fingerprint, without storing the secret", async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, ".env"), `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n`);
    const fingerprint = fingerprintSecret(FAKE_AWS_KEY);
    writeFileSync(join(dir, ".chant-audit.json"), JSON.stringify({ secrets: { allow: [{ ruleId: "SEC001", fingerprint }] } }));
    const result = await auditCommand({ path: dir, plugins: [] });
    expect(result.findings.map((f) => f.checkId)).not.toContain("SEC001");
    rmSync(dir, { recursive: true, force: true });
  });

  test("an explicit secretsScan option overrides (and wins over) the local config", async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, "config.yaml"), "token: kQ7mZ9pL2xR8vT4nW1sD6uJ3\n");
    writeFileSync(join(dir, ".chant-audit.json"), JSON.stringify({ secrets: { entropyThreshold: 1 } }));
    const result = await auditCommand({ path: dir, plugins: [], secretsScan: { entropyThreshold: 6.5 } });
    expect(result.findings.map((f) => f.checkId)).not.toContain("SEC010");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Wrangler config audit (#446)", () => {
  function tmpRepo(): string {
    const dir = join(tmpdir(), `chant-audit-wrangler-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  test("audits wrangler.toml end to end, even when no lexicon is installed", async () => {
    const dir = tmpRepo();
    writeFileSync(
      join(dir, "wrangler.toml"),
      [
        'name = "my-worker"',
        "",
        "[observability]",
        "enabled = false",
        "",
        "[env.production]",
        "workers_dev = true",
      ].join("\n"),
    );
    const result = await auditCommand({ path: dir, plugins: [], format: "json" });
    expect(result.status).toBe("no-lexicons"); // no lexicon installed — still not a clean miss
    const ids = result.findings.map((f) => f.checkId);
    expect(ids).toContain("WRG001");
    expect(ids).toContain("WRG003");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a wrangler finding is tiered and cataloged like any other finding, alongside lexicon findings", async () => {
    const dir = tmpRepo();
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(dir, ".github", "workflows", "ci.yml"),
      "name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
    );
    writeFileSync(join(dir, "wrangler.toml"), 'routes = ["*/*"]\n');
    const all = await loadAuditPlugins();
    const result = await auditCommand({ path: dir, plugins: all.filter((p) => p.name === "github"), format: "json" });
    expect(result.status).toBe("ok");
    const json = JSON.parse(result.output);
    const wrg = json.findings.find((f: { checkId: string }) => f.checkId === "WRG004");
    expect(wrg).toBeDefined();
    expect(wrg.tier).toBe("merge-worthy");
    expect(wrg.category).toBe("security");
    expect(wrg.file).toBe("wrangler.toml");
    expect(wrg.docUrl).toBe("https://intentius.io/chant/lint-rules/audit-rules/#wrg004");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a malformed wrangler.toml contributes no findings, never fails the audit", async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, "wrangler.toml"), "not = valid = toml = [\n");
    const result = await auditCommand({ path: dir, plugins: [] });
    expect(result.success).toBe(true);
    expect(result.findings.map((f) => f.checkId)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^WRG/)]));
    rmSync(dir, { recursive: true, force: true });
  });
});
