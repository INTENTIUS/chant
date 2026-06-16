/**
 * Helpers for parsing serialized GitHub Actions YAML in post-synth checks.
 */

import { parseYAML } from "@intentius/chant/yaml";
import type { SerializerResult } from "@intentius/chant/serializer";

export { getPrimaryOutput } from "@intentius/chant/lint/post-synth";

/**
 * Return the emitted `.github/dependabot.yml` content from a serializer output,
 * if present (it rides as an additional file alongside the workflow output).
 */
export function getDependabotYaml(output: string | SerializerResult): string | undefined {
  if (typeof output === "string") return undefined;
  return output.files?.["dependabot.yml"];
}

/** Parse the `updates:` array from a dependabot.yml document. */
export function extractDependabotUpdates(dependabotYaml: string): Array<Record<string, unknown>> {
  let doc: Record<string, unknown>;
  try {
    doc = parseYAML(dependabotYaml);
  } catch {
    return [];
  }
  const updates = doc.updates;
  return Array.isArray(updates) ? (updates as Array<Record<string, unknown>>) : [];
}

export interface ParsedJob {
  name: string;
  needs?: string[];
  steps?: Array<{ uses?: string; run?: string; name?: string }>;
  permissions?: Record<string, string>;
}

/**
 * Extract jobs from a serialized GitHub Actions workflow YAML.
 */
export function extractJobs(yaml: string): Map<string, ParsedJob> {
  const jobs = new Map<string, ParsedJob>();

  // Find the jobs: section — take everything after `jobs:\n`
  const jobsIdx = yaml.search(/^jobs:\s*$/m);
  if (jobsIdx === -1) return jobs;

  // Content after the `jobs:` line. Stop at the next top-level key (non-indented) or EOF.
  const afterJobs = yaml.slice(jobsIdx + yaml.slice(jobsIdx).indexOf("\n") + 1);
  const endMatch = afterJobs.search(/^[a-z]/m);
  const jobsContent = endMatch === -1 ? afterJobs : afterJobs.slice(0, endMatch);

  // Split into individual jobs by finding lines with exactly 2 spaces of indent followed by a key
  const jobSections = jobsContent.split(/\n(?=  [a-z][a-z0-9-]*:)/);

  for (const section of jobSections) {
    const nameMatch = section.match(/^\s{2}([a-z][a-z0-9-]*):/);
    if (!nameMatch) continue;

    const name = nameMatch[1];
    const job: ParsedJob = { name };

    // Extract needs
    const needsInline = section.match(/^\s{4}needs:\s+\[(.+)\]$/m);
    if (needsInline) {
      job.needs = needsInline[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "").replace(/^"|"$/g, ""));
    } else {
      const needsList = section.match(/^\s{4}needs:\n((?:\s{6}- .+\n?)+)/m);
      if (needsList) {
        job.needs = [];
        for (const line of needsList[1].split("\n")) {
          const item = line.match(/^\s{6}- (.+)$/);
          if (item) job.needs.push(item[1].trim().replace(/^'|'$/g, "").replace(/^"|"$/g, ""));
        }
      }
    }

    // Extract steps with uses:
    const stepsMatch = section.match(/^\s{4}steps:\n([\s\S]*?)(?=\n\s{4}[a-z]|\n\s{2}[a-z]|$)/m);
    if (stepsMatch) {
      job.steps = [];
      const stepEntries = stepsMatch[1].split(/\n(?=\s{6}- )/);
      for (const stepEntry of stepEntries) {
        const usesMatch = stepEntry.match(/uses:\s+(.+)$/m);
        const runMatch = stepEntry.match(/run:\s+(.+)$/m);
        const stepNameMatch = stepEntry.match(/name:\s+(.+)$/m);
        if (usesMatch || runMatch) {
          job.steps.push({
            uses: usesMatch?.[1] ? stripUsesComment(usesMatch[1].trim().replace(/^'|'$/g, "")) : undefined,
            run: runMatch?.[1]?.trim(),
            name: stepNameMatch?.[1]?.trim().replace(/^'|'$/g, ""),
          });
        }
      }
    }

    jobs.set(name, job);
  }

  return jobs;
}

/**
 * Extract trigger events from the YAML.
 */
