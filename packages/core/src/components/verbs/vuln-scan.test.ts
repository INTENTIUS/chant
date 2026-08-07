/**
 * Tests for #626's vulnerability scanning (./vuln-scan.ts): scanner output
 * parsing, the real `ProcessRunner`-backed tool scanner (against a
 * `MockProcessRunner` — never a live grype/trivy), and the
 * `scan-vulnerabilities` capability over an injected scanner.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, expect } from "vitest";
import {
  normalizeSeverity,
  parseGrypeOutput,
  parseTrivyOutput,
  createToolVulnScanner,
  createScanVulnerabilitiesCapability,
  autoDetectVulnScanner,
  type VulnFinding,
  type VulnScanner,
} from "./vuln-scan";
import { ToolNotAvailableError } from "./process-runner";
import type { SbomDocument } from "./sbom-generator";
import { createMockProcessRunner } from "./__tests__/mock-process-runner";

const ctx = { env: "prod", component: "search-service" };

const FIXTURES_DIR = join(import.meta.dirname, "__fixtures__");

const SBOM: SbomDocument = {
  format: "spdx",
  mediaType: "application/spdx+json",
  bytes: JSON.stringify({ packages: [{ name: "lodash", licenseConcluded: "MIT" }] }),
  generator: "lockfile",
};

const GRYPE_JSON = JSON.stringify({
  matches: [
    {
      vulnerability: { id: "CVE-2024-0001", severity: "Critical", fix: { versions: ["4.17.21"], state: "fixed" } },
      artifact: { name: "lodash", version: "4.17.20" },
    },
    {
      vulnerability: { id: "CVE-2024-0002", severity: "Low", fix: { versions: [], state: "not-fixed" } },
      artifact: { name: "left-pad", version: "1.0.0" },
    },
  ],
});

describe("normalizeSeverity", () => {
  test("normalizes case and maps unknowns to 'unknown'", () => {
    expect(normalizeSeverity("Critical")).toBe("critical");
    expect(normalizeSeverity("HIGH")).toBe("high");
    expect(normalizeSeverity("Negligible")).toBe("negligible");
    expect(normalizeSeverity("bananas")).toBe("unknown");
    expect(normalizeSeverity(undefined)).toBe("unknown");
  });
});

describe("parseGrypeOutput", () => {
  test("maps matches to findings, deriving fixability", () => {
    const findings = parseGrypeOutput(GRYPE_JSON);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toEqual<VulnFinding>({
      cveId: "CVE-2024-0001",
      severity: "critical",
      package: "lodash",
      installedVersion: "4.17.20",
      fixedVersion: "4.17.21",
      fixable: true,
    });
    expect(findings[1].fixable).toBe(false);
    expect(findings[1].severity).toBe("low");
  });
});

describe("parseTrivyOutput", () => {
  test("flattens Results[].Vulnerabilities into findings", () => {
    const trivy = JSON.stringify({
      Results: [
        { Vulnerabilities: [{ VulnerabilityID: "CVE-2024-0003", Severity: "HIGH", PkgName: "openssl", InstalledVersion: "1.1.1", FixedVersion: "1.1.1w" }] },
      ],
    });
    const findings = parseTrivyOutput(trivy);
    expect(findings).toHaveLength(1);
    expect(findings[0].cveId).toBe("CVE-2024-0003");
    expect(findings[0].fixable).toBe(true);
    expect(findings[0].fixedVersion).toBe("1.1.1w");
  });
});

// ── exploitability parsing (#1463, over real captured scanner output) ────────
// Fixtures are unmodified `grype -o json` (v0.116.1) / `trivy sbom --format
// json` (v0.73.0) stdout from scanning a CycloneDX SBOM containing
// log4j-core@2.14.1 — a package with KEV-listed CVEs (Log4Shell).

describe("exploitability parsing (#1463)", () => {
  const grypeFixture = readFileSync(join(FIXTURES_DIR, "grype-with-kev-epss.json"), "utf8");
  const trivyFixture = readFileSync(join(FIXTURES_DIR, "trivy-with-kev-epss.json"), "utf8");

  test("parseGrypeOutput carries KEV membership, dates, ransomware use, and EPSS through to the finding", () => {
    const findings = parseGrypeOutput(grypeFixture);
    const log4shell = findings.find((f) => f.epssPercentile === 1);
    expect(log4shell).toBeDefined();
    expect(log4shell!.inKev).toBe(true);
    expect(log4shell!.kevDateAdded).toBe("2021-12-10");
    expect(log4shell!.kevDueDate).toBe("2021-12-24");
    expect(log4shell!.kevRansomware).toBe(true);
    expect(log4shell!.epss).toBeCloseTo(0.99999, 5);
    // The severity-shaped fields still parse as before on the same match.
    expect(log4shell!.severity).toBe("critical");
    expect(log4shell!.package).toBe("log4j-core");
    expect(log4shell!.fixable).toBe(true);
  });

  test("grype omitting the KEV annotation leaves inKev undefined — reported-absent and not-reported are different states", () => {
    const findings = parseGrypeOutput(grypeFixture);
    const nonKev = findings.filter((f) => f.inKev === undefined);
    expect(nonKev.length).toBeGreaterThan(0);
    for (const f of nonKev) {
      // undefined !== false: grype said nothing about KEV for these, which is
      // not the same conclusion as grype reporting "not in KEV".
      expect(f.inKev).not.toBe(false);
      expect(f.kevDateAdded).toBeUndefined();
      expect(f.kevDueDate).toBeUndefined();
      expect(f.kevRansomware).toBeUndefined();
      // EPSS is independent of KEV — grype scores these too.
      expect(f.epss).toBeTypeOf("number");
    }
  });

  test("parseTrivyOutput leaves every exploitability field undefined — trivy reports none of them", () => {
    const findings = parseTrivyOutput(trivyFixture);
    expect(findings.length).toBeGreaterThan(0);
    const log4shell = findings.find((f) => f.cveId === "CVE-2021-44228");
    expect(log4shell).toBeDefined();
    expect(log4shell!.severity).toBe("critical");
    for (const f of findings) {
      expect(f.epss).toBeUndefined();
      expect(f.epssPercentile).toBeUndefined();
      expect(f.inKev).toBeUndefined();
      expect(f.inKev).not.toBe(false);
      expect(f.kevDateAdded).toBeUndefined();
      expect(f.kevDueDate).toBeUndefined();
      expect(f.kevRansomware).toBeUndefined();
    }
  });

  test("a grype document with no exploitability data parses to findings with all six fields undefined", () => {
    const findings = parseGrypeOutput(GRYPE_JSON);
    for (const f of findings) {
      expect(f.epss).toBeUndefined();
      expect(f.epssPercentile).toBeUndefined();
      expect(f.inKev).toBeUndefined();
      expect(f.kevDateAdded).toBeUndefined();
      expect(f.kevDueDate).toBeUndefined();
      expect(f.kevRansomware).toBeUndefined();
    }
  });

  test("KEV ransomware 'unknown' stays undefined, not false — KEV's tri-state survives", () => {
    const doc = JSON.stringify({
      matches: [
        {
          vulnerability: {
            id: "CVE-2024-0004",
            severity: "High",
            fix: { versions: ["2.0"], state: "fixed" },
            epss: [{ cve: "CVE-2024-0004", epss: 0.5, percentile: 0.9, date: "2026-08-01" }],
            knownExploited: [{ cve: "CVE-2024-0004", dateAdded: "2026-01-01", dueDate: "2026-01-22", knownRansomwareCampaignUse: "unknown" }],
          },
          artifact: { name: "widget", version: "1.0" },
        },
      ],
    });
    const [f] = parseGrypeOutput(doc);
    expect(f.inKev).toBe(true);
    expect(f.kevRansomware).toBeUndefined();
  });
});

describe("createToolVulnScanner (grype, via MockProcessRunner)", () => {
  test("scans the SBOM with `grype sbom:<file>` and parses the result", async () => {
    const mock = createMockProcessRunner({ tools: { grype: true }, responses: { "grype sbom:": GRYPE_JSON } });
    const scanner = createToolVulnScanner("grype", mock.runner);
    const findings = await scanner.scan({ sbom: SBOM, digest: "sha256:abc" });
    expect(findings).toHaveLength(2);
    const scanCall = mock.calls.find((c) => c.command.includes("grype sbom:"));
    expect(scanCall).toBeDefined();
    expect(scanCall!.command).toContain("-o json");
  });

  test("throws ToolNotAvailableError when grype is absent (never a silent empty scan)", async () => {
    const mock = createMockProcessRunner({ tools: { grype: false }, defaultAvailable: false });
    const scanner = createToolVulnScanner("grype", mock.runner);
    await expect(scanner.scan({ sbom: SBOM })).rejects.toBeInstanceOf(ToolNotAvailableError);
  });
});

describe("autoDetectVulnScanner — the registered default (#634)", () => {
  const TRIVY_JSON = JSON.stringify({
    Results: [{ Vulnerabilities: [{ VulnerabilityID: "CVE-2024-9999", Severity: "HIGH", PkgName: "lodash", InstalledVersion: "4.17.20", FixedVersion: "4.17.21" }] }],
  });

  test("prefers grype when present", async () => {
    const mock = createMockProcessRunner({ tools: { grype: true, trivy: true }, responses: { "grype sbom:": GRYPE_JSON } });
    const findings = await autoDetectVulnScanner(mock.runner).scan({ sbom: SBOM });
    expect(findings).toHaveLength(2);
    expect(mock.calls.some((c) => c.command.includes("grype sbom:"))).toBe(true);
    expect(mock.calls.some((c) => c.command.includes("trivy sbom"))).toBe(false);
  });

  test("falls back to trivy when grype is absent", async () => {
    const mock = createMockProcessRunner({ tools: { grype: false, trivy: true }, defaultAvailable: false, responses: { "trivy sbom": TRIVY_JSON } });
    const findings = await autoDetectVulnScanner(mock.runner).scan({ sbom: SBOM });
    expect(findings).toHaveLength(1);
    expect(mock.calls.some((c) => c.command.includes("trivy sbom"))).toBe(true);
  });

  test("throws ToolNotAvailableError naming both tools when neither is installed (not VulnScannerNotImplementedError)", async () => {
    const mock = createMockProcessRunner({ tools: { grype: false, trivy: false }, defaultAvailable: false });
    await expect(autoDetectVulnScanner(mock.runner).scan({ sbom: SBOM })).rejects.toBeInstanceOf(ToolNotAvailableError);
    await expect(autoDetectVulnScanner(mock.runner).scan({ sbom: SBOM })).rejects.toThrow(/grype or trivy/);
  });
});

describe("scan-vulnerabilities capability", () => {
  test("returns the scanner's findings and echoes the digest", async () => {
    const fake: VulnScanner = {
      async scan() {
        return parseGrypeOutput(GRYPE_JSON);
      },
    };
    const cap = createScanVulnerabilitiesCapability(fake);
    expect(cap.kind).toBe("scan-vulnerabilities");
    const out = await cap.run(ctx, { sbom: SBOM, digest: "sha256:xyz" });
    expect(out.findings).toHaveLength(2);
    expect(out.digest).toBe("sha256:xyz");
  });
});
