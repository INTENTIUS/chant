/**
 * @intentius/warden-core — shared CLI scaffolding for the chant wardens
 * (#788). Providers keep their cycles, clients, and config types; this
 * package owns the shell every warden had hand-copied: flag parsing, config
 * loading, outcome reporting, exit codes, and the process edge.
 */

export { CliError } from "./cli-error.js";
export { parseFlags, type FlagSpec } from "./flags.js";
export { loadConfigFile, type LoadConfigOptions } from "./config-file.js";
export {
  reportReconcileOutcome,
  selectCycles,
  type OutcomeCycle,
  type ReconcileOutcome,
} from "./outcome.js";
export { errMsg, makeDie, requireEnv, runWhenInvoked, type Die } from "./shell.js";
