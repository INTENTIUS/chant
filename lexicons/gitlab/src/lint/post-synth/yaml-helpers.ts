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
