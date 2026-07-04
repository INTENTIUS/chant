/**
 * Tests for #626's vulnerability scanning (./vuln-scan.ts): scanner output
 * parsing, the real `ProcessRunner`-backed tool scanner (against a
 * `MockProcessRunner` — never a live grype/trivy), and the
 * `scan-vulnerabilities` capability over an injected scanner.
 */

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
