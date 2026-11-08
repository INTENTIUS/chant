/**
 * A repository's own jobs in a pipeline file chant generates (#4769).
 *
 * chant's generators write the whole file, so a job a repository adds by
 * hand is gone at the next `chant build`. Two ways keep it:
 *
 * - a jobs file, or a map of jobs, merged after chant's jobs
 *   ({@link mergeOwnJobs}, `chant build --own-jobs <file>`). The file is in
 *   the forge's own syntax: a map of job name to job. A name chant's file
 *   already gives a job is refused, and on GitLab a top-level keyword too.
 *   terragucci's `own_jobs` works this way.
 * - the jobs of the old file that the new one lacks, put back as they were
 *   written, comments and all ({@link keepOwnJobs}, `chant build
 *   --keep-own-jobs`). A job that runs `chant` or the product's bin counts as
 *   generated and is not kept. plywood's `init` and `ci` work this way.
 *
 * Either way the jobs go after chant's, under one comment line: inside
 * `jobs:` at two spaces on GitHub and Forgejo, and at the top level on
 * GitLab. The blocks are read as text by their indentation, so a kept job
 * keeps its formatting. A file with no own jobs is returned unchanged.
 */

import { readFileSync } from "node:fs";
import { emitYAMLEntry, parseYAMLDocument } from "./yaml";

/** The first chant with `mergeOwnJobs`, `keepOwnJobs` and `chant build --own-jobs` / `--keep-own-jobs` (#4769). Products feature-detect on it. */
export const OWN_JOBS_FLOOR = "0.124.77";

/** The forges whose pipeline files take own jobs. */
export type OwnJobsForge = "github" | "gitlab" | "forgejo";
export const OWN_JOBS_FORGES: readonly OwnJobsForge[] = ["github", "gitlab", "forgejo"];

/** The default line above the own jobs. A product passes its own as `line`. */
export const OWN_JOBS_LINE = "# Your own jobs, kept as they are when chant writes this file again.";

/** GitLab's top-level keys that are not jobs: never read as a job, never kept. */
export const GITLAB_TOP_KEYWORDS: readonly string[] = ["default", "include", "stages", "variables", "workflow", "image", "services", "cache", "before_script", "after_script", "spec"];

/** The names an own job may not take on GitLab: the keywords, and `pages`, which GitLab reads as its Pages job. */
export const GITLAB_RESERVED_JOB_NAMES: readonly string[] = [...GITLAB_TOP_KEYWORDS, "pages"];

/** A job name every forge's YAML reads as a plain key. */
export const OWN_JOB_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** An own job refused: a collision, a reserved name, or a file that is not a map of jobs. */
export class OwnJobsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnJobsError";
  }
}

