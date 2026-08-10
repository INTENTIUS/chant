/**
 * `vuln-gate` capability (#626) — the deploy-time gate that closes the
 * supply-chain loop: scan the SBOM (./vuln-scan.ts) for known CVEs, suppress
 * the ones VEX says don't matter (./vex.ts), check licenses (./license-policy.ts),
 * and **throw** on a policy violation so composing it before an apply phase
 * fails the deploy — the same throw-to-halt mechanism as ./verify.ts and
 * `policyGate` (../../lint/policy.ts). No new gate plumbing.
 *
 * **Beginner-safe default policy:** fail on `severity >= critical AND fixable
 * AND not VEX-suppressed`; findings at/above the warn severity (default
 * `high`) that don't reach the fail bar are reported as warnings, not blocked;
 * license findings are report-only unless `failOnLicense` is set. Everything
 * is configurable via `chant.config.ts`'s `vulnPolicy` section (see
 * ../../config.ts `resolveVulnPolicy`). The intent is that a first-timer who
 * just adds a `vuln-gate` step gets a sensible, non-noisy gate that blocks the
 * genuinely actionable (critical + fixable) and reports the rest.
 */

import type { Capability } from "../capability";
import type { SbomDocument } from "./sbom-generator";
import {
  defaultVulnScanner,
  SEVERITY_RANK,
  type Severity,
  type VulnFinding,
  type VulnScanner,
} from "./vuln-scan";
import { applyVex, parseVexDocument, type SuppressedFinding, type VexStatement } from "./vex";
import { evaluateLicensePolicy, type LicensePolicy, type LicenseViolation } from "./license-policy";

/** The gate's policy. Defaults (per `resolveVulnPolicy`, ../../config.ts) are beginner-safe: fail critical+fixable, warn high, license report-only. */
export interface VulnPolicy {
  /** Minimum severity that FAILS the gate. Default `"critical"`. */
  failSeverity: Severity;
  /** When true (default), only *fixable* findings at/above `failSeverity` fail the gate — an unfixable finding can't be actioned by upgrading, so it warns instead of blocking. */
  fixableOnly: boolean;
  /** Minimum severity reported as a warning (below `failSeverity`). Default `"high"`. */
  warnSeverity: Severity;
  /** License allow/deny policy. Evaluated always; only *blocks* when `failOnLicense` is true. */
  license?: LicensePolicy;
  /** Block the deploy on a license violation. Default `false` (report-only) — license posture is context-dependent. */
  failOnLicense: boolean;
  /** Block on an `unknown`-severity finding (a scanner that didn't report a severity chant could map). Default `false` — but such a finding is ALWAYS at least warned, never silently dropped, regardless of this flag. Set true for a strict shop that won't ship an unclassifiable finding. */
  failOnUnknownSeverity: boolean;
  /** Block any finding in the CISA KEV catalog, regardless of severity. Default `false` — see epic #1461's open decision before flipping. */
  failOnKev: boolean;
  /** Block when EPSS is at or above this (0.0–1.0). Omit to ignore EPSS entirely. */
  failEpssAtOrAbove?: number;
  /** Warn (not block) at or above this EPSS. Omit to ignore. */
  warnEpssAtOrAbove?: number;
  /** Apply `fixableOnly` to exploitability blocks too — an unfixable KEV finding warns rather than blocks. Default `true`. */
  exploitabilityFixableOnly: boolean;
}

/** Beginner-safe defaults, also encoded in `resolveVulnPolicy` (../../config.ts). */
export const DEFAULT_VULN_POLICY: VulnPolicy = {
  failSeverity: "critical",
  fixableOnly: true,
  warnSeverity: "high",
  failOnLicense: false,
  failOnUnknownSeverity: false,
  failOnKev: false,
  exploitabilityFixableOnly: true,
};

