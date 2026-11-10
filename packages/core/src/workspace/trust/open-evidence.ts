/**
 * `chant ci evidence sign --open` (#4914): the GitLab signing job, in a
 * pipeline of the target branch, signs the checks of every open merge
 * request into the branch from its newest pipeline's job.
 *
 * A merge request pipeline is built from the merge request's own files, so
 * a job there that holds the runner key (or asks for a signing token) runs
 * whatever the change wrote. The plan notes pipeline (#4328) is the target
 * branch's: its jobs come from the branch's files, and its protected
 * variables reach it. So the signing moves there, as the note posting did:
 * for each open merge request GitLab names the newest pipeline's `job`
 * (`plan`, `<target>-plan`, `check`), the report is read from that job's
 * artifacts as data, the head is fetched, and the checks are signed for
 * the head as `sign --from-report` signs them. What was signed and why the
 * rest were not is kept as `<out>/<iid>/evidence.json`, with the merge
 * request and the head, which the note job reads (`pr-post --open
 * --evidence-dir`, ../../pr-post.ts) for the note's "Checks:" line.
 *
 * A job that has not settled is left for the next pipeline. A merge request
 * whose report does not read, whose head does not fetch, or that the forge
 * refuses is a warning, and the others go on.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PrForge } from "../../pr-forge";
import { CHECK_EVIDENCE_FILE, type CheckEvidenceNote, type OpenEvidenceFile } from "./check-evidence-report";

/** The report files a job's artifact is read for, in order: a plan report, a product's plan note hand-off, then a check job's report. */
export const OPEN_PLAN_FILES = ["pr-plan.json", "pr-plan-note.json"] as const;
export const OPEN_CHECK_FILE = "check-hooks.json";

/** What {@link signOpenReports} signs for. */
export interface OpenEvidenceInput {
  /** A GitLab client with {@link PrForge.mergeRequestJobs} and {@link PrForge.jobArtifact}. */
  forge: Pick<PrForge, "kind" | "mergeRequestJobs" | "jobArtifact">;
  /** The branch the merge requests merge into: the pipeline's own. */
  branch: string;
  /** The job whose report is signed: `plan`, `<target>-plan` or `check`. */
  job: string;
  /** The report directory from the repository root, as the job kept it as its artifact. */
  artifactDir: string;
  /** Where each merge request's report and `evidence.json` go: `<out>/<iid>/`. */
  out: string;
  /** Sign for no merge request from a fork, as a product plan with `forks: "skip"` plans none. */
  noForks?: boolean;
  /** Fetch merge request `pr`'s head into this checkout; true once the commit is here. */
  fetchHead: (pr: number, head: string) => boolean;
  /** Sign the checks of the report in `dir` for `head`, given the job's result, as `sign --from-report` does. */
  sign: (dir: string, head: string, result: "success" | "failure" | "cancelled") => Promise<CheckEvidenceNote>;
}

/** What {@link signOpenReports} did for one merge request. */
export interface OpenEvidence {
  pr: number;
  head: string;
  /** What was signed and what was not, as kept in `evidence.json`. */
  note?: CheckEvidenceNote;
  /** Why nothing was signed: the job has not settled, left no report, or its head did not fetch. */
  skipped?: string;
}

/** Sign every open merge request's settled `job` into `branch` (#4914). */
export async function signOpenReports(input: OpenEvidenceInput): Promise<{ done: OpenEvidence[]; warnings: string[] }> {
  const { forge } = input;
  if (!forge.mergeRequestJobs || !forge.jobArtifact) {
    throw new Error(`ci evidence sign --open reads the jobs of open merge requests, which ${forge.kind} cannot say; it is for GitLab`);
  }
  const done: OpenEvidence[] = [];
  const warnings: string[] = [];
  const at = input.artifactDir.replace(/\/+$/, "");
  for (const job of await forge.mergeRequestJobs(input.branch, input.job)) {
    if (input.noForks && job.fork) {
      done.push({ pr: job.pr, head: job.head, skipped: "the merge request is from a fork" });
      continue;
    }
    const result = job.status === "success" ? "success" : job.status === "failed" ? "failure" : job.status === "canceled" ? "cancelled" : undefined;
    if (!result) {
      done.push({ pr: job.pr, head: job.head, skipped: `the ${input.job} job is ${job.status}` });
      continue;
    }
    try {
      const dir = join(input.out, String(job.pr));
      mkdirSync(dir, { recursive: true });
      // A plan report wins over a check report, as `sign --from-report` reads a directory.
      let found = false;
      for (const file of OPEN_PLAN_FILES) {
        const text = await forge.jobArtifact(job.id, `${at}/${file}`);
        if (text === undefined) continue;
        writeFileSync(join(dir, file), text);
        found = true;
        break;
      }
      if (!found) {
        const text = await forge.jobArtifact(job.id, `${at}/${OPEN_CHECK_FILE}`);
        if (text !== undefined) {
          writeFileSync(join(dir, OPEN_CHECK_FILE), text);
          found = true;
        }
      }
      if (!found) {
        done.push({ pr: job.pr, head: job.head, skipped: `the ${input.job} job left no report under ${at}` });
        continue;
      }
      if (!input.fetchHead(job.pr, job.head)) {
        done.push({ pr: job.pr, head: job.head, skipped: `the head ${job.head.slice(0, 12)} did not fetch` });
        continue;
      }
      const note = await input.sign(dir, job.head, result);
      const kept: OpenEvidenceFile = { pr: job.pr, head: job.head, ...note };
      writeFileSync(join(dir, CHECK_EVIDENCE_FILE), JSON.stringify(kept, null, 2) + "\n");
      done.push({ pr: job.pr, head: job.head, note });
    } catch (err) {
      warnings.push(`!${job.pr}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { done, warnings };
}
