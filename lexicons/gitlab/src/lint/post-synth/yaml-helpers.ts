/**
 * Helpers for parsing serialized GitLab CI YAML in post-synth checks.
 *
 * Jobs, stages and global variables are read with the structural parser
 * (`parseYAML`, js-yaml with chant's schema). Checks that pattern-match a
 * job's text get it from {@link extractJobSection}, which cuts the document
 * at top-level keys rather than at blank lines, so it does not depend on the
 * serializer's spacing.
 */

import { parseYAML } from "@intentius/chant/yaml";

export { getPrimaryOutput } from "@intentius/chant/lint/post-synth";

/**
 * Parse a serialized GitLab CI YAML into a structured object.
 * Returns null if the output can't be parsed.
 */
export interface ParsedGitLabCI {
  stages: string[];
  jobs: Map<string, ParsedJob>;
}

export interface ParsedJob {
  name: string;
  stage?: string;
  rules?: ParsedRule[];
  /**
   * Same-pipeline jobs this job needs, in every form GitLab accepts: a plain
   * name, `- job: name` (with `artifacts:`, `optional:`, `parallel:`), and
   * `needs: []`. Cross-pipeline needs (`pipeline:` or `project:`) name jobs
   * in another pipeline and are left out.
   */
  needs?: string[];
  /** The subset of {@link needs} declared `optional: true`. */
  optionalNeeds?: string[];
  extends?: string[];
}

export interface ParsedRule {
  when?: string;
  if?: string;
}

/**
 * Top-level keys that are global keywords, not jobs. `image`, `services`,
 * `cache`, `before_script` and `after_script` are the deprecated global
 * forms of the `default:` keywords; `spec` is a CI component's header.
 */
export const RESERVED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "stages",
  "variables",
  "default",
  "include",
  "workflow",
  "image",
  "services",
  "cache",
  "before_script",
  "after_script",
  "spec",
]);

/** Parse the pipeline document; `undefined` when the YAML cannot be read. */
export function parsePipeline(yaml: string): Record<string, unknown> | undefined {
  try {
    const doc = parseYAML(yaml);
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : undefined;
  } catch {
    return undefined;
  }
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function scalarString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/**
 * Every job in the pipeline as `[id, rawJobObject]`: each top-level key whose
 * value is a mapping, minus the global keywords. Hidden jobs (ids starting
 * with `.`, used as `extends:` templates) are included.
 */
export function jobEntries(yaml: string): Array<[string, Record<string, unknown>]> {
  const doc = parsePipeline(yaml);
  if (!doc) return [];
  const out: Array<[string, Record<string, unknown>]> = [];
  for (const [name, val] of Object.entries(doc)) {
    if (RESERVED_TOP_LEVEL_KEYS.has(name)) continue;
    if (isMapping(val)) out.push([name, val]);
  }
  return out;
}

/**
 * Extract stages list from serialized YAML (block or flow list).
 */
export function extractStages(yaml: string): string[] {
  const stages = parsePipeline(yaml)?.stages;
  if (!Array.isArray(stages)) return [];
  return stages.map(scalarString).filter((s): s is string => s !== undefined);
}

/**
 * Extract jobs with their stage, `needs:` and `extends:` from serialized YAML.
 *
 * Built on the structural parser, so every job id is read (capitals, spaces,
 * colons, quoted ids) and every `needs:` entry is read whatever keys follow
 * `job:` in its map. The line-based version this replaced skipped ids that
 * start with a capital and stopped reading a `needs:` list at an
 * `artifacts: true` line (#3256). YAML the parser cannot read gives no jobs.
 */
export function extractJobs(yaml: string): Map<string, ParsedJob> {
  const jobs = new Map<string, ParsedJob>();
  for (const [name, obj] of jobEntries(yaml)) {
    const job: ParsedJob = { name };

    const stage = scalarString(obj.stage);
    if (stage !== undefined) job.stage = stage;

    if (obj.needs !== undefined && obj.needs !== null) {
      const entries = Array.isArray(obj.needs) ? obj.needs : [obj.needs];
      const needs: string[] = [];
      const optional: string[] = [];
      for (const entry of entries) {
        const plain = scalarString(entry);
        if (plain !== undefined) {
          needs.push(plain);
          continue;
        }
        if (!isMapping(entry)) continue;
        // Cross-pipeline needs name a job in another pipeline.
        if ("pipeline" in entry || "project" in entry) continue;
        const target = scalarString(entry.job);
        if (target === undefined) continue;
        needs.push(target);
        if (entry.optional === true) optional.push(target);
      }
      job.needs = needs;
      if (optional.length > 0) job.optionalNeeds = optional;
    }

    if (obj.extends !== undefined && obj.extends !== null) {
      const ext = Array.isArray(obj.extends) ? obj.extends : [obj.extends];
      job.extends = ext.map(scalarString).filter((s): s is string => s !== undefined);
    }

    jobs.set(name, job);
  }
  return jobs;
}

/**
 * Check whether the YAML contains an `include:` directive.
 * When includes are present, `needs:` and `extends:` may reference
 * jobs/templates from included files, so checks should be lenient.
 */
export function hasInclude(yaml: string): boolean {
  return /^include:/m.test(yaml);
}

/**
 * Extract global variables from serialized YAML. A variable in the expanded
 * form (`value:` / `description:` / `options:`) maps to its `value`.
 */
export function extractGlobalVariables(yaml: string): Map<string, string> {
  const vars = new Map<string, string>();
  const variables = parsePipeline(yaml)?.variables;
  if (!isMapping(variables)) return vars;
  for (const [key, val] of Object.entries(variables)) {
    const v = isMapping(val) ? scalarString(val.value) : scalarString(val);
    vars.set(key, v ?? "");
  }
  return vars;
}

/**
 * The key of a top-level mapping line (`build:`, `Build_Docs:`,
 * `build:linux:`, `"deploy prod":`), unquoted, or undefined when the line
 * does not start a top-level key.
 */
export function topLevelKey(line: string): string | undefined {
  if (line === "" || /^[\s#]/.test(line) || /^(---|\.\.\.)(\s|$)/.test(line) || line.startsWith("- ")) return undefined;
  const dq = line.match(/^"((?:[^"\\]|\\.)*)"\s*:(?:\s|$)/);
  if (dq) {
    try {
      return JSON.parse(`"${dq[1]}"`) as string;
    } catch {
      return dq[1];
    }
  }
  const sq = line.match(/^'((?:[^']|'')*)'\s*:(?:\s|$)/);
  if (sq) return sq[1].replace(/''/g, "'");
  const plain = line.match(/^(.+?)\s*:(?:\s|$)/);
  return plain ? plain[1] : undefined;
}

