/**
 * The provenance of an adopted lineage (#2551, D5, requirement P7).
 *
 * `chant workspace adopt-lineage` records the commit it adopted at, and adds
 * the range ending there to `.chant/trust.json`. That file is policy, always
 * read at the base revision (./trust/policy.ts), so an adoption counts only
 * once its range is in the policy at base, which takes a protected write by
 * an admin. Until then the scope reads as `unattested`, like any lineage
 * chant wrote itself.
 */

import { execFileSync } from "node:child_process";
import type { Lineage } from "./lineage-lock";
import { isAdopted, policyAtBase, resolveBase } from "./trust/provenance";

export interface LineageProvenance {
  level: "adopted" | "unattested";
  reason: string;
}

/** Null for a lineage that makes no adoption claim: one chant wrote at init, vendor or upgrade, or a directory lineage moved onto git. */
export function lineageProvenance(root: string, lineage: Lineage): LineageProvenance | null {
  const adoption = lineage.adoption;
  if (!adoption || adoption.by !== "files") return null;
  const to = adoption.commits.to;
  let repo: string;
  try {
    repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return { level: "unattested", reason: "not in a git repository, so the adopted range cannot be checked" };
  }
  const base = resolveBase(repo);
  if (!base.commit) return { level: "unattested", reason: base.problem ?? "no base revision" };
  const policy = policyAtBase(repo, base);
  if (isAdopted(repo, policy, to)) return { level: "adopted", reason: `the policy at ${base.commit.slice(0, 12)} adopts the range up to ${to.slice(0, 12)}` };
  return {
    level: "unattested",
    reason: `the range up to ${to.slice(0, 12)} is not in .chant/trust.json at ${base.commit.slice(0, 12)} (${base.from}); it counts once that change is merged`,
  };
}
