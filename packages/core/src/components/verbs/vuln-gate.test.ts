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
import { createVulnGateCapability, DEFAULT_VULN_POLICY, VulnGateFailedError, type VulnGateInput } from "./vuln-gate";
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

// ── audit hardening (#628) ───────────────────────────────────────────────────

describe("audit hardening (#628)", () => {
  const CRIT: VulnFinding = { cveId: "CVE-X", severity: "critical", package: "p", installedVersion: "1", fixedVersion: "2", fixable: true };
  const UNKNOWN: VulnFinding = { cveId: "CVE-U", severity: "unknown", package: "q", installedVersion: "1", fixable: true };

  test("VEX conservative merge: an `affected` statement blocks a later `not_affected` from suppressing", () => {
    const { gating, suppressed } = applyVex(
      [CRIT],
      [
        { cveId: "CVE-X", status: "affected" },
        { cveId: "CVE-X", status: "not_affected", justification: "attacker-appended" },
      ],
    );
    expect(gating.map((f) => f.cveId)).toEqual(["CVE-X"]);
    expect(suppressed).toHaveLength(0);
  });

  test("malformed VEX does not crash and suppresses nothing (gate stays strict)", async () => {
    await expect(gate({ sbom: SBOM_SPDX, findings: [CRIT], vex: ['{"bad json'] })).rejects.toBeInstanceOf(VulnGateFailedError);
  });

  test("SPDX license expression: deny matches a license hidden in an OR expression", () => {
    const sbom: SbomDocument = {
      format: "spdx",
      mediaType: "application/spdx+json",
      generator: "lockfile",
      bytes: JSON.stringify({ packages: [{ name: "z", licenseConcluded: "GPL-3.0 OR MIT" }] }),
    };
    const v = evaluateLicensePolicy(sbom, { deny: ["GPL-3.0"] });
    expect(v).toHaveLength(1);
    expect(v[0].package).toBe("z");
  });

  test("unknown-severity is warned by default (never silently dropped), and blocks when opted in", async () => {
    const warned = await gate({ sbom: SBOM_SPDX, findings: [UNKNOWN] });
    expect(warned.passed).toBe(true);
    expect(warned.warnings.map((f) => f.cveId)).toEqual(["CVE-U"]);
    await expect(gate({ sbom: SBOM_SPDX, findings: [UNKNOWN], policy: { failOnUnknownSeverity: true } })).rejects.toBeInstanceOf(VulnGateFailedError);
  });
});

// ── exploitability shape (#1462, phase 0 of epic #1461) ──────────────────────

describe("exploitability policy shape (#1462)", () => {
  test("DEFAULT_VULN_POLICY does not gate on KEV — flipping failOnKev is a deliberate release decision (epic #1461), not a drive-by", () => {
    expect(DEFAULT_VULN_POLICY.failOnKev).toBe(false);
    expect(DEFAULT_VULN_POLICY.exploitabilityFixableOnly).toBe(true);
    expect(DEFAULT_VULN_POLICY.failEpssAtOrAbove).toBeUndefined();
    expect(DEFAULT_VULN_POLICY.warnEpssAtOrAbove).toBeUndefined();
  });

  test("a finding carrying exploitability fields passes through the gate with today's outcomes (evaluation is #1465)", async () => {
    const kevHigh: VulnFinding = {
      ...HIGH_FIXABLE,
      epss: 0.42,
      epssPercentile: 0.97,
      inKev: true,
      kevDateAdded: "2026-01-15",
      kevDueDate: "2026-02-05",
      kevRansomware: true,
    };
    // KEV membership changes no outcome in this phase: still a warning under the default policy.
    const out = await gate({ sbom: SBOM_SPDX, findings: [kevHigh] });
    expect(out.passed).toBe(true);
    expect(out.warnings).toEqual([kevHigh]);
  });

  test("a finding constructed without exploitability fields still typechecks and gates as before", async () => {
    await expect(gate({ sbom: SBOM_SPDX, findings: [CRIT_FIXABLE], policy: { failOnKev: false, exploitabilityFixableOnly: true } })).rejects.toBeInstanceOf(
      VulnGateFailedError,
    );
  });
});

// ── exploitability evaluation (#1465, phase 2 of epic #1461) ─────────────────

