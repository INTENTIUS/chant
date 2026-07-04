/**
 * License policy over an SBOM's declared licenses (#626). The SBOM already
 * enumerates every component and its license; this evaluates those against an
 * allow/deny list (e.g. block a copyleft license in a proprietary product).
 *
 * **Report-only by default.** License posture is context-dependent — GPL is a
 * problem for a proprietary binary but fine for a GPL project — so the gate
 * (./vuln-gate.ts) does NOT block on license violations unless a project opts
 * in (`failOnLicense: true`). Extraction reads both SPDX
 * (`packages[].licenseConcluded`/`licenseDeclared`) and CycloneDX
 * (`components[].licenses[]`) without a spec dependency.
 */

import type { SbomDocument } from "./sbom-generator";

/** A package/component and the license the SBOM declares for it. */
export interface PackageLicense {
  package: string;
  /** SPDX license expression/id as the SBOM reports it, or `"NOASSERTION"`/`""` when none is declared. */
  license: string;
}

export interface LicensePolicy {
  /** If set, ONLY these licenses are permitted — anything else is a violation. */
  allow?: string[];
  /** These licenses are violations (takes precedence; useful without an allowlist). */
  deny?: string[];
}

/** One package whose license violates the policy. */
export interface LicenseViolation {
  package: string;
  license: string;
  /** Which rule it broke. */
  reason: "denied" | "not-allowed";
}

// ── extraction ───────────────────────────────────────────────────────────────

interface SpdxDoc {
  packages?: Array<{ name?: string; licenseConcluded?: string; licenseDeclared?: string }>;
}
interface CycloneDxDoc {
  components?: Array<{
    name?: string;
    licenses?: Array<{ license?: { id?: string; name?: string }; expression?: string }>;
  }>;
}

/** Extract each package's declared license from an SBOM, dispatching on media type (SPDX vs CycloneDX). Never throws on shape — a package with no license reads as `"NOASSERTION"`. */
export function extractLicenses(sbom: SbomDocument): PackageLicense[] {
  const doc = JSON.parse(sbom.bytes) as SpdxDoc & CycloneDxDoc;
  if (sbom.format === "cyclonedx" || Array.isArray(doc.components)) {
    return (doc.components ?? []).map((c) => {
      const first = c.licenses?.[0];
      const license = first?.expression ?? first?.license?.id ?? first?.license?.name ?? "NOASSERTION";
      return { package: c.name ?? "unknown", license };
    });
  }
  return (doc.packages ?? []).map((p) => ({
    package: p.name ?? "unknown",
    license: p.licenseConcluded && p.licenseConcluded !== "NOASSERTION" ? p.licenseConcluded : (p.licenseDeclared ?? "NOASSERTION"),
  }));
}

// ── evaluation ───────────────────────────────────────────────────────────────

/** Case-insensitive membership, so `"mit"` matches `"MIT"`. */
function includesCi(list: string[], value: string): boolean {
  const v = value.toLowerCase();
  return list.some((x) => x.toLowerCase() === v);
}

/**
 * Split an SPDX license expression into its component license atoms, so a
 * deny/allow list matches a license hidden inside an expression like
 * `"GPL-3.0 OR MIT"` or `"(Apache-2.0 AND MIT)"` — an exact-string compare on
 * the whole expression would miss `GPL-3.0` and let it through. Conservative:
 * we only need the *set* of licenses referenced, so we split on `OR`/`AND`,
 * drop parentheses, and strip any `WITH <exception>` suffix. A single license
 * id returns itself unchanged.
 */
export function licenseAtoms(expr: string): string[] {
  return expr
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND)\s+/i)
    .map((a) => a.split(/\s+WITH\s+/i)[0].trim())
    .filter(Boolean);
}

/**
 * Evaluate an SBOM's licenses against `policy`. A package violates if ANY atom
 * of its (possibly compound) SPDX license expression is in `deny`, or (when
 * `allow` is set) any atom is not in `allow`. This is conservative on `OR`
 * expressions — `"GPL-3.0 OR MIT"` counts as a `GPL-3.0` deny hit even though a
 * consumer could choose MIT — because a policy gate should surface the presence
 * of a denied license, not silently rely on the consumer picking the permissive
 * branch. Packages with no declared license (`NOASSERTION`/empty) are not
 * flagged — an undeclared license is not asserted to be denied.
 */
export function evaluateLicensePolicy(sbom: SbomDocument, policy: LicensePolicy): LicenseViolation[] {
  const out: LicenseViolation[] = [];
  for (const { package: pkg, license } of extractLicenses(sbom)) {
    if (!license || license === "NOASSERTION") continue;
    const atoms = licenseAtoms(license);
    if (policy.deny && atoms.some((a) => includesCi(policy.deny!, a))) {
      out.push({ package: pkg, license, reason: "denied" });
      continue;
    }
    if (policy.allow && policy.allow.length > 0 && atoms.some((a) => !includesCi(policy.allow!, a))) {
      out.push({ package: pkg, license, reason: "not-allowed" });
    }
  }
  return out;
}
