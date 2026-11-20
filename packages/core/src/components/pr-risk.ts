/**
 * The change risk on the pull-request path (#5325): `ci.risk` in the
 * workspace declaration, read at the base the job measures the change from,
 * scored by `chant components pr-plan` and `pr-apply` over the change set the
 * gate binds. The record is `../change-risk.ts`'s: the report and the note
 * carry it as `risk`, the stored change set keeps it, and the policy reads
 * it as `input.risk`.
 *
 * Reading it at base means a change cannot raise its own `approveAbove`,
 * drop a question, or drop the score that would ask for an approval. Like
 * the cost estimate, a base that cannot be read while the checkout names
 * `ci.risk` stops the job.
 */

import { readDeclaration, WorkspaceReadError } from "../workspace/declaration";
import { locateWorkspace } from "../workspace/which-chant";
import { graphDependents, scoreChangeRisk, type ChangeRisk, type ChangeRiskSettings } from "../change-risk";
import { mapChangeSetToGraph } from "../change-set-graph";
import type { ChangeSetDocument } from "../change-set";
import type { GraphIdReader } from "../lifecycle/gate-change-set";
import type { PrMigrationFile } from "../pr-migrations";
import type { PolicyReview } from "./pr-policy";

/** `ci.risk` as read at base. */
export interface PrLoopRisk {
  /** Absent when the declaration at base sets none. */
  settings?: Omit<ChangeRiskSettings, "quorum">;
  base: string;
  /** A line for the log when no risk is scored because the base has no declaration. */
  note?: string;
}

function checkoutNamesRisk(cwd: string): boolean {
  try {
    return readDeclaration(locateWorkspace(cwd).tree).ci?.risk !== undefined;
  } catch {
    return false;
  }
}

/** The risk settings a pull-request job in `cwd` scores under, from the declaration at `base`. Throws when the base cannot be read and the checkout names one. */
export function prLoopRiskAt(cwd: string, base: string): PrLoopRisk {
  try {
    const settings = readDeclaration(locateWorkspace(cwd, base).tree).ci?.risk;
    return settings ? { base, settings } : { base };
  } catch (err) {
    const missing = err instanceof WorkspaceReadError && (err.code === "declaration-missing" || err.code === "not-a-git-repository");
    const why = err instanceof Error ? err.message : String(err);
    if (checkoutNamesRisk(cwd)) {
      if (missing) return { base, note: `ci.risk: the base ${base.slice(0, 12)} has no workspace declaration, so the risk this change declares is scored once it merges` };
      throw new Error(`ci.risk is read from the workspace declaration at ${base.slice(0, 12)}, and it could not be read (${why}), so the plan cannot be scored`);
    }
    return { base };
  }
}

/** The graph nodes that depend on what `doc` changes, from the graph `readGraph` reads in `cwd`, or why none were read. */
export async function prRiskDependents(doc: ChangeSetDocument, cwd: string, readGraph: GraphIdReader): Promise<{ dependents: string[] } | { error: string }> {
  try {
    const read = await readGraph(cwd);
    if ("error" in read) return { error: read.error };
    const mapped = mapChangeSetToGraph(doc, { member: null, at: null, ids: read.ids });
    return { dependents: graphDependents(mapped, read.edges ?? []) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Score a planned change set under `ci.risk` at base. Undefined when the base sets none. */
export function scorePrSet(
  read: PrLoopRisk,
  facts: { doc: ChangeSetDocument; env: string; review?: PolicyReview; migrations?: readonly PrMigrationFile[]; dependents?: readonly string[] },
): ChangeRisk | undefined {
  if (!read.settings) return undefined;
  const review = facts.review
    ? {
        risk: facts.review.risk,
        ...(facts.review.answers ? { answers: facts.review.answers } : {}),
        ...(facts.review.found ? {} : { unknownBecause: facts.review.reason ?? "no review was found" }),
      }
    : undefined;
  return scoreChangeRisk(
    {
      changeSet: facts.doc,
      environments: [facts.env],
      ...(facts.migrations?.length ? { migrations: facts.migrations } : {}),
      ...(facts.dependents ? { dependents: facts.dependents } : {}),
      ...(review ? { review } : {}),
    },
    read.settings,
  );
}
