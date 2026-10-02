/**
 * OPS* Op-model post-synth checks (#2122, epic #2114 sub-issue 6) — ported
 * from a hosting lexicon's own TMP012/TMP013/TMP014. Registered as core-owned
 * post-synth checks (`coreOpChecks`, mirroring `../../receipt-checks.ts`'s
 * `coreReceiptChecks`) so they run over the FULL build result regardless of
 * which lexicons are configured — an Op is recognized by entity type
 * (`../../../op/resource.ts`'s `OpResource`), not by which lexicon declared
 * it. SYS010 (#2828) joined them when the `decide` activity moved into core:
 * it reads the decide steps, and the `decide.backends` the caller passes.
 */

import type { PostSynthCheck } from "../../post-synth";
import { ops012 } from "./ops012-activity-contract";
import { ops013 } from "./ops013-step-output-ref";
import { ops014 } from "./ops014-converge-rule-refusals";
import { ops015 } from "./ops015-gate-approval";
import { sys010Check } from "./sys010-key-over-plain-http";
import type { DecideBackend } from "../../../op/decide-config";

export { ops012 } from "./ops012-activity-contract";
export { ops013 } from "./ops013-step-output-ref";
export { ops014 } from "./ops014-converge-rule-refusals";
export { ops015 } from "./ops015-gate-approval";
export { sys010, sys010Check } from "./sys010-key-over-plain-http";

export interface CoreOpCheckOptions {
  /** `decide.backends` from the project's chant.config, for SYS010 (#2828). */
  decideBackends?: Record<string, Pick<DecideBackend, "url" | "key">>;
}

/**
 * Core's own post-synth checks over the Op model: OPS012, OPS013, OPS014,
 * OPS015, and SYS010 over the `decide` steps and the configured decide
 * backends.
 */
export function coreOpChecks(opts: CoreOpCheckOptions = {}): PostSynthCheck[] {
  return [ops012, ops013, ops014, ops015, sys010Check(opts.decideBackends)];
}
