/**
 * TF047: a live root pins a registry module version the known-module catalog
 * has no row for, or one whose row carries refusals.
 *
 * The catalog is choudoufu's module compatibility table, vendored in
 * `../../module-catalog/` (chant#4560, choudoufu#2292). It has one static
 * row per terraform-aws-modules example at one tag, measured offline in the
 * onboarded form. A module call on a root whose binary is choudoufu (the
 * root's `mode` is `live`) with an exact `version` is looked up there:
 *
 * - no row for the module, or none at the pinned version: `info`, naming the
 *   versions the static tier did measure;
 * - at least one example at that version refused: `warning`, with each
 *   refusal ID, its site count, the examples that carry it and its
 *   `live/LIMITATIONS.md` link;
 * - every example clear: quiet.
 *
 * Every message names the tier. The catalog holds the static tier only, and
 * no figure here counts a gauntlet run (choudoufu#2292 ruling: two tiers,
 * never mixed).
 *
 * A stock root (`mode: "state"`) is skipped: the table measures choudoufu.
 * A range is TF039's finding and a missing `version` TF004's, so both are
 * skipped here. A `//subdir` source is looked up by its module repository.
 *
 * Off by default: `report-only` in the audit catalog, as TF039 is.
 * terragucci turns it on and holds the product wording (terragucci#1286).
 *
 * Scope: root and child modules of a live root alike.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { MODULE_TYPE, type BlockBody } from "../../hcl/parse";
import { classifyModuleSource, isExactVersionConstraint } from "./module-source";
import {
  MODULE_CATALOG_SOURCE,
  MODULE_COMPATIBILITY_PAGE,
  moduleCompatibility,
  type ModuleCompatibility,
} from "../../module-catalog";

const tierNote = (): string =>
  `static tier of choudoufu's module table, measured ${MODULE_CATALOG_SOURCE.date} with hashicorp/aws ${MODULE_CATALOG_SOURCE.awsProvider}`;

/** The TF047 message for one module call, or undefined when the call is clear. */
export function catalogMessage(address: string, c: ModuleCompatibility): string | undefined {
  const pin = `${c.module} ${c.version}`;
  switch (c.status) {
    case "clear":
      return undefined;
    case "unknown-module":
      return (
        `Module "${address}" pins ${pin}, and the ${tierNote()} has no row for this module. ` +
        `Run \`choudoufu live-check\` on the root to see whether it plans. The table: ${MODULE_COMPATIBILITY_PAGE}`
      );
    case "unknown-version":
      return (
        `Module "${address}" pins ${pin}, and the ${tierNote()} has no row at this version. ` +
        `It measured ${c.measuredVersions.join(", ")}. ` +
        `Run \`choudoufu live-check\` on the root, or pin a measured version. The table: ${MODULE_COMPATIBILITY_PAGE}`
      );
    case "refused": {
      const ids = c.refusals
        .map((r) => `${r.id} (${r.sites} site${r.sites === 1 ? "" : "s"} in ${r.examples.join(", ")}; ${r.docsUrl})`)
        .join("; ");
      return (
        `Module "${address}" pins ${pin}. In the ${tierNote()}, ${c.refusedExamples} of ${c.examples} ` +
        `examples at this version are refused: ${ids}. ` +
        "A call that uses the same features is refused the same way; `choudoufu live-check` names each site in this root."
      );
    }
  }
}

export const tf047: PostSynthCheck = {
  id: "TF047",
  description: "Live root pins a module version the known-module catalog has no row for, or one with refusals",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [key, entity] of ctx.entities) {
      if (entity.entityType !== MODULE_TYPE || !isResourceDeclarable(entity)) continue;
      const props = entity.props as { address?: unknown; body?: unknown; mode?: unknown };
      if (props.mode !== "live") continue;
      const body = (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;
      const source = typeof body.source === "string" ? body.source : undefined;
      if (source === undefined || classifyModuleSource(source).kind !== "registry") continue;
      const version = body.version;
      if (typeof version !== "string" || !isExactVersionConstraint(version)) continue;

      const compat = moduleCompatibility(source, version);
      if (compat === undefined) continue;
      const address = typeof props.address === "string" ? props.address : key;
      const message = catalogMessage(address, compat);
      if (message === undefined) continue;

      diagnostics.push({
        checkId: "TF047",
        severity: compat.status === "refused" ? "warning" : "info",
        message,
        entity: key,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
