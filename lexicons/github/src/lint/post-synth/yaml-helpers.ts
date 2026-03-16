/**
 * Helpers for parsing serialized GitHub Actions YAML in post-synth checks.
 */

export { getPrimaryOutput } from "@intentius/chant/lint/post-synth";

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
            uses: usesMatch?.[1]?.trim().replace(/^'|'$/g, ""),
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
