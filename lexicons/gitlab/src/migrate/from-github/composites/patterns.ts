/**
 * Pattern recognisers for `chant migrate --use-composites`.
 *
 * Each pattern walks the GitLab IR looking for a recognisable shape
 * (e.g. NodePipeline-shaped 2-job setup) and rewrites the matched
 * resources into a sentinel IR type (`GitLab::Composite::NodePipeline`)
 * that the GitLab generator (`lexicons/gitlab/src/import/generator.ts`)
 * will emit as `NodePipeline({...})` instead of raw `new Job(...)`.
 */

import type { TemplateIR, ResourceIR } from "@intentius/chant/import/parser";
import type { ProvenanceRecord } from "../provenance";

export interface CompositePattern {
  name: string;
  match(ir: TemplateIR): MatchResult | null;
  rewrite(ir: TemplateIR, match: MatchResult): { ir: TemplateIR; provenance: ProvenanceRecord[] };
}

export interface MatchResult {
  /** Resource logicalIds to remove */
  removed: string[];
  /** New composite resource to add */
  added: ResourceIR;
}

function getProp<T>(r: ResourceIR, k: string): T | undefined {
  return r.properties[k] as T | undefined;
}

function looksLikeNodeImage(image: unknown): boolean {
  return typeof image === "string" && /^node:/i.test(image);
}

function detectPackageManager(script: string[]): "npm" | "yarn" | "pnpm" | "bun" {
  const text = script.join("\n");
  if (/\b(bun|bunx)\s+(install|test|run)/.test(text)) return "bun";
  if (/\bpnpm\s+(install|run|test)/.test(text)) return "pnpm";
  if (/\byarn\s+(install|run|test)/.test(text)) return "yarn";
  return "npm";
}

function hasInstallStep(script: string[], pm: "npm" | "yarn" | "pnpm" | "bun"): boolean {
  const installers: Record<string, RegExp> = {
    npm: /\bnpm\s+(ci|install)\b/,
    yarn: /\byarn\s+install\b/,
    pnpm: /\bpnpm\s+install\b/,
    bun: /\bbun\s+install\b/,
  };
  return script.some((line) => installers[pm].test(line));
}

function hasBuildStep(script: string[], pm: "npm" | "yarn" | "pnpm" | "bun"): boolean {
  const re = pm === "npm" ? /\bnpm\s+run\s+build\b/ : new RegExp(`\\b${pm}\\s+(run\\s+)?build\\b`);
  return script.some((line) => re.test(line));
}

function hasTestStep(script: string[], pm: "npm" | "yarn" | "pnpm" | "bun"): boolean {
  const re = pm === "npm"
    ? /\bnpm\s+(test|run\s+test)\b/
    : new RegExp(`\\b${pm}\\s+(run\\s+)?test\\b`);
  return script.some((line) => re.test(line));
}

const nodePipelinePattern: CompositePattern = {
  name: "NodePipeline",
  match(ir: TemplateIR): MatchResult | null {
    const jobs = ir.resources.filter((r) => r.type === "GitLab::CI::Job");
    if (jobs.length !== 2) return null;
    // Find build job + test job
    let buildJob: ResourceIR | undefined;
    let testJob: ResourceIR | undefined;
    for (const j of jobs) {
      const script = (getProp<string[]>(j, "script") ?? []);
      if (!looksLikeNodeImage(getProp(j, "image"))) return null;
      const pm = detectPackageManager(script);
      if (hasBuildStep(script, pm) && hasInstallStep(script, pm)) {
        buildJob = j;
      } else if (hasTestStep(script, pm) && hasInstallStep(script, pm)) {
        testJob = j;
      }
    }
    if (!buildJob || !testJob) return null;
    if (buildJob.logicalId === testJob.logicalId) return null;

    const buildScript = (getProp<string[]>(buildJob, "script") ?? []);
    const pm = detectPackageManager(buildScript);
    const image = getProp<string>(buildJob, "image") ?? "node:22";
    const nodeVersion = image.replace(/^node:/, "") || "22";

    return {
      removed: [buildJob.logicalId, testJob.logicalId],
      added: {
        logicalId: "app",
        type: "GitLab::Composite::NodePipeline",
        properties: {
          nodeVersion,
          packageManager: pm,
        },
      },
    };
  },
  rewrite(ir, match): { ir: TemplateIR; provenance: ProvenanceRecord[] } {
    const keep = ir.resources.filter((r) => !match.removed.includes(r.logicalId));
    return {
      ir: { ...ir, resources: [...keep, match.added] },
      provenance: [
        {
          gitlabPath: `jobs.${match.added.logicalId}`,
          gitlabLogicalId: match.added.logicalId,
          category: "synthesis",
          rule: "MIG-COMPOSITE-NODEPIPELINE",
          note: `Recognised NodePipeline shape (${match.removed.join(", ")}) → NodePipeline composite`,
        },
      ],
    };
  },
};

const nodeCiPattern: CompositePattern = {
  name: "NodeCI",
  match(ir: TemplateIR): MatchResult | null {
    const jobs = ir.resources.filter((r) => r.type === "GitLab::CI::Job");
    if (jobs.length !== 1) return null;
    const j = jobs[0];
    const script = (getProp<string[]>(j, "script") ?? []);
    if (!looksLikeNodeImage(getProp(j, "image"))) return null;
    const pm = detectPackageManager(script);
    if (!hasInstallStep(script, pm)) return null;
    if (!hasBuildStep(script, pm) && !hasTestStep(script, pm)) return null;
    const image = getProp<string>(j, "image") ?? "node:22";
    const nodeVersion = image.replace(/^node:/, "") || "22";

    return {
      removed: [j.logicalId],
      added: {
        logicalId: "app",
        type: "GitLab::Composite::NodeCI",
        properties: {
          nodeVersion,
          packageManager: pm,
        },
      },
    };
  },
  rewrite(ir, match): { ir: TemplateIR; provenance: ProvenanceRecord[] } {
    const keep = ir.resources.filter((r) => !match.removed.includes(r.logicalId));
    return {
      ir: { ...ir, resources: [...keep, match.added] },
      provenance: [
        {
          gitlabPath: `jobs.${match.added.logicalId}`,
          gitlabLogicalId: match.added.logicalId,
          category: "synthesis",
          rule: "MIG-COMPOSITE-NODECI",
          note: `Recognised NodeCI shape (${match.removed.join(", ")}) → NodeCI composite`,
        },
      ],
    };
  },
};

export const PATTERNS: CompositePattern[] = [
  // Match NodePipeline first (2 jobs); NodeCI second (single job)
  nodePipelinePattern,
  nodeCiPattern,
];
