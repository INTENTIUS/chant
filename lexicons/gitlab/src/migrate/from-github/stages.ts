/**
 * Stage inference for GitHub jobs → GitLab stages.
 *
 * GitHub Actions has no `stages:` concept; jobs only declare optional
 * `needs:` edges. GitLab CI requires every job to belong to a stage.
 *
 * Approach (Kahn topological sort on the `needs:` DAG):
 *   1. Build adjacency from `needs:` (jobs without `needs:` are depth 0).
 *   2. Peel zero-indegree nodes; assign stage by depth + name heuristic.
 *   3. Map depths to stage names:
 *      depth 0 → "lint" / "build" (by name heuristic, default "build")
 *      depth 1 → "test"
 *      depth 2 → "deploy"
 *      depth N>2 → `post-${N-2}`
 *   4. If a cycle is detected, place each remaining job in its own stage
 *      and append a needs-review record so the user notices.
 */

import type { ProvenanceRecord } from "./provenance";

export interface GhJobSummary {
  logicalId: string;
  needs: string[];
  /** Original GH job key (kebab-case) for name heuristics */
  originalName: string;
}

export interface StageInferenceResult {
  /** Map from job logicalId to assigned stage name */
  stageByJob: Map<string, string>;
  /** Ordered list of distinct stages, declaration-order */
  stages: string[];
  /** Any provenance records (cycles, synthesis events) */
  provenance: ProvenanceRecord[];
}

const NAME_HEURISTIC_PATTERNS: Array<{ pattern: RegExp; stage: string }> = [
  { pattern: /^(lint|check|fmt|format|style|typecheck|tsc)/i, stage: "lint" },
  { pattern: /^(build|compile|bundle|pack)/i, stage: "build" },
  { pattern: /^(test|spec|e2e|integration|unit)/i, stage: "test" },
  { pattern: /^(deploy|publish|release|push)/i, stage: "deploy" },
];

function heuristicStage(name: string, fallback: string): string {
  for (const { pattern, stage } of NAME_HEURISTIC_PATTERNS) {
    if (pattern.test(name)) return stage;
  }
  return fallback;
}

function defaultStageForDepth(depth: number): string {
  if (depth === 0) return "build";
  if (depth === 1) return "test";
  if (depth === 2) return "deploy";
  return `post-${depth - 2}`;
}

export function inferStages(jobs: GhJobSummary[]): StageInferenceResult {
  const provenance: ProvenanceRecord[] = [];
  const stageByJob = new Map<string, string>();
  const jobsById = new Map(jobs.map((j) => [j.logicalId, j]));

  // Compute indegree based on needs that resolve to known jobs
  const indegree = new Map<string, number>();
  for (const job of jobs) {
    indegree.set(job.logicalId, 0);
  }
  for (const job of jobs) {
    for (const dep of job.needs) {
      if (jobsById.has(dep)) {
        indegree.set(job.logicalId, (indegree.get(job.logicalId) ?? 0) + 1);
      }
    }
  }

  // Kahn's algorithm, recording depth per node
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const job of jobs) {
    if ((indegree.get(job.logicalId) ?? 0) === 0) {
      queue.push(job.logicalId);
      depth.set(job.logicalId, 0);
    }
  }

  const processed = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    processed.add(current);
    const currentDepth = depth.get(current) ?? 0;
    for (const next of jobs) {
      if (next.needs.includes(current)) {
        const remaining = (indegree.get(next.logicalId) ?? 0) - 1;
        indegree.set(next.logicalId, remaining);
        const proposed = currentDepth + 1;
        const existing = depth.get(next.logicalId);
        if (existing === undefined || proposed > existing) {
          depth.set(next.logicalId, proposed);
        }
        if (remaining === 0) {
          queue.push(next.logicalId);
        }
      }
    }
  }

  // Detect cycles — any job not processed is on a cycle
  const cycleJobs = jobs.filter((j) => !processed.has(j.logicalId));
  for (const job of cycleJobs) {
    provenance.push({
      gitlabPath: `jobs.${job.logicalId}.stage`,
      gitlabLogicalId: job.logicalId,
      sourceKey: `jobs.${job.originalName}.needs`,
      category: "needs-review",
      rule: "MIG-NEEDS-CYCLE-001",
      note: `Job "${job.originalName}" is part of a needs: cycle; assigned its own stage`,
    });
  }

  // Assign stages
  for (const job of jobs) {
    if (cycleJobs.includes(job)) {
      stageByJob.set(job.logicalId, `cycle-${job.logicalId}`);
      continue;
    }
    const d = depth.get(job.logicalId) ?? 0;
    const defaultStage = defaultStageForDepth(d);
    const stage = d === 0
      ? heuristicStage(job.originalName, defaultStage)
      : d === 1
        ? heuristicStage(job.originalName, defaultStage)
        : defaultStage;
    stageByJob.set(job.logicalId, stage);
    if (stage !== defaultStage) {
      provenance.push({
        gitlabPath: `jobs.${job.logicalId}.stage`,
        gitlabLogicalId: job.logicalId,
        sourceKey: `jobs.${job.originalName}`,
        category: "synthesis",
        rule: "MIG-STAGE-HEURISTIC",
        note: `Stage "${stage}" inferred from job name "${job.originalName}"`,
      });
    } else {
      provenance.push({
        gitlabPath: `jobs.${job.logicalId}.stage`,
        gitlabLogicalId: job.logicalId,
        sourceKey: `jobs.${job.originalName}`,
        category: "synthesis",
        rule: "MIG-STAGE-TOPO",
        note: `Stage "${stage}" assigned from needs: depth ${d}`,
      });
    }
  }

  // Collect distinct stages, ordered by appearance
  const stagesSet = new Set<string>();
  const stagesOrdered: string[] = [];
  for (const job of jobs) {
    const s = stageByJob.get(job.logicalId);
    if (s && !stagesSet.has(s)) {
      stagesSet.add(s);
      stagesOrdered.push(s);
    }
  }
  // Sort by canonical depth order: lint, build, test, deploy, post-N, cycle-*
  const canonicalOrder = ["lint", "build", "test", "deploy"];
  stagesOrdered.sort((a, b) => {
    const ai = canonicalOrder.indexOf(a);
    const bi = canonicalOrder.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  return { stageByJob, stages: stagesOrdered, provenance };
}
