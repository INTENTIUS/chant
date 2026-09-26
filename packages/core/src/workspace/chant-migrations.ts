/**
 * Migrations chant ships (#2737).
 *
 * A template's own migrations (./lineage-migrations.ts) move a scope between
 * two versions of that template. Some moves are chant's instead: a part a
 * template used goes away, and chant knows where each piece of it went. The
 * first is `chud-lexicon-exit`, which takes a repo made from chud's template
 * (or the studio kit's copy of it) off `@intentius/chant-lexicon-chud` and
 * `@intentius/chud-runtime` (ws-056).
 *
 * `chant workspace upgrade` asks each one for a plan after the template's own
 * chain has run in the staging worktree, and before the per-file merge. A
 * migration plans from what the scope holds, not from a version range, so it
 * works whatever ref the scope is pinned at. Its plan lists every file it
 * writes or deletes and why, what it cannot move and where that went, and any
 * conflict. A plan with a conflict is not applied at all, and the upgrade's
 * checks fail with it, so the dry run shows the whole plan and the tree is
 * never left half moved.
 *
 * An applied migration's id is added to the lineage's `migrations`, so the
 * lock records it and a second upgrade does not plan it again. A migration's
 * plan is also empty once nothing it moves is left, so running it twice
 * changes nothing either way.
 *
 * Files the migration rewrites keep their lineage entry: the lock's hash is
 * still the template's, so to a later upgrade they are the project's own
 * edits, merged per file like any other (ws-005). A deleted file keeps its
 * entry too, so a template version that still has it leaves it deleted.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Lineage } from "./lineage-lock";
import { chudLexiconExit } from "./chant-migrations/chud-lexicon-exit";
import { chudLexiconExitRollback } from "./chant-migrations/chud-lexicon-exit-rollback";

/** One file a plan writes or deletes, relative to the scope. */
export interface PlannedChange {
  path: string;
  action: "write" | "delete";
  /** Why, in a few words. */
  why: string;
  /** The new content, for a write. */
  data?: Buffer;
  /** True when the file had been edited since the template wrote it; the edit stays in git history. */
  edited?: boolean;
}

/** A part the migration does not move, and where it went instead. */
export interface NotMoved {
  what: string;
  where: string;
}

/** Why a plan cannot be applied. */
export interface PlanConflict {
  path: string;
  reason: string;
}

export interface ChantMigrationPlan {
  id: string;
  description: string;
  changes: PlannedChange[];
  notMoved: NotMoved[];
  conflicts: PlanConflict[];
}

export interface ChantMigrationContext {
  /** The scope directory (in the staging worktree). */
  dir: string;
  lineage: Lineage;
  /** The chant version doing the upgrade, for dependency ranges. */
  chantVersion: string;
}

export interface ChantMigration {
  id: string;
  description: string;
  /** The plan for this scope, or null when there is nothing here for this migration to move. */
  plan(ctx: ChantMigrationContext): ChantMigrationPlan | null;
}

/** Every migration chant ships, in the order they are planned. */
export const CHANT_MIGRATIONS: readonly ChantMigration[] = [chudLexiconExit, chudLexiconExitRollback];

/** The plans for a scope: each migration not yet in the lineage that finds something to move. */
export function planChantMigrations(ctx: ChantMigrationContext, migrations: readonly ChantMigration[] = CHANT_MIGRATIONS): ChantMigrationPlan[] {
  const applied = new Set(ctx.lineage.migrations);
  const plans: ChantMigrationPlan[] = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    const plan = m.plan(ctx);
    if (plan && (plan.changes.length > 0 || plan.conflicts.length > 0)) plans.push(plan);
  }
  return plans;
}

/**
 * Plan each migration in order and apply each plan with no conflict before
 * the next is planned, so a migration planned after another sees the tree
 * the earlier one left (#2800: `chud-lexicon-exit-rollback` after
 * `chud-lexicon-exit`). A plan with a conflict is not applied, and the ones
 * after it plan from the tree as it is.
 */
export function runChantMigrations(ctx: ChantMigrationContext, migrations: readonly ChantMigration[] = CHANT_MIGRATIONS): Array<{ plan: ChantMigrationPlan; applied: boolean }> {
  const out: Array<{ plan: ChantMigrationPlan; applied: boolean }> = [];
  for (const m of migrations) {
    if (ctx.lineage.migrations.includes(m.id)) continue;
    const plan = m.plan(ctx);
    if (!plan || (plan.changes.length === 0 && plan.conflicts.length === 0)) continue;
    const applied = plan.conflicts.length === 0;
    if (applied) applyChantMigration(plan, ctx.dir, ctx.lineage);
    out.push({ plan, applied });
  }
  return out;
}

/** Apply a plan with no conflicts, and record its id in the lineage. */
export function applyChantMigration(plan: ChantMigrationPlan, dir: string, lineage: Lineage): void {
  if (plan.conflicts.length > 0) throw new Error(`${plan.id} has conflicts and cannot be applied`);
  for (const c of plan.changes) {
    const abs = join(dir, c.path);
    if (c.action === "delete") {
      rmSync(abs, { force: true });
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, c.data!);
    }
  }
  if (!lineage.migrations.includes(plan.id)) lineage.migrations.push(plan.id);
}

/** A plan as the upgrade reports it: no file contents. */
export interface ChantMigrationReport {
  id: string;
  description: string;
  applied: boolean;
  changes: Array<Omit<PlannedChange, "data">>;
  notMoved: NotMoved[];
  conflicts: PlanConflict[];
}

export function reportPlan(plan: ChantMigrationPlan, applied: boolean): ChantMigrationReport {
  return {
    id: plan.id,
    description: plan.description,
    applied,
    changes: plan.changes.map(({ data: _d, ...rest }) => rest),
    notMoved: plan.notMoved,
    conflicts: plan.conflicts,
  };
}
