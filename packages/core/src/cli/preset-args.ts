/**
 * `--preset` and `--baseline` for `chant audit` and `chant lint` (#5118): the
 * named rule set, and the identities of the findings the base already had.
 */

import { readFileSync } from "fs";
import { readBaselineIdentities, resolveRulePreset, rulePresetNames, type RulePreset } from "../audit/pull-request-preset";

export interface PresetArgs {
  preset?: RulePreset;
  baseline?: Set<string>;
}

/** Resolve the two flags, or an Error to print. `--baseline` without `--preset` is refused. */
export function resolvePresetArgs(args: { preset?: string; baseline?: string }): PresetArgs | Error {
  if (args.baseline !== undefined && args.preset === undefined) {
    return new Error("--baseline compares findings under a preset; add --preset pull-request");
  }
  if (args.preset === undefined) return {};
  const preset = resolveRulePreset(args.preset);
  if (!preset) return new Error(`Unknown --preset: ${args.preset}. Expected one of ${rulePresetNames().join(", ")}.`);
  if (args.baseline === undefined) return { preset };
  let text: string;
  try {
    text = readFileSync(args.baseline, "utf-8");
  } catch (err) {
    return new Error(`Failed to read --baseline ${args.baseline}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return { preset, baseline: readBaselineIdentities(text) };
  } catch (err) {
    return new Error(`--baseline ${args.baseline}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