export interface VulnGateInput {
  /** The artifact's SBOM. Scanned in-place unless `findings` is supplied. */
  sbom: SbomDocument;
  /** Pre-scanned findings (e.g. from a prior `scan-vulnerabilities` step). If omitted, the gate scans `sbom` itself via the injected scanner. */
  findings?: VulnFinding[];
  /** VEX documents (OpenVEX or CycloneDX-embedded), as serialized JSON, applied to suppress findings. */
  vex?: string[];
  /** Policy override; merged over `DEFAULT_VULN_POLICY`. */
  policy?: Partial<VulnPolicy>;
  /** Artifact digest, for reporting. */
  digest?: string;
}

/** A finding that fails the gate, with why. */
export interface BlockingFinding {
  finding: VulnFinding;
  reason: "severity-threshold" | "unknown-severity" | "kev" | "epss-threshold";
}

export interface VulnGateOutput {
  /** Always `true` when returned — a violation throws instead (mirrors ./verify.ts's `verified`). */
  passed: true;
  /** Findings at/above `warnSeverity` that did not reach the fail bar. */
  warnings: VulnFinding[];
  /** Findings suppressed by VEX, with justification (never silently dropped). */
  suppressed: SuppressedFinding[];
  /** License findings — reported even when `failOnLicense` is false. */
  licenseFindings: LicenseViolation[];
}

/**
 * Thrown when the gate blocks a deploy — carries the blocking findings and any
 * blocking license violations so a reviewer sees exactly what to fix (or VEX).
 * Distinct from a scanner-not-installed error (`VulnScannerNotImplementedError`/
 * `ToolNotAvailableError`) so a caller can tell "policy said no" from "no
 * scanner."
 */
export class VulnGateFailedError extends Error {
  constructor(
    public readonly blocking: BlockingFinding[],
    public readonly blockingLicenses: LicenseViolation[],
  ) {
    const licList = blockingLicenses.map((l) => `${l.license} in ${l.package}`).join(", ");
    const parts: string[] = [];
    if (blocking.length) {
      const lines = blocking.map((b) => `  ${b.finding.cveId} (${b.finding.severity}, ${b.finding.package}) — ${describeBlockReason(b)}`);
      parts.push(`${blocking.length} vulnerability finding(s):\n${lines.join("\n")}`);
    }
    if (blockingLicenses.length) parts.push(`${blockingLicenses.length} license violation(s): ${licList}`);
    super(`vuln-gate blocked the deploy — ${parts.join("\n")}\nFix the dependency, or record a VEX statement if it is not exploitable.`);
    this.name = "VulnGateFailedError";
  }
}

/** Which rule fired, human-readably — naming the rule is the difference between a gate people tune and a gate people disable. */
function describeBlockReason(b: BlockingFinding): string {
  const f = b.finding;
  switch (b.reason) {
    case "kev": {
      const since = f.kevDateAdded ? `in CISA KEV since ${f.kevDateAdded}` : "in CISA KEV";
      return f.kevRansomware ? `${since}, known ransomware use` : since;
    }
    case "epss-threshold":
      return `EPSS ${f.epss} at/above the fail threshold`;
    case "unknown-severity":
      return "severity unreported by the scanner (failOnUnknownSeverity)";
    case "severity-threshold":
      return `severity at/above the fail threshold${f.fixable ? ", fixable" : ""}`;
  }
}

/** Parse every supplied VEX document into a flat statement list (ignoring any that fail to parse into a known shape). */
function collectVex(docs: string[] | undefined): VexStatement[] {
  const out: VexStatement[] = [];
  for (const bytes of docs ?? []) out.push(...parseVexDocument(bytes));
  return out;
}

/**
 * Build the `vuln-gate` capability. Scans `sbom` (or uses supplied `findings`),
 * applies VEX, evaluates the license policy, and classifies every gating
 * finding: it BLOCKS (throws `VulnGateFailedError`) any finding at/above
 * `failSeverity` that satisfies `fixableOnly`, any KEV finding when
 * `failOnKev`, any finding at/above `failEpssAtOrAbove` (exploitability
 * blocks honor `exploitabilityFixableOnly`), plus license violations when
 * `failOnLicense`; everything at/above `warnSeverity` below the fail bar is a
 * warning, as are exploitability hits kept from blocking only by fixability
 * and findings at/above `warnEpssAtOrAbove`. On a clean pass it returns the
 * warnings/suppressed/license report for logging.
 */
