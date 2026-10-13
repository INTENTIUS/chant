/**
 * Merging per-member lint and audit output (#2537, #2524 D16, ws-025, ws-026).
 *
 * `chant workspace lint --format sarif` prints one SARIF log with one run per
 * member, each run being what that member's own `chant lint --format sarif`
 * printed. `chant workspace audit --format json` prints one document whose
 * findings each carry a `member` field. Both keep what the member's chant
 * said and only add where it came from.
 */

import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SARIF_SCHEMA = "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";

/** One member's output, as the merge sees it. */
export interface MemberOutput {
  /** The member's name, or `<group>:<dir>` for an example-group match. */
  id: string;
  /** The member or group name. */
  member: string;
  /** Relative to the workspace root, `"."` for the root member. */
  dir: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * Directories (relative to the member) that belong to other members. Set
   * for member `.`: its audit walks the whole root, and findings in these
   * directories are reported by the members they belong to.
   */
  exclude?: string[];
}

type Json = Record<string, unknown>;

/** A root-relative path for a URI a member's SARIF wrote. Other URIs pass through. */
function rootRelativeUri(uri: string, memberDir: string, root: string): string {
  let abs: string | undefined;
  if (uri.startsWith("file://")) {
    try {
      abs = fileURLToPath(uri);
    } catch {
      return uri;
    }
  } else if (isAbsolute(uri)) {
    abs = uri;
  }
  if (abs !== undefined) {
    const rel = relative(root, abs).split("\\").join("/");
    return rel.startsWith("..") || isAbsolute(rel) ? uri : rel;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) return uri;
  return memberDir === "." ? uri : `${memberDir}/${uri}`;
}

function rewriteUris(value: unknown, memberDir: string, root: string): unknown {
  if (Array.isArray(value)) return value.map((v) => rewriteUris(v, memberDir, root));
  if (value === null || typeof value !== "object") return value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = k === "artifactLocation" && v && typeof v === "object" && typeof (v as Json).uri === "string"
      ? { ...(v as Json), uri: rootRelativeUri((v as Json).uri as string, memberDir, root) }
      : rewriteUris(v, memberDir, root);
  }
  return out;
}

/** A run for a member whose lint printed no SARIF: no results, and the failure as a notification. */
function failedRun(unit: MemberOutput, why: string): Json {
  const tail = unit.stderr.trim().split("\n").slice(-20).join("\n");
  return {
    tool: { driver: { name: "chant", informationUri: "https://intentius.io/chant" } },
    automationDetails: { id: `${unit.id}/` },
    properties: { member: unit.member, dir: unit.dir },
    invocations: [
      {
        executionSuccessful: false,
        exitCode: unit.exitCode,
        toolExecutionNotifications: [{ level: "error", message: { text: tail ? `${why}\n${tail}` : why } }],
      },
    ],
    results: [],
  };
}

/**
 * One SARIF log with one run per member. A member's own log normally holds
 * one run; if it holds more, their results are folded into the first so the
 * member still has exactly one. Artifact URIs become relative to the
 * workspace root, and each run's `automationDetails.id` is `<member>/`, the
 * SARIF way to tell runs of one tool apart.
 */
export function mergeSarif(units: MemberOutput[], root: string): Json {
  const runs: Json[] = [];
  for (const unit of units) {
    let log: Json;
    try {
      log = JSON.parse(unit.stdout) as Json;
    } catch {
      runs.push(failedRun(unit, `chant lint exited ${unit.exitCode} and printed no SARIF`));
      continue;
    }
    const own = Array.isArray(log.runs) ? (log.runs as Json[]) : [];
    if (own.length === 0) {
      runs.push(failedRun(unit, "chant lint printed a SARIF log with no runs"));
      continue;
    }
    const [first, ...rest] = own.map((r) => rewriteUris(r, unit.dir, root) as Json);
    const results = [...((first.results as unknown[]) ?? [])];
    for (const r of rest) {
      for (const res of (r.results as Json[]) ?? []) {
        // A rule index points into its own run's rules; folded in, it would point at the wrong one.
        const { ruleIndex: _dropped, ...kept } = res;
        results.push(kept);
      }
    }
    runs.push({
      ...first,
      results,
      automationDetails: { ...((first.automationDetails as Json) ?? {}), id: `${unit.id}/` },
      properties: { ...((first.properties as Json) ?? {}), member: unit.member, dir: unit.dir },
    });
  }
  return { $schema: SARIF_SCHEMA, version: "2.1.0", runs };
}

export interface MemberAuditStatus {
  member: string;
  dir: string;
  exitCode: number;
  status: "ok" | "no-lexicons" | "failed";
  summary: Json | null;
  error: string | null;
  /** What the member's audit printed instead of a report when it had nothing to audit. */
  note?: string;
  /** Findings dropped from member `.` because they sit in another member's directory. */
  leftToMembers?: number;
}

export interface WorkspaceAuditDocument {
  /** The audit report schema version the members wrote, when they all agree. */
  schemaVersion: string | null;
  workspace: { name: string; root: string };
  members: MemberAuditStatus[];
  findings: Json[];
}

/**
 * Merge each member's `chant audit --format json` report. Every finding keeps
 * its fields, with `file` still relative to its member, and gains `member`.
 */
export function mergeAudit(units: MemberOutput[], workspace: { name: string; root: string }): WorkspaceAuditDocument {
  const members: MemberAuditStatus[] = [];
  const findings: Json[] = [];
  const versions = new Set<string>();
  for (const unit of units) {
    let report: Json;
    try {
      report = JSON.parse(unit.stdout) as Json;
    } catch {
      if (unit.exitCode === 0) {
        // `chant audit` says so in plain text when a directory holds nothing it audits.
        members.push({ member: unit.id, dir: unit.dir, exitCode: 0, status: "ok", summary: null, error: null, note: unit.stdout.trim() });
        continue;
      }
      const tail = unit.stderr.trim().split("\n").slice(-5).join("\n");
      members.push({ member: unit.id, dir: unit.dir, exitCode: unit.exitCode, status: "failed", summary: null, error: tail || "chant audit printed no JSON report" });
      continue;
    }
    if (typeof report.schemaVersion === "string") versions.add(report.schemaVersion);
    const own = (report.findings as Json[]) ?? [];
    const kept = own.filter((f) => !unit.exclude?.some((d) => typeof f.file === "string" && (f.file === d || f.file.startsWith(`${d}/`))));
    members.push({
      member: unit.id,
      dir: unit.dir,
      exitCode: unit.exitCode,
      status: report.status === "no-lexicons" ? "no-lexicons" : "ok",
      summary: (report.summary as Json) ?? null,
      error: null,
      ...(kept.length < own.length ? { leftToMembers: own.length - kept.length } : {}),
    });
    for (const f of kept) findings.push({ ...f, member: unit.id });
  }
  return { schemaVersion: versions.size === 1 ? [...versions][0] : null, workspace, members, findings };
}
