/**
 * The seam between neutral agent-config discovery and a lexicon's vocabulary.
 *
 * `discover.ts` deliberately knows nothing about chant resources — it reads
 * five harnesses' config dialects and stops. Turning an {@link AgentConfigSite}
 * into resources is a statement about a *target* (fountain's `Agent` and
 * `Environment`, today), and that judgement belongs to the lexicon that owns
 * those types, exactly as `templateParser()` puts CloudFormation's JSON
 * vocabulary in the aws lexicon rather than in core.
 *
 * So a lexicon that can express local agent configuration implements
 * {@link AgentConfigImporter} and returns it from
 * `LexiconPlugin.agentConfigImporter()`. `chant import --agents` loads the
 * plugin, hands it the scan, and pipes the resulting IR through the same
 * `templateGenerator()` every other import path uses.
 */

import type { TemplateIR } from "../import/parser";
import type { AgentConfigSite } from "./types";

/** A site the importer could not express, and why. */
export interface SkippedSite {
  siteId: string;
  reason: string;
}

/**
 * The result of re-expressing a scan.
 *
 * The three report arrays exist because this conversion is lossy in ways the
 * user must be told about: a site that couldn't be mapped, a required property
 * that had to be defaulted, and a secret that was rewritten rather than copied
 * are all things a reader would otherwise discover only by diffing the output
 * against their own config.
 */
export interface AgentImportOutcome {
  ir: TemplateIR;
  /** Sites that could not be re-expressed in this lexicon's vocabulary. */
  skipped: SkippedSite[];
  /** Site ids where a required property was filled with a default rather than a discovered value. */
  unmappedModel: string[];
  /** Site ids where a literal credential was replaced with an environment reference. */
  redactedSecrets: string[];
}

/** Converts discovered agent configuration into a lexicon's resource IR. */
export interface AgentConfigImporter {
  toTemplateIR(sites: AgentConfigSite[]): AgentImportOutcome;
}