/** A top-level section of the document: its key and its raw text. */
export interface TopLevelSection {
  key: string;
  text: string;
}

/**
 * Split the document into top-level sections. A section starts at a line
 * holding a top-level key and runs to the next one; blank lines and
 * column-0 comments at its end are dropped. Unlike splitting on blank
 * lines, this does not depend on the serializer's spacing.
 */
export function topLevelSections(yaml: string): TopLevelSection[] {
  const lines = yaml.replace(/\r\n?/g, "\n").split("\n");
  const out: TopLevelSection[] = [];
  let key: string | undefined;
  let start = 0;
  const flush = (end: number) => {
    if (key === undefined) return;
    let last = end;
    while (last > start + 1 && (lines[last - 1].trim() === "" || lines[last - 1].startsWith("#"))) last--;
    out.push({ key, text: lines.slice(start, last).join("\n") });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const k = topLevelKey(line);
    const boundary = k !== undefined || /^(---|\.\.\.)(\s|$)/.test(line);
    if (!boundary) continue;
    flush(i);
    key = k;
    start = i;
  }
  flush(lines.length);
  return out;
}

/**
 * Extract the full section text for a given job name (exact key match, so
 * `build` never returns the `build:linux` section).
 */
export function extractJobSection(yaml: string, jobName: string): string | null {
  return topLevelSections(yaml).find((s) => s.key === jobName)?.text ?? null;
}

/**
 * Extract rules from a job section.
 */
