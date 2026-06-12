/**
 * Helpers for parsing serialized GitLab CI YAML in post-synth checks.
 *
 * Since GitLab CI output is YAML (not JSON like CloudFormation), we parse
 * the YAML sections structurally using simple regex/string parsing. The
 * serializer emits a predictable format so we can extract what we need
 * without a full YAML parser dependency.
 */

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
  needs?: string[];
  extends?: string[];
}

export interface ParsedRule {
  when?: string;
  if?: string;
}

/**
 * Extract stages list from serialized YAML.
 */
export function extractStages(yaml: string): string[] {
  const stages: string[] = [];
  const stagesMatch = yaml.match(/^stages:\n((?:\s+- .+\n?)+)/m);
  if (stagesMatch) {
    for (const line of stagesMatch[1].split("\n")) {
      const item = line.match(/^\s+- (.+)$/);
      if (item) stages.push(item[1].trim().replace(/^'|'$/g, ""));
    }
  }
  return stages;
}

/**
 * Extract job names and their stage values from serialized YAML.
 */
export function extractJobs(yaml: string): Map<string, ParsedJob> {
  const jobs = new Map<string, ParsedJob>();

  // Split into sections by double newlines
  const sections = yaml.split("\n\n");
  for (const section of sections) {
    const lines = section.split("\n");
    if (lines.length === 0) continue;

    // Top-level key (including dot-prefixed hidden jobs like .deploy-template)
    const topMatch = lines[0].match(/^(\.?[a-z][a-z0-9_.-]*):/);
    if (!topMatch) continue;

    const name = topMatch[1];
    // Skip reserved keys
    if (["stages", "default", "workflow", "variables", "include"].includes(name)) continue;

    const job: ParsedJob = { name };

    // Find stage, needs, extends within the section
    let inNeeds = false;
    for (const line of lines) {
      const stageMatch = line.match(/^\s+stage:\s+(.+)$/);
      if (stageMatch) {
        job.stage = stageMatch[1].trim().replace(/^'|'$/g, "");
      }

      // extends: .template or extends: [.a, .b]
      const extendsMatch = line.match(/^\s+extends:\s+(.+)$/);
      if (extendsMatch) {
        const val = extendsMatch[1].trim();
        if (val.startsWith("[")) {
          // Inline array: [.a, .b]
          job.extends = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
        } else {
          job.extends = [val.replace(/^'|'$/g, "")];
        }
      }

      // needs: block (list form)
      if (line.match(/^\s+needs:$/)) {
        inNeeds = true;
        job.needs = [];
        continue;
      }

      if (inNeeds) {
        // - job-name (simple string form)
        const simpleNeed = line.match(/^\s+- ([a-z][a-z0-9_.-]*)$/);
        if (simpleNeed) {
          job.needs!.push(simpleNeed[1]);
          continue;
        }
        // - 'job-name' (quoted string form)
        const quotedNeed = line.match(/^\s+- '([^']+)'$/);
        if (quotedNeed) {
          job.needs!.push(quotedNeed[1]);
          continue;
        }
        // - job: job-name (object form)
        const objectNeed = line.match(/^\s+- job:\s+(.+)$/);
        if (objectNeed) {
          job.needs!.push(objectNeed[1].trim().replace(/^'|'$/g, ""));
          continue;
        }
        // End of needs block when we hit a non-indented-list line
        if (!line.match(/^\s+\s/) || line.match(/^\s+[a-z_]+:/)) {
          inNeeds = false;
        }
      }

      // needs: [a, b] (inline array form)
      const inlineNeeds = line.match(/^\s+needs:\s+\[(.+)\]$/);
      if (inlineNeeds) {
        job.needs = inlineNeeds[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
      }
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
 * Extract global variables from serialized YAML.
 */
export function extractGlobalVariables(yaml: string): Map<string, string> {
  const vars = new Map<string, string>();
  const match = yaml.match(/^variables:\n((?:\s+.+\n?)+)/m);
  if (!match) return vars;

  for (const line of match[1].split("\n")) {
    const kv = line.match(/^\s+(\w+):\s+(.+)$/);
    if (kv) {
      vars.set(kv[1], kv[2].trim().replace(/^['"]|['"]$/g, ""));
    }
  }
  return vars;
}

/**
 * Extract the full section text for a given job name.
 */
export function extractJobSection(yaml: string, jobName: string): string | null {
  const sections = yaml.split("\n\n");
  for (const section of sections) {
    const lines = section.split("\n");
    if (lines.length > 0 && lines[0].startsWith(`${jobName}:`)) {
      return section;
    }
  }
  return null;
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
  for (const section of yaml.split("\n\n")) {
    const lines = section.split("\n");
    const top = lines[0]?.match(/^(\.?[a-z][a-z0-9_.-]*):/i);
    const job = top ? top[1] : "default";

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
  const section = yaml.split("\n\n").find((s) => /^include:/.test(s));
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
  for (const section of yaml.split("\n\n")) {
    const lines = section.split("\n");
    const top = lines[0]?.match(/^(\.?[a-z][a-z0-9_.-]*):/i);
    if (!top) continue;
    const job = top[1];

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
  for (const section of yaml.split("\n\n")) {
    const lines = section.split("\n");
    const top = lines[0]?.match(/^(\.?[a-z][a-z0-9_.-]*):/i);
    if (!top) continue;
    const job = top[1];

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
