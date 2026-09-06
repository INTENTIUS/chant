/**
 * OPS* Op-model post-synth checks (#2122, epic #2114 sub-issue 6) — ported
 * from a hosting lexicon's own TMP012/TMP013/TMP014. Registered as core-owned
 * post-synth checks (`coreOpChecks`, mirroring `../../receipt-checks.ts`'s
 * `coreReceiptChecks`) so they run over the FULL build result regardless of
 * which lexicons are configured — an Op is recognized by entity type
 * (`../../../op/resource.ts`'s `OpResource`), not by which lexicon declared
 * it.
 */

import type { PostSynthCheck } from "../../post-synth";
import { ops012 } from "./ops012-activity-contract";
import { ops013 } from "./ops013-step-output-ref";
import { ops014 } from "./ops014-converge-rule-refusals";

export { ops012 } from "./ops012-activity-contract";
export { ops013 } from "./ops013-step-output-ref";
export { ops014 } from "./ops014-converge-rule-refusals";

/** Core's own post-synth checks over the Op model — OPS012, OPS013, OPS014. */
export function coreOpChecks(): PostSynthCheck[] {
  return [ops012, ops013, ops014];
}