export function extractJobRules(section: string): ParsedRule[] {
  const rules: ParsedRule[] = [];
  const lines = section.split("\n");

  let inRules = false;
  let currentRule: ParsedRule = {};

  for (const line of lines) {
    if (line.match(/^\s+rules:$/)) {
      inRules = true;
      continue;
    }

    if (inRules) {
      const ruleStart = line.match(/^\s+- (if|when|changes):\s*(.*)$/);
      if (ruleStart) {
        if (Object.keys(currentRule).length > 0) {
          rules.push(currentRule);
        }
        currentRule = {};
        if (ruleStart[1] === "if") currentRule.if = ruleStart[2].trim();
        if (ruleStart[1] === "when") currentRule.when = ruleStart[2].trim();
        continue;
      }

      const whenMatch = line.match(/^\s+when:\s+(.+)$/);
      if (whenMatch) {
        currentRule.when = whenMatch[1].trim();
        continue;
      }

      // End of rules block
      if (!line.match(/^\s+\s/) || line.match(/^\s+[a-z_]+:/) && !line.match(/^\s+when:/)) {
        if (Object.keys(currentRule).length > 0) {
          rules.push(currentRule);
        }
        inRules = false;
      }
    }
  }

  if (inRules && Object.keys(currentRule).length > 0) {
    rules.push(currentRule);
  }

  return rules;
}

/** A container image reference (job/default `image:` or a `services:` entry). */
export interface ImageRef {
  /** Owning job name, or "default" for the global image. */
  job: string;
  /** The image reference (e.g. `node:20`). */
  image: string;
  /** Where the image was declared. */
  source: "image" | "service";
}

/**
 * Extract container image references from `image:` and `services:` across the
 * pipeline. Handles both the object form (`image:\n  name: ...`) and the inline
 * string form (`image: ...`).
 */
