/**
 * The claim files a check's step leaves for a signer in another job (#4926),
 * and the variable that names which step or job each check's pass is read
 * from. No import beyond node's, so the wave runner and the generators carry
 * it at no cost.
 *
 * A step that ran a check writes `<dir>/<check>.json` (`:` turned into `-`):
 * the check's name, whether the step saw it pass, and what it said (the
 * claim the statement digests). The step runs the change's code, so the file
 * is data and never enough on its own: `chant ci evidence sign --from-job`
 * signs a check only when the forge reports that step (on GitLab, that job)
 * concluded `success` and the file says the check passed
 * (./ci-evidence-from-job.ts).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The variable a `--from-job` signing step reads its sources from: JSON,
 * each check to the job (default `--from-job`'s) and the step whose
 * conclusion stands for it. A check with no step is read from its job's
 * own status, as on GitLab.
 */
export const EVIDENCE_SOURCES_ENV = "CHANT_EVIDENCE_SOURCES";

/**
 * What a generated wave command step signs itself (#4926), set by the
 * generator beside the wave's evidence job: `plan` signs `plan:<wave>` and
 * leaves `policy:<wave>` to the evidence job, which reads the policy step's
 * result; `job` signs nothing and leaves both. Either way the step writes
 * `plan:<wave>`'s claim file for that job. Unset, the step signs both as it
 * did (#4870). See ./op/op-waves-evidence.ts.
 */
export const WAVE_EVIDENCE_ENV = "CHANT_WAVE_EVIDENCE";

/** Where one check's pass is read from (#4926). */
export interface EvidenceSourceSpec {
  /** The job's name in the run. Default: `--from-job`'s. */
  job?: string;
  /** The step's name in that job, as the forge lists it. Without it, the job's own result. */
  step?: string;
}

/** What a check's step wrote for its signer. */
export interface CheckClaimFile {
  check: string;
  passed: boolean;
  /** What the check said, digested into the statement's `claim`. */
  claim?: string;
}

/** The file name a check's claim is kept under: `plan:dev` is `plan-dev.json`. */
export function checkClaimFileName(check: string): string {
  return `${check.replace(/[^A-Za-z0-9._-]/g, "-")}.json`;
}

/** Write a check's claim file in `dir`. Returns its path. */
export function writeCheckClaimFile(dir: string, file: CheckClaimFile): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, checkClaimFileName(file.check));
  writeFileSync(path, JSON.stringify({ check: file.check, passed: file.passed, ...(file.claim !== undefined ? { claim: file.claim } : {}) }, null, 2) + "\n");
  return path;
}

/** A check's claim file in `dir`, or why there is none that counts. Read as data: a file for another check, or of another shape, does not count. */
export function readCheckClaimFile(dir: string, check: string): CheckClaimFile | { problem: string } {
  const name = checkClaimFileName(check);
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(join(dir, name), "utf-8"));
  } catch {
    return { problem: `the job left no readable ${name}` };
  }
  const d = doc && typeof doc === "object" ? (doc as Record<string, unknown>) : {};
  if (d.check !== check || typeof d.passed !== "boolean" || (d.claim !== undefined && typeof d.claim !== "string")) return { problem: `${name} is not ${check}'s claim file` };
  return { check, passed: d.passed, ...(typeof d.claim === "string" ? { claim: d.claim } : {}) };
}

/** The sources `CHANT_EVIDENCE_SOURCES` names, or why they do not read. A step name alone stands for `{ step }`. */
export function parseEvidenceSources(raw: string | undefined): { sources: Record<string, EvidenceSourceSpec> } | { problem: string } {
  if (raw === undefined || raw.trim() === "") return { sources: {} };
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { problem: `${EVIDENCE_SOURCES_ENV} is not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { problem: `${EVIDENCE_SOURCES_ENV} must map each check to its job and step` };
  const out: Record<string, EvidenceSourceSpec> = {};
  for (const [check, v] of Object.entries(doc as Record<string, unknown>)) {
    if (typeof v === "string" && v !== "") out[check] = { step: v };
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if ((o.job !== undefined && (typeof o.job !== "string" || o.job === "")) || (o.step !== undefined && (typeof o.step !== "string" || o.step === ""))) {
        return { problem: `${EVIDENCE_SOURCES_ENV}: ${check}'s job and step must be names` };
      }
      out[check] = { ...(typeof o.job === "string" ? { job: o.job } : {}), ...(typeof o.step === "string" ? { step: o.step } : {}) };
    } else return { problem: `${EVIDENCE_SOURCES_ENV}: ${check} must name a step, or { job, step }` };
  }
  return { sources: out };
}
