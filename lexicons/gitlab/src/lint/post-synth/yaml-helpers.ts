/**
 * Helpers for parsing serialized GitLab CI YAML in post-synth checks.
 *
 * Since GitLab CI output is YAML (not JSON like CloudFormation), we parse
 * the YAML sections structurally using simple regex/string parsing. The
 * serializer emits a predictable format so we can extract what we need
 * without a full YAML parser dependency.
 */

import type { SerializerResult } from "@intentius/chant/serializer";

/**
 * Extract the primary output string from a serializer result.
 */
export function getPrimaryOutput(output: string | SerializerResult): string {
  return typeof output === "string" ? output : output.primary;
}

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

    // Top-level key
    const topMatch = lines[0].match(/^([a-z][a-z0-9_-]*):/);
    if (!topMatch) continue;

    const name = topMatch[1];
    // Skip reserved keys
    if (["stages", "default", "workflow", "variables", "include"].includes(name)) continue;

    const job: ParsedJob = { name };

    // Find stage within the section
    for (const line of lines) {
      const stageMatch = line.match(/^\s+stage:\s+(.+)$/);
      if (stageMatch) {
        job.stage = stageMatch[1].trim().replace(/^'|'$/g, "");
      }
    }

    jobs.set(name, job);
  }

  return jobs;
}
