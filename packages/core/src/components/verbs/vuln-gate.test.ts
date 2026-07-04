/**
 * Tests for #626's VEX suppression (./vex.ts), license policy
 * (./license-policy.ts), the `vuln-gate` capability (./vuln-gate.ts), and the
 * `vulnPolicy` config resolver (../../config.ts). All hermetic: the gate runs
 * over supplied findings or an inline fake scanner — no live scanner, network,
 * or vuln DB.
 */

import { describe, test, expect } from "vitest";
import { parseOpenVex, parseCycloneDxVex, parseVexDocument, applyVex } from "./vex";
import { extractLicenses, evaluateLicensePolicy } from "./license-policy";
import { createVulnGateCapability, VulnGateFailedError, type VulnGateInput } from "./vuln-gate";
import type { VulnFinding, VulnScanner } from "./vuln-scan";
import type { SbomDocument } from "./sbom-generator";
import { resolveVulnPolicy } from "../../config";

const ctx = { env: "prod", component: "search-service" };

const CRIT_FIXABLE: VulnFinding = { cveId: "CVE-1", severity: "critical", package: "a", installedVersion: "1", fixedVersion: "2", fixable: true };
const CRIT_UNFIXABLE: VulnFinding = { cveId: "CVE-2", severity: "critical", package: "b", installedVersion: "1", fixable: false };
const HIGH_FIXABLE: VulnFinding = { cveId: "CVE-3", severity: "high", package: "c", installedVersion: "1", fixedVersion: "2", fixable: true };

const SBOM_SPDX: SbomDocument = {
  format: "spdx",
  mediaType: "application/spdx+json",
  bytes: JSON.stringify({ packages: [{ name: "gpl-lib", licenseConcluded: "GPL-3.0" }, { name: "mit-lib", licenseConcluded: "MIT" }, { name: "no-lic", licenseConcluded: "NOASSERTION" }] }),
  generator: "lockfile",
};

// ── VEX ──────────────────────────────────────────────────────────────────────

describe("VEX parsing", () => {
  test("parseOpenVex handles vulnerability as string and as object", () => {
    const doc = JSON.stringify({
      statements: [
        { vulnerability: "CVE-1", status: "not_affected", justification: "vulnerable_code_not_in_execute_path" },
        { vulnerability: { name: "CVE-3" }, status: "affected" },
      ],
    });
    const stmts = parseOpenVex(doc);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toEqual({ cveId: "CVE-1", status: "not_affected", justification: "vulnerable_code_not_in_execute_path" });
    expect(stmts[1].status).toBe("affected");
  });

  test("parseCycloneDxVex maps analysis.state", () => {
    const doc = JSON.stringify({
      vulnerabilities: [
        { id: "CVE-1", analysis: { state: "not_affected", justification: "code_not_reachable" } },
        { id: "CVE-9", analysis: { state: "resolved" } },
      ],
    });
    const stmts = parseCycloneDxVex(doc);
    expect(stmts[0].status).toBe("not_affected");
    expect(stmts[1].status).toBe("fixed");
  });

  test("parseVexDocument dispatches on shape", () => {
    expect(parseVexDocument(JSON.stringify({ statements: [{ vulnerability: "CVE-1", status: "fixed" }] }))[0].status).toBe("fixed");
    expect(parseVexDocument(JSON.stringify({ vulnerabilities: [{ id: "CVE-1", analysis: { state: "exploitable" } }] }))[0].status).toBe("affected");
  });

  test("applyVex suppresses not_affected/fixed, keeps affected, reports justification", () => {
    const { gating, suppressed } = applyVex(
      [CRIT_FIXABLE, HIGH_FIXABLE],
      [{ cveId: "CVE-1", status: "not_affected", justification: "not reachable" }],
    );
    expect(gating.map((f) => f.cveId)).toEqual(["CVE-3"]);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].justification).toBe("not reachable");
  });
});

// ── licenses ─────────────────────────────────────────────────────────────────

