/**
 * Generic lexicon packaging pipeline.
 *
 * Orchestrates: generate → manifest → collect rules → collect skills →
 * assemble BundleSpec → compute integrity → attach metadata.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { BundleSpec, LexiconManifest } from "../lexicon";
import { computeIntegrity } from "../lexicon-integrity";
import type { GenerateResult } from "./generate";

// ── Types ──────────────────────────────────────────────────────────

export interface PackageOptions {
  verbose?: boolean;
  force?: boolean;
}

export interface PackageResult {
  spec: BundleSpec;
  stats: {
    resources: number;
    properties: number;
    enums: number;
    ruleCount: number;
    skillCount: number;
  };
}

export interface PackagePipelineConfig {
  /** Run generation and return artifacts. */
  generate: (opts: { verbose?: boolean; force?: boolean }) => Promise<GenerateResult>;
  /** Build the lexicon manifest from the generate result. */
  buildManifest: (genResult: GenerateResult) => LexiconManifest;
  /** Source directory for collecting rules. */
  srcDir: string;
  /** Rule directories relative to srcDir (default: ["lint/rules", "lint/post-synth"]). */
  ruleDirs?: string[];
  /** Collect skill definitions. Returns map of filename → content. */
  collectSkills: () => Map<string, string>;
  /** Package version for metadata. */
  version?: string;
}

// ── Pipeline ───────────────────────────────────────────────────────

/**
 * Run the packaging pipeline with the supplied config.
 */
export async function packagePipeline(
  config: PackagePipelineConfig,
  opts: PackageOptions = {},
): Promise<PackageResult> {
  const log = opts.verbose
    ? (msg: string) => console.error(msg)
    : (_msg: string) => {};

  // Step 1: Run the generation pipeline
  log("Running generation pipeline...");
  const result = await config.generate({ verbose: opts.verbose, force: opts.force });

  // Step 2: Build manifest
  log("Building manifest...");
  const manifest = config.buildManifest(result);

  // Step 3: Collect rules
  log("Collecting rules...");
  const rules = collectRules(config.srcDir, config.ruleDirs);

  // Step 4: Collect skills
  log("Collecting skills...");
  const skills = config.collectSkills();

  // Step 5: Assemble BundleSpec
  const spec: BundleSpec = {
    manifest,
    registry: result.lexiconJSON,
    typesDTS: result.typesDTS,
    rules,
    skills,
  };

  // Step 6: Compute integrity
  log("Computing integrity...");
  spec.integrity = computeIntegrity(spec);

  // Step 7: Populate metadata
  spec.metadata = {
    generatedAt: new Date().toISOString(),
    chantVersion: "0.1.0",
    generatorVersion: config.version ?? "0.0.0",
    sourceSchemaCount: result.resources,
  };

  log(`Package assembled: ${rules.size} rules, ${skills.size} skills`);

  return {
    spec,
    stats: {
      resources: result.resources,
      properties: result.properties,
      enums: result.enums,
      ruleCount: rules.size,
      skillCount: skills.size,
    },
  };
}

// ── Utilities ──────────────────────────────────────────────────────

/**
 * Collect lint rule source files from a lexicon package.
 * Auto-discovers .ts files in the specified directories,
 * skipping test files, barrel files (index.ts), and non-.ts files.
 */
export function collectRules(
  srcDir: string,
  dirs: string[] = ["lint/rules", "lint/post-synth"],
): Map<string, string> {
  const rules = new Map<string, string>();

  for (const dir of dirs) {
    const fullDir = join(srcDir, dir);
    let entries: string[];
    try {
      entries = readdirSync(fullDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".ts")) continue;
      if (entry.endsWith(".test.ts")) continue;
      if (entry === "index.ts") continue;

      try {
        const content = readFileSync(join(fullDir, entry), "utf-8");
        rules.set(entry, content);
      } catch {
        // Skip unreadable files
      }
    }
  }

  return rules;
}

/**
 * Collect skills from a plugin's skill definitions.
 */
export function collectSkills(
  skillDefs: Array<{ name: string; content: string }>,
): Map<string, string> {
  const skills = new Map<string, string>();
  for (const s of skillDefs) {
    skills.set(`${s.name}.md`, s.content);
  }
  return skills;
}