export function extractImageRefs(yaml: string): ImageRef[] {
  const refs: ImageRef[] = [];
  for (const { key: job, text: section } of topLevelSections(yaml)) {
    const lines = section.split("\n");

    for (let i = 0; i < lines.length; i++) {
      // image: as object (next indented `name:`) or inline string
      const imgInline = lines[i].match(/^\s+image:\s+(\S.*)$/);
      if (imgInline) {
        refs.push({ job, image: imgInline[1].trim().replace(/^['"]|['"]$/g, ""), source: "image" });
        continue;
      }
      if (/^\s+image:\s*$/.test(lines[i])) {
        const nameLine = lines.slice(i + 1, i + 4).find((l) => /^\s+name:\s+/.test(l));
        if (nameLine) {
          const v = nameLine.replace(/^\s+name:\s+/, "").trim().replace(/^['"]|['"]$/g, "");
          refs.push({ job, image: v, source: "image" });
        }
        continue;
      }
      // services: list entries — `- name:` or `- 'image'`
      const svcName = lines[i].match(/^\s+-\s+name:\s+(\S.*)$/);
      if (svcName) {
        refs.push({ job, image: svcName[1].trim().replace(/^['"]|['"]$/g, ""), source: "service" });
      }
    }
  }
  return refs;
}

/** An `include:` entry from the top-level include block. */
export interface IncludeEntry {
  kind: "project" | "remote" | "component" | "local" | "template" | "string";
  /** The primary value (project path, URL, component address, …). */
  value: string;
  /** `ref:` for project includes, if present. */
  ref?: string;
}

/**
 * Parse the top-level `include:` block into structured entries.
 */
export function extractIncludes(yaml: string): IncludeEntry[] {
  const entries: IncludeEntry[] = [];
  const section = topLevelSections(yaml).find((s) => s.key === "include")?.text;
  if (!section) return entries;

  // Inline string form: `include: <value>` (value on the same line, not a list)
  const inline = section.match(/^include:[ \t]+(\S.*)$/m);
  if (inline) {
    entries.push({ kind: "string", value: inline[1].trim().replace(/^['"]|['"]$/g, "") });
    return entries;
  }

  const lines = section.split("\n");
  let current: IncludeEntry | undefined;
  const push = () => { if (current) entries.push(current); current = undefined; };
  for (const line of lines) {
    const start = line.match(/^\s+-\s+(project|remote|component|local|template):\s*(.*)$/);
    if (start) {
      push();
      current = { kind: start[1] as IncludeEntry["kind"], value: start[2].trim().replace(/^['"]|['"]$/g, "") };
      continue;
    }
    const refLine = line.match(/^\s+ref:\s+(.+)$/);
    if (refLine && current) {
      current.ref = refLine[1].trim().replace(/^['"]|['"]$/g, "");
    }
    // A bare `- 'https://...'` short remote form
    const bare = line.match(/^\s+-\s+(['"]?https?:\/\/\S+['"]?)\s*$/);
    if (bare) {
      push();
      entries.push({ kind: "remote", value: bare[1].replace(/^['"]|['"]$/g, "") });
    }
  }
  push();
  return entries;
}

/** True if a git ref is an immutable pin (40-hex SHA or a vN.N.N-style tag). */
export function isPinnedRef(ref: string): boolean {
  if (/^[0-9a-f]{40}$/.test(ref)) return true;
  // Semver-ish tag with all components fixed (v1.2.3 / 1.2.3)
  if (/^v?\d+\.\d+\.\d+$/.test(ref)) return true;
  return false;
}

/** An `id_tokens:` OIDC token declaration within a job. */
export interface IdTokenDecl {
  job: string;
  /** Token variable name (e.g. `GCP_ID_TOKEN`). */
  name: string;
  /** Declared audiences (`aud:`), empty if none. */
  aud: string[];
}

/**
 * Extract `id_tokens:` declarations (OIDC) per job, with their audiences.
 */
export function extractIdTokens(yaml: string): IdTokenDecl[] {
  const out: IdTokenDecl[] = [];
  for (const { key: job, text: section } of topLevelSections(yaml)) {
    const lines = section.split("\n");

    let inIdTokens = false;
    let idTokensIndent = -1;
    let current: IdTokenDecl | undefined;
    const flush = () => { if (current) out.push(current); current = undefined; };

    for (const line of lines) {
      if (/^\s+id_tokens:\s*$/.test(line)) {
        inIdTokens = true;
        idTokensIndent = line.search(/\S/);
        continue;
      }
      if (!inIdTokens) continue;
      const indent = line.search(/\S/);
      if (line.trim() !== "" && indent <= idTokensIndent) { flush(); inIdTokens = false; continue; }

      const tokenName = line.match(/^\s+([A-Z_][A-Z0-9_]*):\s*$/);
      if (tokenName && indent === idTokensIndent + 2) {
        flush();
        current = { job, name: tokenName[1], aud: [] };
        continue;
      }
      const audInline = line.match(/^\s+aud:\s+(\S.*)$/);
      if (audInline && current) {
        const v = audInline[1].trim();
        if (v.startsWith("[")) {
          for (const p of v.replace(/^\[|\]$/g, "").split(",")) {
            const t = p.trim().replace(/^['"]|['"]$/g, "");
            if (t) current.aud.push(t);
          }
        } else {
          current.aud.push(v.replace(/^['"]|['"]$/g, ""));
        }
        continue;
      }
      const audItem = line.match(/^\s+-\s+(\S.*)$/);
      if (audItem && current) {
        current.aud.push(audItem[1].trim().replace(/^['"]|['"]$/g, ""));
      }
    }
    flush();
  }
  return out;
}

/** True if a job section's rules make it reachable from merge-request pipelines. */
export function isMergeRequestReachable(section: string): boolean {
  return /merge_request_event|CI_MERGE_REQUEST|CI_PIPELINE_SOURCE\s*==\s*['"]?merge_request/.test(section);
}

/** A shell command line from a `script:` / `before_script:` / `after_script:`. */
export interface ScriptCommand {
  job: string;
  command: string;
}

/**
 * Extract shell command lines from all `script:` family blocks, per job.
 */
export function extractScriptCommands(yaml: string): ScriptCommand[] {
  const out: ScriptCommand[] = [];
  for (const { key: job, text: section } of topLevelSections(yaml)) {
    const lines = section.split("\n");

    let inScript = false;
    let scriptIndent = -1;
    for (const line of lines) {
      if (/^\s+(before_script|after_script|script):\s*$/.test(line)) {
        inScript = true;
        scriptIndent = line.search(/\S/);
        continue;
      }
      // inline form `script: cmd`
      const inlineScript = line.match(/^\s+(?:before_script|after_script|script):\s+(\S.*)$/);
      if (inlineScript) {
        out.push({ job, command: inlineScript[1].trim().replace(/^['"]|['"]$/g, "") });
        continue;
      }
      if (!inScript) continue;
      const indent = line.search(/\S/);
      if (line.trim() !== "" && indent <= scriptIndent) { inScript = false; continue; }
      const item = line.match(/^\s+-\s+(.*)$/);
      if (item) out.push({ job, command: item[1].trim().replace(/^['"]|['"]$/g, "") });
    }
  }
  return out;
}