export function createVulnGateCapability(
  scanner: VulnScanner = defaultVulnScanner(),
): Capability<VulnGateInput, VulnGateOutput> {
  return {
    kind: "vuln-gate",
    async run(_ctx, input) {
      const policy: VulnPolicy = { ...DEFAULT_VULN_POLICY, ...input.policy };
      const rawFindings = input.findings ?? (await scanner.scan({ sbom: input.sbom, digest: input.digest }));

      // 1. VEX suppression.
      const { gating, suppressed } = applyVex(rawFindings, collectVex(input.vex));

      // 2. Classify gating findings against the severity + exploitability
      // policy. Exploitability (KEV, EPSS) can only ESCALATE — the rules are
      // independent block reasons OR'd together, never a replacement scoring
      // system that could exempt a severity block. A finding blocked for more
      // than one reason is reported once, under the most specific reason
      // (kev > epss-threshold > severity-threshold). VEX suppression (step 1)
      // outranks all of it, KEV included: a VEX statement is a claim about
      // this artifact as built, a catalog entry is about the CVE somewhere.
      const failRank = SEVERITY_RANK[policy.failSeverity];
      const warnRank = SEVERITY_RANK[policy.warnSeverity];
      const blocking: BlockingFinding[] = [];
      const warnings: VulnFinding[] = [];
      for (const f of gating) {
        const rank = SEVERITY_RANK[f.severity];
        // Absent EPSS is "not scored", never zero — it can't match a threshold.
        const epssFailHit = policy.failEpssAtOrAbove !== undefined && f.epss !== undefined && f.epss >= policy.failEpssAtOrAbove;
        const epssWarnHit = policy.warnEpssAtOrAbove !== undefined && f.epss !== undefined && f.epss >= policy.warnEpssAtOrAbove;
        const kevHit = policy.failOnKev && f.inKev === true;
        const exploitActionable = !policy.exploitabilityFixableOnly || f.fixable;
        if (kevHit && exploitActionable) {
          blocking.push({ finding: f, reason: "kev" });
        } else if (epssFailHit && exploitActionable) {
          blocking.push({ finding: f, reason: "epss-threshold" });
        } else if (rank >= failRank && (!policy.fixableOnly || f.fixable)) {
          blocking.push({ finding: f, reason: "severity-threshold" });
        } else if (f.severity === "unknown") {
          // Never silently pass an unclassifiable finding — a real critical
          // could arrive mislabeled from a broken/compromised scanner. Surface
          // it always; block it when the policy opts in.
          if (policy.failOnUnknownSeverity) blocking.push({ finding: f, reason: "unknown-severity" });
          else warnings.push(f);
        } else if (rank >= warnRank || kevHit || epssFailHit || epssWarnHit) {
          // The exploitability hits landing here were kept from blocking by
          // exploitabilityFixableOnly (or are warn-only EPSS) — an unfixable
          // KEV finding can't be actioned by upgrading, so it warns.
          warnings.push(f);
        }
      }

      // 3. License policy (always evaluated; blocks only when opted in).
      const licenseFindings = policy.license ? evaluateLicensePolicy(input.sbom, policy.license) : [];
      const blockingLicenses = policy.failOnLicense ? licenseFindings : [];

      if (blocking.length > 0 || blockingLicenses.length > 0) {
        throw new VulnGateFailedError(blocking, blockingLicenses);
      }

      return { passed: true, warnings, suppressed, licenseFindings };
    },
  };
}

/** Default `vuln-gate` capability (inject a real/mock scanner, or supply `findings`). */
export const vulnGateCapability: Capability<VulnGateInput, VulnGateOutput> = createVulnGateCapability();