const KEY = /^([A-Za-z0-9_.-]+|"[^"]+"|'[^']+'):(\s|$)/;
const JOBS_LINE = /^jobs:\s*(#.*)?$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isContent(line: string): boolean {
  const t = line.trim();
  return t !== "" && !t.startsWith("#");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Each job's block of lines in `text`, by name, in file order. */
export function jobBlocks(text: string, forge: OwnJobsForge): Map<string, string> {
  const lines = text.split("\n");
  const out = new Map<string, string>();
  let start = 0;
  let end = lines.length;
  let depth = 0;
  if (forge !== "gitlab") {
    const at = lines.findIndex((l) => JOBS_LINE.test(l));
    if (at < 0) return out;
    start = at + 1;
    const next = lines.findIndex((l, i) => i > at && indentOf(l) === 0 && isContent(l));
    end = next < 0 ? lines.length : next;
    depth = 2;
  }
  let name: string | undefined;
  let body: string[] = [];
  const flush = (): void => {
    if (name !== undefined) {
      while (body.length > 0 && body[body.length - 1]!.trim() === "") body.pop();
      out.set(name, body.join("\n"));
    }
    name = undefined;
    body = [];
  };
  for (let i = start; i < end; i++) {
    const line = lines[i]!;
    if (isContent(line) && indentOf(line) === depth) {
      const m = KEY.exec(line.slice(depth));
      flush();
      if (m) {
        name = m[1]!.replace(/^["']|["']$/g, "");
        body = [line];
      }
      continue;
    }
    if (isContent(line) && indentOf(line) < depth) {
      flush();
      continue;
    }
    if (name !== undefined) body.push(line);
  }
  flush();
  if (forge === "gitlab") for (const k of [...out.keys()]) if (GITLAB_TOP_KEYWORDS.includes(k)) out.delete(k);
  return out;
}

/** The job names of a pipeline file. */
export function jobNames(text: string, forge: OwnJobsForge): string[] {
  return [...jobBlocks(text, forge).keys()];
}

/** `generated` with `blocks` after chant's jobs, under `line`. */
function withBlocks(generated: string, blocks: string[], forge: OwnJobsForge, line: string): string {
  if (blocks.length === 0) return generated;
  const indent = forge === "gitlab" ? "" : "  ";
  const block = [`${indent}${line}`, ...blocks].join("\n");
  const lines = generated.replace(/\n+$/, "").split("\n");
  if (forge !== "gitlab") {
    const at = lines.findIndex((l) => JOBS_LINE.test(l));
    if (at >= 0) {
      const next = lines.findIndex((l, i) => i > at && indentOf(l) === 0 && isContent(l));
      if (next >= 0) {
        let cut = next;
        while (cut > at + 1 && lines[cut - 1]!.trim() === "") cut--;
        return [...lines.slice(0, cut), block, ...lines.slice(cut)].join("\n") + "\n";
      }
    }
  }
  return [...lines, block].join("\n") + "\n";
}

/** The problems with `own` as a map of job name to job; `where` names it in each. */
export function ownJobsProblems(own: unknown, where: string): string[] {
  if (own === null || typeof own !== "object" || Array.isArray(own)) return [`${where} must be a map of job name to job`];
  const problems: string[] = [];
  for (const [name, job] of Object.entries(own as Record<string, unknown>)) {
    if (!OWN_JOB_NAME.test(name)) problems.push(`${where}: ${JSON.stringify(name)} is not a job name; use letters, digits, "_" and "-"`);
    else if (job === null || typeof job !== "object" || Array.isArray(job) || Object.keys(job).length === 0) problems.push(`${where}.${name} must be a job: a map of its keys, in the forge's own syntax`);
  }
  return problems;
}

/** The map of jobs a YAML file holds. Throws {@link OwnJobsError} when it is missing, not YAML, or not a map of jobs. */
export function readOwnJobsFile(path: string, where = path): Record<string, Record<string, unknown>> {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    throw new OwnJobsError(`${where}: no such file`);
  }
  let doc: unknown;
  try {
    doc = parseYAMLDocument(text);
  } catch (e) {
    throw new OwnJobsError(`${where} is not YAML (${(e as Error).message})`);
  }
  const problems = ownJobsProblems(doc, where);
  if (problems.length > 0) throw new OwnJobsError(problems.join("; "));
  return doc as Record<string, Record<string, unknown>>;
}

export interface MergeOwnJobsOptions {
  /** The line above the jobs. Default {@link OWN_JOBS_LINE}. */
  line?: string;
  /** What the jobs are called in a refusal, such as `own_jobs` or the file's path. Default `own jobs`. */
  where?: string;
  /** Names the generated file's jobs take, when the caller knows them; default: read from `generated`. */
  generatedJobs?: readonly string[];
}

/**
 * The YAML of `own`, as it goes after chant's jobs: {@link OWN_JOBS_LINE} (or
 * `line`), then each job as it is. Empty for no jobs. Throws
 * {@link OwnJobsError} on a name in `ours` or, on GitLab, a reserved one.
 */
export function ownJobsYAML(own: Record<string, unknown> | undefined, ours: readonly string[], forge: OwnJobsForge, options: Omit<MergeOwnJobsOptions, "generatedJobs"> = {}): string {
  if (!own || Object.keys(own).length === 0) return "";
  const where = options.where ?? "own jobs";
  const problems = ownJobsProblems(own, where);
  if (problems.length > 0) throw new OwnJobsError(problems.join("; "));
  for (const name of Object.keys(own)) {
    if (ours.includes(name)) throw new OwnJobsError(`${where}.${name}: chant's file has a job of that name; give yours another`);
    if (forge === "gitlab" && GITLAB_RESERVED_JOB_NAMES.includes(name)) throw new OwnJobsError(`${where}.${name}: GitLab reads ${name} as a keyword, not a job; give yours another name`);
  }
  const indent = forge === "gitlab" ? 0 : 1;
  return [`${forge === "gitlab" ? "" : "  "}${options.line ?? OWN_JOBS_LINE}`, ...Object.entries(own).map(([name, job]) => emitYAMLEntry(name, job, indent))].join("\n") + "\n";
}

/** `generated` with `own` after chant's jobs (terragucci's `own_jobs` model). Unchanged for no jobs. */
export function mergeOwnJobs(generated: string, forge: OwnJobsForge, own: Record<string, unknown> | undefined, options: MergeOwnJobsOptions = {}): string {
  if (!own || Object.keys(own).length === 0) return generated;
  const ours = options.generatedJobs ?? jobNames(generated, forge);
  const rendered = ownJobsYAML(own, ours, forge, options).replace(/\n$/, "");
  const [line, ...rest] = rendered.split("\n");
  // The rendered text starts with the indented line; withBlocks adds the indent itself.
  return withBlocks(generated, [rest.join("\n")], forge, line!.trimStart());
}

/** The bins whose lines mark a job as generated: `chant`, and each of `bins` with its last word (`npx --no-install plywood` and `plywood`). */
function generatedLine(bins: readonly string[]): RegExp {
  const names = new Set<string>(["chant"]);
  for (const bin of bins) {
    const b = bin.trim();
    if (b === "") continue;
    names.add(b);
    names.add(b.split(/\s+/).pop()!.split("/").pop()!);
  }
  const alt = [...names].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  return new RegExp(`(^|[\\s"'(]|\\$\\()(?:${alt}) (?=[a-z])`, "m");
}

/** Whether a job's block runs `chant` or one of `bins`: a job chant's generator wrote. */
export function isGeneratedJob(block: string, bins: readonly string[] = []): boolean {
  return generatedLine(bins).test(block);
}

export interface KeepOwnJobsOptions {
  /** The product's bin, such as `npx --no-install plywood`: a job that runs it is generated. `chant` always counts. */
  bins?: readonly string[];
  /** The line above the kept jobs. Default {@link OWN_JOBS_LINE}. */
  line?: string;
}

/** The jobs of `previous` that `generated` lacks and that run neither `chant` nor a bin of `bins`. */
export function ownJobsOf(previous: string, generated: string, forge: OwnJobsForge, bins: readonly string[] = []): Map<string, string> {
  const ours = jobBlocks(generated, forge);
  const out = new Map<string, string>();
  for (const [name, block] of jobBlocks(previous, forge)) {
    if (ours.has(name) || isGeneratedJob(block, bins)) continue;
    out.set(name, block);
  }
  return out;
}

/**
 * The old file's own jobs carried into the new one (plywood's model):
 * `previous` undefined means there was no file. `kept` names them.
 */
export function keepOwnJobs(previous: string | undefined, generated: string, forge: OwnJobsForge, options: KeepOwnJobsOptions = {}): { text: string; kept: string[] } {
  if (previous === undefined) return { text: generated, kept: [] };
  const own = ownJobsOf(previous, generated, forge, options.bins ?? []);
  return { text: withBlocks(generated, [...own.values()], forge, options.line ?? OWN_JOBS_LINE), kept: [...own.keys()] };
}
