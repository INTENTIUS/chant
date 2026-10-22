/**
 * The capability table on docs/src/content/docs/components/plan-previews.mdx
 * (chant #4001): every capability kind a capability plugin registers, whether
 * it has `plan` and `outputs`, what its plan reads and what a pull request's
 * plan note shows for it.
 *
 * The rows come from the plugins themselves, so a capability that gains or
 * loses `plan` or `outputs` changes the table. What a plan reads and what the
 * note shows can't be read off the object, so each capability with `plan`
 * needs an entry in {@link PLANNERS}. `scripts/plan-previews.test.ts` fails
 * when a planner has no entry, when an entry names a capability without
 * `plan`, when an entry's source file no longer declares that kind, when a
 * lexicon exports a capability plugin this module does not list, and when
 * the committed block differs from what {@link renderPlanPreviewsBlock}
 * renders. Refresh the block with `npm run generate:plan-previews`.
 */

import type { Capability } from "../packages/core/src/components/capability";
import type { CapabilityPlugin } from "../packages/core/src/components/capability-plugin";
import { starterCapabilityPlugin } from "../packages/core/src/components/starter-plugin";
import { awsCapabilityPlugin } from "../lexicons/aws/src/components/capability-plugin";
import { azureCapabilityPlugin } from "../lexicons/azure/src/components/capability-plugin";
import { flyCapabilityPlugin } from "../lexicons/fly/src/components/capability-plugin";
import { helmCapabilityPlugin } from "../lexicons/helm/src/components/capability-plugin";
import { k8sCapabilityPlugin } from "../lexicons/k8s/src/components/capability-plugin";
import { terraformCapabilityPlugin } from "../lexicons/terraform/src/components/capability-plugin";

/**
 * Every capability plugin in the repository: core's starter set, then each
 * lexicon's, by the name of the export `loadCapabilityPluginFromLexicon`
 * finds in the lexicon's package entry.
 */
export const PLUGINS: ReadonlyArray<{ lexicon: string; exportName: string; plugin: CapabilityPlugin }> = [
  { lexicon: "core", exportName: "starterCapabilityPlugin", plugin: starterCapabilityPlugin },
  { lexicon: "aws", exportName: "awsCapabilityPlugin", plugin: awsCapabilityPlugin },
  { lexicon: "azure", exportName: "azureCapabilityPlugin", plugin: azureCapabilityPlugin },
  { lexicon: "fly", exportName: "flyCapabilityPlugin", plugin: flyCapabilityPlugin },
  { lexicon: "helm", exportName: "helmCapabilityPlugin", plugin: helmCapabilityPlugin },
  { lexicon: "k8s", exportName: "k8sCapabilityPlugin", plugin: k8sCapabilityPlugin },
  { lexicon: "terraform", exportName: "terraformCapabilityPlugin", plugin: terraformCapabilityPlugin },
];

export interface PlannerNote {
  /** The file that declares the capability's `kind` and its `plan`. */
  source: string;
  /** What the plan reads, for the table. */
  reads: string;
  /** What the note shows for one of its members, for the table. */
  shows: string;
  /** The page's section on it. */
  anchor: string;
}

/** One entry per capability with `plan`. */
export const PLANNERS: Record<string, PlannerNote> = {
  "arm-deploy": {
    source: "lexicons/azure/src/components/arm-deploy.ts",
    reads: "each template resource from ARM by its id, compared with the body the apply would PUT",
    shows: "a create, update, no-op or delete per resource, and each changed property path with its value before and after",
    anchor: "arm-deploy",
  },
  "cfn-deploy": {
    source: "lexicons/aws/src/components/apply.ts",
    reads: "a CloudFormation change set for the template and parameters, deleted without executing it",
    shows: "a create, update, replace or delete per logical id, and the names of the properties a change touches, without values",
    anchor: "cfn-deploy",
  },
  "kubectl-apply": {
    source: "lexicons/k8s/src/components/kubectl-apply.ts",
    reads: "a server-side dry run (`dryRun=All`) of the manifest, compared with each live object",
    shows: "a create, update, no-op or delete per object, and each changed field path with its value before and after",
    anchor: "kubectl-apply",
  },
  "terraform-apply": {
    source: "lexicons/terraform/src/components/capability-plugin.ts",
    reads: "`terraform plan` (or tofu or choudoufu) in the root, against its state",
    shows: "every resource change with its action, and each changed top-level attribute with its value before and after",
    anchor: "terraform-apply",
  },
};

export const PLAN_PREVIEWS_START = "{/* BEGIN GENERATED plan-previews */}";
export const PLAN_PREVIEWS_END = "{/* END GENERATED plan-previews */}";
export const PLAN_PREVIEWS_DOC = "docs/src/content/docs/components/plan-previews.mdx";

export interface CapabilityRow {
  kind: string;
  lexicon: string;
  plan: boolean;
  outputs: boolean;
}

/** One row per registered capability, by lexicon (core first) and then kind. */
export function capabilityRows(): CapabilityRow[] {
  const rows: CapabilityRow[] = [];
  for (const { lexicon, plugin } of PLUGINS) {
    const capabilities = plugin.capabilities() as Array<Capability<never, unknown>>;
    for (const c of [...capabilities].sort((a, b) => a.kind.localeCompare(b.kind))) {
      rows.push({ kind: c.kind, lexicon, plan: typeof c.plan === "function", outputs: typeof c.outputs === "function" });
    }
  }
  return rows;
}

const cell = (s: string): string => s.replaceAll("|", "\\|");

/** The generated block, markers included. */
export function renderPlanPreviewsBlock(rows: CapabilityRow[] = capabilityRows()): string {
  const lines = [
    PLAN_PREVIEWS_START,
    "",
    "| Capability | Lexicon | `plan` | `outputs` | The plan reads | The note shows |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const note = PLANNERS[r.kind];
    const reads = r.plan && note ? note.reads : "nothing";
    const shows = r.plan && note ? `${note.shows}. See [${r.kind}](#${note.anchor})` : "no entries for this step. See [without `plan`](#a-capability-without-plan)";
    lines.push(`| \`${r.kind}\` | ${r.lexicon} | ${r.plan ? "yes" : "no"} | ${r.outputs ? "yes" : "no"} | ${cell(reads)} | ${cell(shows)} |`);
  }
  lines.push("", PLAN_PREVIEWS_END);
  return lines.join("\n");
}

/** The committed block in `doc`, markers included. */
export function extractPlanPreviewsBlock(doc: string): string {
  const start = doc.indexOf(PLAN_PREVIEWS_START);
  const end = doc.indexOf(PLAN_PREVIEWS_END);
  if (start < 0 || end < start) {
    throw new Error(`plan-previews markers not found: expected "${PLAN_PREVIEWS_START}" and then "${PLAN_PREVIEWS_END}"`);
  }
  return doc.slice(start, end + PLAN_PREVIEWS_END.length);
}

/** `doc` with its block replaced by a fresh render. */
export function replacePlanPreviewsBlock(doc: string, rows: CapabilityRow[] = capabilityRows()): string {
  return doc.replace(extractPlanPreviewsBlock(doc), renderPlanPreviewsBlock(rows));
}