export function extractTriggers(yaml: string): Record<string, unknown> {
  const onMatch = yaml.match(/^on:\n([\s\S]*?)(?=\n[a-z]|$)/m);
  if (!onMatch) return {};

  const triggers: Record<string, unknown> = {};
  const lines = onMatch[1].split("\n");
  for (const line of lines) {
    const triggerMatch = line.match(/^\s{2}([a-z_]+):/);
    if (triggerMatch) {
      triggers[triggerMatch[1]] = true;
    }
  }
  return triggers;
}

/**
 * Check if any step in the list uses a checkout action.
 */
export function hasCheckoutAction(steps: Array<{ uses?: string }>): boolean {
  return steps.some((s) => s.uses?.startsWith("actions/checkout"));
}

/**
 * Build a needs dependency graph from the YAML.
 */
export function buildNeedsGraph(yaml: string): Map<string, string[]> {
  const jobs = extractJobs(yaml);
  const graph = new Map<string, string[]>();
  for (const [name, job] of jobs) {
    graph.set(name, job.needs ?? []);
  }
  return graph;
}

/**
 * Extract the workflow name from the YAML.
 */
export function extractWorkflowName(yaml: string): string | undefined {
  const match = yaml.match(/^name:\s+(.+)$/m);
  return match?.[1]?.trim().replace(/^'|'$/g, "");
}

/**
 * Check if the YAML has an explicit permissions block.
 */
export function hasPermissions(yaml: string): boolean {
  return /^permissions:/m.test(yaml);
}

/** A single `uses:` reference found in a workflow. */
export interface ActionRef {
  /** Owning job name. */
  job: string;
  /** The raw `uses:` value (e.g. `actions/setup-node@v4`). */
  ref: string;
  /** Whether it is a step-level action or a job-level reusable workflow. */
  level: "step" | "job";
}

/** A container/service/docker image reference found in a workflow. */
export interface ImageRef {
  /** Owning job name. */
  job: string;
  /** The raw image reference (e.g. `node:20`). */
  image: string;
  /** Where the image was declared. */
  source: "container" | "service" | "step";
}

function parseDoc(yaml: string): Record<string, unknown> | undefined {
  try {
    return parseYAML(yaml);
  } catch {
    return undefined;
  }
}

function jobEntries(yaml: string): Array<[string, Record<string, unknown>]> {
  const doc = parseDoc(yaml);
  const jobs = doc?.jobs;
  if (!jobs || typeof jobs !== "object") return [];
  const out: Array<[string, Record<string, unknown>]> = [];
  for (const [name, val] of Object.entries(jobs as Record<string, unknown>)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      out.push([name, val as Record<string, unknown>]);
    }
  }
  return out;
}

/**
 * Extract every `uses:` reference from the workflow — both step-level actions
 * and job-level reusable-workflow calls. Uses the structural YAML parser so
 * nested jobs/steps are handled reliably.
 */
export function extractActionRefs(yaml: string): ActionRef[] {
  const refs: ActionRef[] = [];
  for (const [job, jobObj] of jobEntries(yaml)) {
    if (typeof jobObj.uses === "string") {
      refs.push({ job, ref: jobObj.uses, level: "job" });
    }
    const steps = jobObj.steps;
    if (Array.isArray(steps)) {
      for (const step of steps) {
        if (step && typeof step === "object" && typeof (step as Record<string, unknown>).uses === "string") {
          refs.push({ job, ref: (step as Record<string, unknown>).uses as string, level: "step" });
        }
      }
    }
  }
  return refs;
}

/**
 * Extract every container/service/`docker://` image reference from the workflow.
 */
export function extractImageRefs(yaml: string): ImageRef[] {
  const refs: ImageRef[] = [];
  for (const [job, jobObj] of jobEntries(yaml)) {
    const container = jobObj.container;
    if (typeof container === "string") {
      refs.push({ job, image: container, source: "container" });
    } else if (container && typeof container === "object" && typeof (container as Record<string, unknown>).image === "string") {
      refs.push({ job, image: (container as Record<string, unknown>).image as string, source: "container" });
    }

    const services = jobObj.services;
    if (services && typeof services === "object" && !Array.isArray(services)) {
      for (const svc of Object.values(services as Record<string, unknown>)) {
        if (typeof svc === "string") {
          refs.push({ job, image: svc, source: "service" });
        } else if (svc && typeof svc === "object" && typeof (svc as Record<string, unknown>).image === "string") {
          refs.push({ job, image: (svc as Record<string, unknown>).image as string, source: "service" });
        }
      }
    }

    const steps = jobObj.steps;
    if (Array.isArray(steps)) {
      for (const step of steps) {
        const uses = step && typeof step === "object" ? (step as Record<string, unknown>).uses : undefined;
        if (typeof uses === "string" && uses.startsWith("docker://")) {
          refs.push({ job, image: uses.slice("docker://".length), source: "step" });
        }
      }
    }
  }
  return refs;
}

