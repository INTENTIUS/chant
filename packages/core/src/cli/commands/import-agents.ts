/**
 * `chant import --agents` — re-express this machine's agent configuration as
 * chant code.
 *
 * Shares its front half with `chant audit --agents` (the same scan, the same
 * normalized sites) and its back half with every other import path (a lexicon's
 * `templateGenerator()` turning IR into TypeScript). The only new step is the
 * middle: `LexiconPlugin.agentConfigImporter()`, which maps sites onto the
 * lexicon's own resource types.
 *
 * The command is loud about what it changed. Re-expression here is lossy in
 * three specific ways — a skipped runtime, a defaulted model, a redacted
 * secret — and each one is something the user would otherwise find only by
 * diffing the generated code against their real config. Printing them is not
 * politeness; it is the difference between generated code you can trust and
 * generated code you have to re-verify by hand.
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { scanAgentConfigs } from "../../agents/discover";
import type { AgentRuntime, AgentScope } from "../../agents/types";
import type { AgentImportOutcome } from "../../agents/importer";
import type { LexiconPlugin } from "../../lexicon";
import { loadPlugin } from "../plugins";

/** The lexicon used when `--lexicon` isn't given: the one that models agent workloads. */
export const DEFAULT_AGENT_LEXICON = "fountain";

/**
 * Loads the lexicon plugin. Injectable so this command can be unit-tested
 * without a built lexicon package on disk — the same seam `audit.ts` uses for
 * its `ChecksProvider`.
 */
export type PluginLoader = (name: string) => Promise<LexiconPlugin>;

export interface ImportAgentsOptions {
  /** Lexicon to re-express into. Defaults to {@link DEFAULT_AGENT_LEXICON}. */
  lexicon?: string;
  /** Injectable plugin loader (testing). Defaults to the real one. */
  pluginLoader?: PluginLoader;
  /** Output directory. Defaults to `./infra/agents`. */
  output?: string;
  force?: boolean;
  scopes?: readonly AgentScope[];
  runtimes?: readonly AgentRuntime[];
  projectRoots?: string[];
  home?: string;
  platform?: NodeJS.Platform;
}

export interface ImportAgentsResult {
  success: boolean;
  generatedFiles: string[];
  /** Sites found, mapped, and deliberately not mapped. */
  summary: { discovered: number; mapped: number };
  outcome?: AgentImportOutcome;
  warnings: string[];
  error?: string;
}

/**
 * Scan, re-express, and write.
 *
 * Refuses to overwrite existing files without `--force`, matching `chant
 * import` — generated agent code is likely to be edited by hand after the
 * first run, and silently reverting those edits would be the worst possible
 * behavior for a command whose whole purpose is capturing hand-tuned config.
 */
export async function importAgentsCommand(opts: ImportAgentsOptions = {}): Promise<ImportAgentsResult> {
  const lexiconName = opts.lexicon ?? DEFAULT_AGENT_LEXICON;
  const outputDir = resolve(opts.output ?? join("infra", "agents"));
  const warnings: string[] = [];

  const scan = scanAgentConfigs({
    scopes: opts.scopes,
    runtimes: opts.runtimes,
    projectRoots: opts.projectRoots,
    home: opts.home ?? homedir(),
    platform: opts.platform,
  });

  if (scan.sites.length === 0) {
    return {
      success: false,
      generatedFiles: [],
      summary: { discovered: 0, mapped: 0 },
      warnings,
      error: "No agent configuration found to import.",
    };
  }

  let plugin: LexiconPlugin;
  try {
    plugin = await (opts.pluginLoader ?? loadPlugin)(lexiconName);
  } catch (err) {
    return {
      success: false,
      generatedFiles: [],
      summary: { discovered: scan.sites.length, mapped: 0 },
      warnings,
      error:
        `Could not load the ${lexiconName} lexicon: ${err instanceof Error ? err.message : String(err)}\n` +
        `Install it with: npm i @intentius/chant-lexicon-${lexiconName}`,
    };
  }

  const importer = plugin.agentConfigImporter?.();
  if (!importer) {
    return {
      success: false,
      generatedFiles: [],
      summary: { discovered: scan.sites.length, mapped: 0 },
      warnings,
      error: `The ${lexiconName} lexicon cannot express agent configuration (no agentConfigImporter). Try --lexicon ${DEFAULT_AGENT_LEXICON}.`,
    };
  }

  const generator = plugin.templateGenerator?.();
  if (!generator) {
    return {
      success: false,
      generatedFiles: [],
      summary: { discovered: scan.sites.length, mapped: 0 },
      warnings,
      error: `The ${lexiconName} lexicon has no templateGenerator, so it cannot emit TypeScript.`,
    };
  }

  const outcome = importer.toTemplateIR(scan.sites);

  for (const skip of outcome.skipped) warnings.push(`Skipped ${skip.siteId}: ${skip.reason}`);
  if (outcome.unmappedModel.length > 0) {
    warnings.push(
      `No model was pinned in the local config for ${outcome.unmappedModel.join(", ")}; a default was written. Edit it before applying.`,
    );
  }
  if (outcome.redactedSecrets.length > 0) {
    warnings.push(
      `Literal credentials in ${outcome.redactedSecrets.join(", ")} were replaced with \`\${VAR}\` references — the values were NOT copied into the generated code. Supply them via a Vault or the environment.`,
    );
  }

  if (outcome.ir.resources.length === 0) {
    return {
      success: false,
      generatedFiles: [],
      summary: { discovered: scan.sites.length, mapped: 0 },
      outcome,
      warnings,
      error: `Found ${scan.sites.length} agent config(s), but none could be expressed as ${lexiconName} resources.`,
    };
  }

  const files = generator.generate(outcome.ir);

  const existing = files.map((f) => join(outputDir, f.path)).filter((p) => existsSync(p));
  if (existing.length > 0 && !opts.force) {
    return {
      success: false,
      generatedFiles: [],
      summary: { discovered: scan.sites.length, mapped: outcome.ir.resources.length },
      outcome,
      warnings,
      error: `Refusing to overwrite ${existing.join(", ")}. Re-run with --force to replace.`,
    };
  }

  const generatedFiles: string[] = [];
  try {
    mkdirSync(outputDir, { recursive: true });
    for (const file of files) {
      const full = join(outputDir, file.path);
      writeFileSync(full, file.content, "utf-8");
      generatedFiles.push(full);
    }
  } catch (err) {
    return {
      success: false,
      generatedFiles,
      summary: { discovered: scan.sites.length, mapped: outcome.ir.resources.length },
      outcome,
      warnings,
      error: `Failed to write generated files: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    success: true,
    generatedFiles,
    summary: { discovered: scan.sites.length, mapped: outcome.ir.resources.length },
    outcome,
    warnings,
  };
}
