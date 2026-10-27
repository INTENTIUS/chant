/**
 * PUL013: the export's deployment version is not the one chant reads.
 *
 * `pulumi stack export` writes `{ "version": 3, "deployment": ... }`, and
 * every reader in this lexicon (the graph, the change set's prior state, the
 * drift read's URN list) is written and recorded against version 3
 * (`../../testdata/`). An export with another version, or none, may lay its
 * resources out differently, and what chant reads from it is not checked.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { PULUMI_EXPORT_FILE } from "../../workspace-member";
import { finding, memberExport } from "./member-read-helpers";

/** The deployment schema version the readers are written against. */
export const PULUMI_EXPORT_VERSION = 3;

export const pul013: PostSynthCheck = {
  id: "PUL013",
  description: "The pulumi member's stack export has a deployment version other than 3, the one chant reads",

  check(_ctx: PostSynthContext): PostSynthDiagnostic[] {
    const exp = memberExport();
    if (!exp) return [];
    const version = exp.doc.version;
    if (version === PULUMI_EXPORT_VERSION) return [];
    return [
      finding(
        "PUL013",
        "warning",
        `${PULUMI_EXPORT_FILE} has ${version === undefined ? "no version" : `version ${JSON.stringify(version)}`}; ` +
          `chant reads version ${PULUMI_EXPORT_VERSION}, what \`pulumi stack export\` writes, so the graph read from it is unchecked.`,
      ),
    ];
  },
};