describe("license policy", () => {
  test("extractLicenses reads SPDX and CycloneDX", () => {
    expect(extractLicenses(SBOM_SPDX).find((l) => l.package === "gpl-lib")?.license).toBe("GPL-3.0");
    const cdx: SbomDocument = {
      format: "cyclonedx",
      mediaType: "application/vnd.cyclonedx+json",
      bytes: JSON.stringify({ components: [{ name: "x", licenses: [{ license: { id: "Apache-2.0" } }] }] }),
      generator: "lockfile",
    };
    expect(extractLicenses(cdx)[0].license).toBe("Apache-2.0");
  });

  test("deny flags a denied license; NOASSERTION is skipped", () => {
    const violations = evaluateLicensePolicy(SBOM_SPDX, { deny: ["GPL-3.0"] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({ package: "gpl-lib", license: "GPL-3.0", reason: "denied" });
  });

  test("allowlist flags anything not on it (case-insensitive)", () => {
    const violations = evaluateLicensePolicy(SBOM_SPDX, { allow: ["mit"] });
    expect(violations.map((v) => v.package)).toEqual(["gpl-lib"]);
    expect(violations[0].reason).toBe("not-allowed");
  });
});

// ── the gate ─────────────────────────────────────────────────────────────────

function gate(input: VulnGateInput) {
  return createVulnGateCapability().run(ctx, input);
}

describe("vuln-gate", () => {
  test("passes on a clean set, reporting high findings as warnings (default policy)", async () => {
    const out = await gate({ sbom: SBOM_SPDX, findings: [HIGH_FIXABLE] });
    expect(out.passed).toBe(true);
    expect(out.warnings.map((f) => f.cveId)).toEqual(["CVE-3"]);
  });

  test("FAILS on an unsuppressed critical + fixable finding", async () => {
    await expect(gate({ sbom: SBOM_SPDX, findings: [CRIT_FIXABLE] })).rejects.toBeInstanceOf(VulnGateFailedError);
  });

  test("a VEX not_affected statement suppresses the blocking finding (gate passes)", async () => {
    const vex = JSON.stringify({ statements: [{ vulnerability: "CVE-1", status: "not_affected", justification: "not reachable" }] });
    const out = await gate({ sbom: SBOM_SPDX, findings: [CRIT_FIXABLE], vex: [vex] });
    expect(out.passed).toBe(true);
    expect(out.suppressed[0].finding.cveId).toBe("CVE-1");
  });

  test("critical but NOT fixable does not block under the default fixableOnly, it warns", async () => {
    const out = await gate({ sbom: SBOM_SPDX, findings: [CRIT_UNFIXABLE], policy: { warnSeverity: "critical" } });
    expect(out.passed).toBe(true);
    expect(out.warnings.map((f) => f.cveId)).toEqual(["CVE-2"]);
  });

  test("license: report-only by default (no block), blocks when failOnLicense", async () => {
    const reportOnly = await gate({ sbom: SBOM_SPDX, findings: [], policy: { license: { deny: ["GPL-3.0"] } } });
    expect(reportOnly.passed).toBe(true);
    expect(reportOnly.licenseFindings).toHaveLength(1);

    await expect(
      gate({ sbom: SBOM_SPDX, findings: [], policy: { license: { deny: ["GPL-3.0"] }, failOnLicense: true } }),
    ).rejects.toBeInstanceOf(VulnGateFailedError);
  });

  test("scans via the injected scanner when findings are not supplied", async () => {
    const fake: VulnScanner = { async scan() { return [CRIT_FIXABLE]; } };
    await expect(createVulnGateCapability(fake).run(ctx, { sbom: SBOM_SPDX })).rejects.toBeInstanceOf(VulnGateFailedError);
  });
});

// ── config resolver ──────────────────────────────────────────────────────────

describe("resolveVulnPolicy", () => {
  test("empty for no config; passes through set fields", () => {
    expect(resolveVulnPolicy({})).toEqual({});
    expect(resolveVulnPolicy({ vulnPolicy: { failSeverity: "high", fixableOnly: false, failOnLicense: true, license: { deny: ["GPL-3.0"] } } })).toEqual({
      failSeverity: "high",
      fixableOnly: false,
      failOnLicense: true,
      license: { deny: ["GPL-3.0"] },
    });
  });
});
