/**
 * VEX (Vulnerability Exploitability eXchange) ingestion + suppression (#626).
 * A scanner (./vuln-scan.ts) flags every known CVE in an SBOM, but most aren't
 * actually exploitable in context (unreachable code path, already mitigated,
 * false positive). VEX is where you (or upstream) assert, per CVE, whether it
 * *actually* affects this artifact. Without it a gate is CVE fatigue — 500
 * findings, 5 that matter. This module parses VEX and filters findings, and it
 * **reports** every suppression with its justification — a VEX-suppressed
 * finding is never silently dropped.
 *
 * Two formats: **OpenVEX** (the standalone Sigstore/OpenSSF format) and
 * **CycloneDX**-embedded VEX (`vulnerabilities[].analysis`). Both reduce to the
 * same `VexStatement` shape here.
 */

import type { VulnFinding } from "./vuln-scan";

/** VEX status for a CVE against an artifact. `not_affected`/`fixed` suppress a finding; `affected`/`under_investigation` keep it (conservative — an unresolved status must not hide a real vuln). */
export type VexStatus = "not_affected" | "affected" | "fixed" | "under_investigation";

/** True for statuses that suppress a matching finding from gating. */
export function suppresses(status: VexStatus): boolean {
  return status === "not_affected" || status === "fixed";
}

/** One VEX assertion: this CVE has this status for this artifact, with an optional human justification. */
export interface VexStatement {
  cveId: string;
  status: VexStatus;
  /** Why — e.g. `"vulnerable_code_not_in_execute_path"`, `"component_not_present"`. Surfaced on the suppression report so a reviewer sees the reasoning, never a bare "suppressed." */
  justification?: string;
}

// ── OpenVEX ──────────────────────────────────────────────────────────────────

interface OpenVexDoc {
  statements?: Array<{
    // OpenVEX allows `vulnerability` as either a string or an object with `name`.
    vulnerability?: string | { name?: string; "@id"?: string };
    status?: string;
    justification?: string;
    impact_statement?: string;
    action_statement?: string;
  }>;
}

function vexStatusFrom(raw: string | undefined): VexStatus | undefined {
  switch ((raw ?? "").toLowerCase()) {
    case "not_affected":
      return "not_affected";
    case "affected":
      return "affected";
    case "fixed":
      return "fixed";
    case "under_investigation":
      return "under_investigation";
    default:
      return undefined;
  }
}

/** Parse an OpenVEX JSON document into statements. Unknown statuses / statements missing a vulnerability id are skipped. */
export function parseOpenVex(bytes: string): VexStatement[] {
  const doc = JSON.parse(bytes) as OpenVexDoc;
  const out: VexStatement[] = [];
  for (const s of doc.statements ?? []) {
    const cveId = typeof s.vulnerability === "string" ? s.vulnerability : (s.vulnerability?.name ?? s.vulnerability?.["@id"]);
    const status = vexStatusFrom(s.status);
    if (!cveId || !status) continue;
    out.push({ cveId, status, justification: s.justification ?? s.impact_statement });
  }
  return out;
}

// ── CycloneDX-embedded VEX ───────────────────────────────────────────────────

interface CycloneDxVexDoc {
  vulnerabilities?: Array<{
    id?: string;
    analysis?: { state?: string; detail?: string; justification?: string };
  }>;
}

/** Map CycloneDX `analysis.state` to a `VexStatus`. */
function cdxStateToVex(state: string | undefined): VexStatus | undefined {
  switch ((state ?? "").toLowerCase()) {
    case "not_affected":
    case "false_positive":
      return "not_affected";
    case "resolved":
    case "resolved_with_pedigree":
      return "fixed";
    case "exploitable":
      return "affected";
    case "in_triage":
      return "under_investigation";
    default:
      return undefined;
  }
}

/** Parse CycloneDX-embedded VEX (`vulnerabilities[].analysis`) into statements. */
export function parseCycloneDxVex(bytes: string): VexStatement[] {
  const doc = JSON.parse(bytes) as CycloneDxVexDoc;
  const out: VexStatement[] = [];
  for (const v of doc.vulnerabilities ?? []) {
    const status = cdxStateToVex(v.analysis?.state);
    if (!v.id || !status) continue;
    out.push({ cveId: v.id, status, justification: v.analysis?.justification ?? v.analysis?.detail });
  }
  return out;
}

/** Parse a VEX document of either format — dispatched on shape (`statements` -> OpenVEX, `vulnerabilities` -> CycloneDX). */
export function parseVexDocument(bytes: string): VexStatement[] {
  const doc = JSON.parse(bytes) as OpenVexDoc & CycloneDxVexDoc;
  if (Array.isArray(doc.statements)) return parseOpenVex(bytes);
  if (Array.isArray(doc.vulnerabilities)) return parseCycloneDxVex(bytes);
  return [];
}

// ── applying VEX to findings ─────────────────────────────────────────────────

/** A finding removed from gating by a VEX statement, kept for reporting (never silently dropped). */
export interface SuppressedFinding {
  finding: VulnFinding;
  status: VexStatus;
  justification?: string;
}

/** The result of filtering findings through VEX: what still gates, and what was suppressed (with reasons). */
export interface VexResult {
  /** Findings that survived VEX — the gate evaluates these. */
  gating: VulnFinding[];
  /** Findings suppressed by a `not_affected`/`fixed` statement, with the statement's justification. */
  suppressed: SuppressedFinding[];
}

/**
 * Filter `findings` through `statements`: a finding whose `cveId` has a
 * suppressing VEX status (`not_affected`/`fixed`) moves to `suppressed` (with
 * its justification); everything else stays in `gating`. A CVE with multiple
 * statements is suppressed only if its most-recent/only status suppresses —
 * here we take the last matching statement, so an ordered VEX document's later
 * assertion wins.
 */
export function applyVex(findings: VulnFinding[], statements: VexStatement[]): VexResult {
  const byCve = new Map<string, VexStatement>();
  for (const s of statements) byCve.set(s.cveId, s); // last wins
  const gating: VulnFinding[] = [];
  const suppressed: SuppressedFinding[] = [];
  for (const f of findings) {
    const st = byCve.get(f.cveId);
    if (st && suppresses(st.status)) {
      suppressed.push({ finding: f, status: st.status, justification: st.justification });
    } else {
      gating.push(f);
    }
  }
  return { gating, suppressed };
}
