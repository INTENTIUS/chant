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
import { ops016 } from "./ops016-gate-resume";
import { ops017Check } from "./ops017-gate-alias";
import { ops018 } from "./ops018-shell-image-digest";
import { sys010Check } from "./sys010-key-over-plain-http";
import type { DecideBackend } from "../../../op/decide-config";

export { ops012 } from "./ops012-activity-contract";
export { ops013 } from "./ops013-step-output-ref";
export { ops014 } from "./ops014-converge-rule-refusals";
export { ops015 } from "./ops015-gate-approval";
export { ops016 } from "./ops016-gate-resume";
export { ops017, ops017Check, workspaceIdentityGates } from "./ops017-gate-alias";
export { ops018 } from "./ops018-shell-image-digest";
export { sys010, sys010Check } from "./sys010-key-over-plain-http";
// OPS019 (#2554) reads across members, so it is a cross-root check that only `chant workspace run` runs.
export { ops019Check, parseWorkspaceOpTarget, formatWorkspaceOpTarget, OPS019_ID, type WorkspaceOpTarget } from "./ops019-workspace-op-target";

export interface CoreOpCheckOptions {
  /** `decide.backends` from the project's chant.config, for SYS010 (#2828). */
  decideBackends?: Record<string, Pick<DecideBackend, "url" | "key">>;
  /** The workspace's `identity.gates`, gate to class, for OPS017 (#3949): `workspaceIdentityGates`' answer. */
  identityGates?: ReadonlyMap<string, string | null>;
}

/**
 * Core's own post-synth checks over the Op model: OPS012, OPS013, OPS014,
 * OPS015, OPS016, OPS017 over the workspace's `identity.gates`, OPS018, and SYS010
 * over the `decide` steps and the configured decide backends.
 */
export function coreOpChecks(opts: CoreOpCheckOptions = {}): PostSynthCheck[] {
  return [ops012, ops013, ops014, ops015, ops016, ops017Check(opts.identityGates), ops018, sys010Check(opts.decideBackends)];
}