describe("exploitability evaluation (#1465)", () => {
  const MEDIUM_KEV_FIXABLE: VulnFinding = {
    cveId: "CVE-K1", severity: "medium", package: "libfoo", installedVersion: "1", fixedVersion: "2", fixable: true,
    inKev: true, kevDateAdded: "2024-03-11", kevRansomware: true,
  };
  const LOW_HIGH_EPSS: VulnFinding = {
    cveId: "CVE-E1", severity: "low", package: "libbar", installedVersion: "1", fixedVersion: "2", fixable: true,
    epss: 0.42, epssPercentile: 0.97,
  };

  async function blockingOf(input: VulnGateInput) {
    try {
      await gate(input);
    } catch (e) {
      expect(e).toBeInstanceOf(VulnGateFailedError);
      return (e as VulnGateFailedError).blocking;
    }
    throw new Error("expected the gate to block");
  }

  test("failOnKev blocks a fixable KEV finding BELOW the fail severity, reason kev — the headline case that passes today", async () => {
    const blocking = await blockingOf({ sbom: SBOM_SPDX, findings: [MEDIUM_KEV_FIXABLE], policy: { failOnKev: true } });
    expect(blocking).toEqual([{ finding: MEDIUM_KEV_FIXABLE, reason: "kev" }]);
  });

  test("an UNFIXABLE KEV finding warns instead of blocking under exploitabilityFixableOnly (default)", async () => {
    const unfixable: VulnFinding = { ...MEDIUM_KEV_FIXABLE, fixedVersion: undefined, fixable: false };
    const out = await gate({ sbom: SBOM_SPDX, findings: [unfixable], policy: { failOnKev: true } });
    expect(out.passed).toBe(true);
    expect(out.warnings).toEqual([unfixable]);
  });

  test("exploitabilityFixableOnly: false blocks the unfixable KEV finding too", async () => {
    const unfixable: VulnFinding = { ...MEDIUM_KEV_FIXABLE, fixedVersion: undefined, fixable: false };
    const blocking = await blockingOf({ sbom: SBOM_SPDX, findings: [unfixable], policy: { failOnKev: true, exploitabilityFixableOnly: false } });
    expect(blocking[0].reason).toBe("kev");
  });

  test("failEpssAtOrAbove blocks a low-severity finding at/above the threshold, reason epss-threshold", async () => {
    const blocking = await blockingOf({ sbom: SBOM_SPDX, findings: [LOW_HIGH_EPSS], policy: { failEpssAtOrAbove: 0.1 } });
    expect(blocking).toEqual([{ finding: LOW_HIGH_EPSS, reason: "epss-threshold" }]);
  });

  test("absent EPSS never matches a threshold — undefined is not zero", async () => {
    const unscored: VulnFinding = { ...LOW_HIGH_EPSS, epss: undefined, epssPercentile: undefined };
    const out = await gate({ sbom: SBOM_SPDX, findings: [unscored], policy: { failEpssAtOrAbove: 0, warnEpssAtOrAbove: 0 } });
    expect(out.passed).toBe(true);
    expect(out.warnings).toEqual([]);
  });

  test("warnEpssAtOrAbove warns without blocking", async () => {
    const out = await gate({ sbom: SBOM_SPDX, findings: [LOW_HIGH_EPSS], policy: { warnEpssAtOrAbove: 0.1 } });
    expect(out.passed).toBe(true);
    expect(out.warnings).toEqual([LOW_HIGH_EPSS]);
  });

  test("VEX suppression outranks KEV — a suppressed KEV finding does not block and lands in suppressed", async () => {
    const vex = JSON.stringify({ statements: [{ vulnerability: "CVE-K1", status: "not_affected", justification: "vulnerable code not in execute path" }] });
    const out = await gate({ sbom: SBOM_SPDX, findings: [MEDIUM_KEV_FIXABLE], vex: [vex], policy: { failOnKev: true } });
    expect(out.passed).toBe(true);
    expect(out.suppressed.map((s) => s.finding.cveId)).toEqual(["CVE-K1"]);
  });

  test("exploitability escalates, never de-escalates: a severity block with low EPSS and no KEV still blocks", async () => {
    const dullCritical: VulnFinding = { ...CRIT_FIXABLE, epss: 0.001, inKev: undefined };
    const blocking = await blockingOf({ sbom: SBOM_SPDX, findings: [dullCritical], policy: { failOnKev: true, failEpssAtOrAbove: 0.5 } });
    expect(blocking).toEqual([{ finding: dullCritical, reason: "severity-threshold" }]);
  });

  test("a finding blocked for several reasons is reported once, under the most specific: kev > epss-threshold > severity-threshold", async () => {
    const everything: VulnFinding = { ...CRIT_FIXABLE, epss: 0.9, inKev: true, kevDateAdded: "2024-03-11" };
    const blocking = await blockingOf({ sbom: SBOM_SPDX, findings: [everything], policy: { failOnKev: true, failEpssAtOrAbove: 0.1 } });
    expect(blocking).toEqual([{ finding: everything, reason: "kev" }]);
  });

  test("the error message names the rule that fired for each finding", async () => {
    const err = await gate({
      sbom: SBOM_SPDX,
      findings: [MEDIUM_KEV_FIXABLE, LOW_HIGH_EPSS, CRIT_FIXABLE],
      policy: { failOnKev: true, failEpssAtOrAbove: 0.1 },
    }).then(
      () => { throw new Error("expected the gate to block"); },
      (e) => e as VulnGateFailedError,
    );
    expect(err.message).toContain("CVE-K1 (medium, libfoo) — in CISA KEV since 2024-03-11, known ransomware use");
    expect(err.message).toContain("CVE-E1 (low, libbar) — EPSS 0.42 at/above the fail threshold");
    expect(err.message).toContain("CVE-1 (critical, a) — severity at/above the fail threshold, fixable");
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

  test("passes through the exploitability fields (#1466)", () => {
    expect(resolveVulnPolicy({ vulnPolicy: { failOnKev: true, failEpssAtOrAbove: 0.1, warnEpssAtOrAbove: 0.01, exploitabilityFixableOnly: false } })).toEqual({
      failOnKev: true,
      failEpssAtOrAbove: 0.1,
      warnEpssAtOrAbove: 0.01,
      exploitabilityFixableOnly: false,
    });
  });

  test("failEpssAtOrAbove: 0 survives — a meaningful value, not falsy noise", () => {
    expect(resolveVulnPolicy({ vulnPolicy: { failEpssAtOrAbove: 0, warnEpssAtOrAbove: 0 } })).toEqual({ failEpssAtOrAbove: 0, warnEpssAtOrAbove: 0 });
  });

  test("an explicit failOnKev: false is distinguishable from unset", () => {
    expect(resolveVulnPolicy({ vulnPolicy: { failOnKev: false } })).toEqual({ failOnKev: false });
    expect(resolveVulnPolicy({ vulnPolicy: {} })).toEqual({});
  });
});
