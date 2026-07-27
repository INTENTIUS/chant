/**
 * Build-time parameters — the runtime binding source references (chant #1064,
 * follow-up to epic #1019's fold work).
 *
 * This is deliberately NOT `Parameter` (`lexicons/aws/src/parameter.ts`), which
 * is a deploy-time CloudFormation parameter: it emits a `Parameters:` block and
 * resolves when the STACK deploys. A build-time parameter resolves before the
 * template is even synthesized — its value can change WHICH resources are
 * produced at all (loomster's `LOOM_TIER` selecting `light` vs `production` vs
 * `production-ha`), which a deploy-time `Parameter` structurally cannot do.
 *
 * Project source never reads `process.env` directly to vary a build — that
 * reads ambient state at module-evaluation time, which `fold()` correctly
 * cannot reduce to a value (see ../fold/fold.ts). Instead it imports this
 * module's `params` object:
 *
 * ```ts
 * import { params } from "@intentius/chant/params";
 * export const tier = params.tier as Tier;
 * ```
 *
 * `params` is declared, validated (type + optional `enum`), and resolved by
 * the CLI BEFORE discovery ever touches a project file (../build-params.ts's
 * `resolveBuildParams`, driven by `chant build --param`/`--params-file`/a
 * declared `env` mapping/`chant.config.ts`'s `buildParams` defaults). Two
 * consumers read the resolved values, and both see the identical object:
 *
 *  - The FOLD path (../discovery/fold-import.ts's `buildExternals`) recognizes
 *    a named `params` import resolving to *this* module and substitutes the
 *    already-resolved values directly, with zero import performed — so
 *    `params.tier` folds to a LITERAL, not a symbolic node. This is the entire
 *    point: the value is known at build invocation, so there is nothing left
 *    to defer.
 *  - The RUN path (a run-fallback file that imports this module for real)
 *    gets the exact same values, because `setBuildParams` below is called
 *    once, in-process, before ANY project file is imported or folded —
 *    mutating this shared object in place rather than replacing the binding,
 *    so a live-imported reference always observes the current build's values.
 */

import type { BuildParamValue } from "./build-params";

export type { BuildParamValue };

/**
 * The current build's resolved parameter values, keyed by declared name.
 * Empty until a build populates it via {@link setBuildParams}. Mutated IN
 * PLACE (never reassigned) so a real `import { params }` in a run-fallback
 * file — which captures this exact object reference at import time — always
 * observes whatever the current build resolved, even though the import
 * happens after this module was first loaded.
 */
export const params: Record<string, BuildParamValue> = {};

/**
 * Replace the shared {@link params} object's contents in place. Called once
 * per build (../discovery/index.ts's `discover()`), before any project file
 * is imported or folded, with the CLI/config-resolved values
 * (../build-params.ts's `resolveBuildParams`). Never called from project
 * source — this is chant's own build-invocation plumbing, not a public
 * authoring API.
 */
export function setBuildParams(values: Readonly<Record<string, BuildParamValue>>): void {
  for (const key of Object.keys(params)) delete params[key];
  Object.assign(params, values);
}