/**
 * Walk the `jobs:` block line-by-line, tracking the current job. Robust to `|`
 * block scalars (which the structural parser does not handle), so it is the
 * right tool for scanning `run:`/`if:`/`runs-on:` content.
 */
function scanJobLines(yaml: string, onLine: (job: string, line: string, indent: number, lineNo: number, lines: string[]) => void): void {
  const lines = yaml.split("\n");
  let inJobs = false;
  let currentJob = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    if (/^\S/.test(line)) { inJobs = false; continue; } // dedented to a new top-level key
    const jobHeader = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (jobHeader) { currentJob = jobHeader[1]; continue; }
    if (!currentJob) continue;
    const indent = line.search(/\S/);
    if (indent < 0) continue;
    onLine(currentJob, line, indent, i, lines);
  }
}

/** A `run:` script block with its owning job. */
export interface RunBlock {
  job: string;
  run: string;
}

/**
 * Extract every `run:` script (inline and `|`/`>` block scalars) with its
 * owning job.
 */
export function extractRunBlocks(yaml: string): RunBlock[] {
  const out: RunBlock[] = [];
  const consumed = new Set<number>();
  scanJobLines(yaml, (job, line, _indent, lineNo, lines) => {
    if (consumed.has(lineNo)) return;
    const m = line.match(/^(\s*)(- )?run:\s*(.*)$/);
    if (!m) return;
    const keyIndent = m[1].length + (m[2] ? 2 : 0); // column where `run:` begins
    const value = m[3].trim();
    if (value === "|" || value === "|-" || value === ">" || value === ">-" || value === "|+" || value === ">+") {
      const blockLines: string[] = [];
      for (let j = lineNo + 1; j < lines.length; j++) {
        const bl = lines[j];
        if (bl.trim() === "") { blockLines.push(""); consumed.add(j); continue; }
        const bi = bl.search(/\S/);
        if (bi <= keyIndent) break;
        blockLines.push(bl.trimStart());
        consumed.add(j);
      }
      out.push({ job, run: blockLines.join("\n") });
    } else {
      out.push({ job, run: value.replace(/^['"]|['"]$/g, "") });
    }
  });
  return out;
}

/** An `if:` condition with its owning job. */
export interface IfCondition {
  job: string;
  expr: string;
}

/** Extract every `if:` condition (job-level and step-level) with its job. */
export function extractIfConditions(yaml: string): IfCondition[] {
  const out: IfCondition[] = [];
  scanJobLines(yaml, (job, line) => {
    const m = line.match(/^\s+(?:- )?if:\s*(.+)$/);
    if (m) out.push({ job, expr: m[1].trim().replace(/^['"]|['"]$/g, "") });
  });
  return out;
}

/** Extract each job's `runs-on:` value(s) as a flat list of labels. */
export function extractRunsOnByJob(yaml: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  scanJobLines(yaml, (job, line, indent, lineNo, lines) => {
    const m = line.match(/^\s+runs-on:\s*(.*)$/);
    if (!m) return;
    const value = m[1].trim();
    const labels: string[] = [];
    if (value === "") {
      for (let j = lineNo + 1; j < lines.length; j++) {
        const item = lines[j].match(/^\s+- (.+)$/);
        if (!item) break;
        labels.push(item[1].trim().replace(/^['"]|['"]$/g, ""));
      }
    } else if (value.startsWith("[")) {
      for (const part of value.replace(/^\[|\]$/g, "").split(",")) {
        const t = part.trim().replace(/^['"]|['"]$/g, "");
        if (t) labels.push(t);
      }
    } else {
      labels.push(value.replace(/^['"]|['"]$/g, ""));
    }
    out.set(job, labels);
  });
  return out;
}

/** Pull every `${{ ... }}` expression body out of a string. */
export function extractExpressions(text: string): string[] {
  const out: string[] = [];
  const re = /\$\{\{(.+?)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

/** Every line inside the `jobs:` block paired with its owning job name. */
export function jobLines(yaml: string): Array<{ job: string; line: string }> {
  const out: Array<{ job: string; line: string }> = [];
  scanJobLines(yaml, (job, line) => out.push({ job, line }));
  return out;
}

/** All lines inside the `jobs:` block grouped by owning job. */
export function linesByJob(yaml: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  scanJobLines(yaml, (job, line) => {
    const arr = out.get(job) ?? [];
    arr.push(line);
    out.set(job, arr);
  });
  return out;
}

/** Set of jobs that declare an `environment:`. */
export function extractJobEnvironments(yaml: string): Set<string> {
  const set = new Set<string>();
  scanJobLines(yaml, (job, line) => {
    if (/^\s+environment:/.test(line)) set.add(job);
  });
  return set;
}

/** Set of jobs whose body references a `secrets.` context. */
export function jobsReferencingSecrets(yaml: string): Set<string> {
  const set = new Set<string>();
  scanJobLines(yaml, (job, line) => {
    if (/secrets\./.test(line)) set.add(job);
  });
  return set;
}

/** A permissions value as it appears in YAML: a string preset or a scope map. */
export type PermissionsValue = string | Record<string, string>;

/** The workflow-level `permissions:` value, if present. */
export function extractWorkflowPermissions(yaml: string): PermissionsValue | undefined {
  const doc = parseDoc(yaml);
  const perms = doc?.permissions;
  if (typeof perms === "string") return perms;
  if (perms && typeof perms === "object" && !Array.isArray(perms)) return perms as Record<string, string>;
  return undefined;
}

/** Per-job `permissions:` values, keyed by job name. Only jobs that declare one. */
export function extractJobPermissions(yaml: string): Map<string, PermissionsValue> {
  const out = new Map<string, PermissionsValue>();
  for (const [job, jobObj] of jobEntries(yaml)) {
    const perms = jobObj.permissions;
    if (typeof perms === "string") out.set(job, perms);
    else if (perms && typeof perms === "object" && !Array.isArray(perms)) out.set(job, perms as Record<string, string>);
  }
  return out;
}

/**
 * Classify a permissions value's write surface.
 * `writeAll` is the `write-all` blanket preset; `scopes` lists the individual
 * scopes granted `write` in map form.
 */
export function writeSurface(perms: PermissionsValue): { writeAll: boolean; scopes: string[] } {
  if (typeof perms === "string") {
    return { writeAll: perms === "write-all", scopes: [] };
  }
  const scopes: string[] = [];
  for (const [scope, level] of Object.entries(perms)) {
    if (level === "write") scopes.push(scope);
  }
  return { writeAll: false, scopes };
}

/** True if the permissions value grants any write access (blanket or scoped). */
export function grantsWrite(perms: PermissionsValue): boolean {
  const { writeAll, scopes } = writeSurface(perms);
  return writeAll || scopes.length > 0;
}

/**
 * Split an action `uses:` value into its `owner/repo` slug and git ref.
 * Returns undefined for local (`./`, `../`) and `docker://` references, which
 * are not GitHub action repository references.
 */
/**
 * Strip a trailing inline YAML comment from a `uses:` value. A `uses` ref
 * cannot contain whitespace, so `<ref> # v1.2.3` (the recommended SHA-pin
 * style) is safe to trim back to `<ref>`.
 */
export function stripUsesComment(uses: string): string {
  return uses.replace(/\s+#.*$/, "").trim();
}

export function parseActionUses(rawUses: string): { owner: string; repo: string; slug: string; gitRef: string } | undefined {
  const uses = stripUsesComment(rawUses);
  if (uses.startsWith("./") || uses.startsWith("../") || uses.startsWith("docker://")) return undefined;
  const at = uses.lastIndexOf("@");
  const path = at === -1 ? uses : uses.slice(0, at);
  const gitRef = at === -1 ? "" : uses.slice(at + 1);
  const segments = path.split("/");
  if (segments.length < 2 || !segments[0] || !segments[1]) return undefined;
  return { owner: segments[0], repo: segments[1], slug: `${segments[0]}/${segments[1]}`, gitRef };
}
