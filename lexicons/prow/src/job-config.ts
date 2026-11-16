/**
 * Reading a Prow job config: what makes a document one, and its jobs with
 * where each sits. The import parser, the post-synth checks and the tests
 * read job configs through this module.
 */

import { parseYAML } from "@intentius/chant/yaml";

export type JobType = "presubmit" | "postsubmit" | "periodic";

export interface LocatedJob {
  type: JobType;
  /** The repository key, for a presubmit or postsubmit. */
  repo?: string;
  /** The job's index in its list. */
  index: number;
  job: Record<string, unknown>;
}

const KEYS = ["presubmits", "postsubmits", "periodics"] as const;

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A job config: a map whose keys are Prow's job lists and nothing else, with at least one of them. */
export function isJobConfig(data: unknown): boolean {
  if (!isMap(data)) return false;
  const keys = Object.keys(data);
  if (keys.length === 0 || !keys.every((k) => (KEYS as readonly string[]).includes(k))) return false;
  if (data.periodics !== undefined && !Array.isArray(data.periodics)) return false;
  for (const k of ["presubmits", "postsubmits"] as const) {
    const v = data[k];
    if (v !== undefined && !(isMap(v) && Object.values(v).every(Array.isArray))) return false;
  }
  return true;
}

/** Every job of a job config, presubmits, then postsubmits, then periodics, each in file order. */
export function jobsOf(doc: Record<string, unknown>): LocatedJob[] {
  const out: LocatedJob[] = [];
  for (const [key, type] of [["presubmits", "presubmit"], ["postsubmits", "postsubmit"]] as const) {
    const byRepo = doc[key];
    if (!isMap(byRepo)) continue;
    for (const [repo, jobs] of Object.entries(byRepo)) {
      if (!Array.isArray(jobs)) continue;
      jobs.forEach((job, index) => {
        if (isMap(job)) out.push({ type, repo, index, job });
      });
    }
  }
  if (Array.isArray(doc.periodics)) {
    doc.periodics.forEach((job, index) => {
      if (isMap(job)) out.push({ type: "periodic", index, job });
    });
  }
  return out;
}

/** Where a job sits, as a path into the file: `presubmits["acme/app"][0]`. */
export function jobPath(j: LocatedJob): string {
  return j.type === "periodic" ? `periodics[${j.index}]` : `${j.type}s[${JSON.stringify(j.repo)}][${j.index}]`;
}

/** The job config text's comment lines before its first line of YAML, as written, or undefined. */
export function leadingComment(text: string): string | undefined {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) lines.push(line);
    else if (line.trim() === "") {
      if (lines.length === 0) continue;
      break;
    } else break;
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** Parse job config text; undefined when it is not one. */
export function parseJobConfig(text: string): Record<string, unknown> | undefined {
  try {
    const doc = parseYAML(text);
    return isJobConfig(doc) ? doc : undefined;
  } catch {
    return undefined;
  }
}
